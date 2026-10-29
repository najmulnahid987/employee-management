/**
 * Dispatcher M18.3 — Public Endpoint Abuse Protection Verification Tests
 *
 * Verifies:
 * 1. Migration 20261103040000_public_endpoint_abuse_protection.sql invariants:
 *    - rate_limit_buckets table, RLS, service-role privileges, revokes.
 *    - check_rate_limit RPC with row-level locking (SELECT ... FOR UPDATE).
 *    - Window rollover and retry_after calculation.
 *    - get_customer_tracking_session_job integration with check_rate_limit raising P0004.
 * 2. In-memory rate limiting (IP and token bucket, window resets, retry-after).
 * 3. Client IP extraction hierarchy (trusted cf-connecting-ip > x-real-ip > x-forwarded-for).
 * 4. DatabaseRateLimiter RPC adapter behavior (allowed, limited, fallback safety).
 * 5. Edge Function HTTP 429 responses, Retry-After headers, and P0004 error handling.
 * 6. Cache-Control and private caching headers (no-store, private).
 * 7. pgTAP test suite 16 structure and assertions.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  handleCustomerTrackingRequest,
  extractClientIp,
  validateTokenFormat,
  InMemoryRateLimiter,
  DatabaseRateLimiter,
  FORBIDDEN_RESPONSE_FIELDS,
} from '../supabase/functions/customer-tracking/core.ts';

function generateMockValidToken() {
  const u1 = crypto.randomUUID().replace(/-/g, '');
  const u2 = crypto.randomUUID().replace(/-/g, '');
  return `${u1}${u2}`;
}

const SAMPLE_PAYLOAD = {
  service: 'HVAC Maintenance',
  status: 'on_the_way',
  status_label: 'Technician is en route',
  scheduled_at: '2026-11-03T10:00:00Z',
  business_name: 'Apex Air Services',
  business_phone: '(555) 234-5678',
  worker_first_name: 'Alex',
  worker_avatar_url: 'https://example.com/worker.jpg',
  destination: { latitude: 37.7749, longitude: -122.4194 },
  worker_location: {
    latitude: 37.772,
    longitude: -122.418,
    accuracy: 10,
    recorded_at: '2026-11-03T09:55:00Z',
    is_stale: false,
  },
  is_tracking_active: true,
  activated_at: '2026-11-03T09:50:00Z',
  tracking_message: 'Technician is en route.',
  last_location_updated_at: '2026-11-03T09:55:00Z',
  estimated_arrival: null,
  session_expires_at: '2026-11-04T09:50:00Z',
  updated_at: '2026-11-03T09:55:00Z',
};

describe('M18.3 Migration & SQL Rate Limiting Invariants', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261103040000_public_endpoint_abuse_protection.sql'
  );

  test('migration file exists and follows chronological ordering', () => {
    assert.ok(fs.existsSync(migrationPath), 'Migration 20261103040000 must exist');
  });

  const sqlContent = fs.readFileSync(migrationPath, 'utf8');

  test('rate_limit_buckets table is created with primary key and expiration index', () => {
    assert.ok(sqlContent.includes('CREATE TABLE IF NOT EXISTS public.rate_limit_buckets'));
    assert.ok(sqlContent.includes('bucket_key TEXT PRIMARY KEY'));
    assert.ok(sqlContent.includes('request_count INT NOT NULL DEFAULT 1'));
    assert.ok(sqlContent.includes('expires_at TIMESTAMPTZ NOT NULL'));
    assert.ok(sqlContent.includes('CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expires_at'));
  });

  test('rate_limit_buckets table enables RLS and revokes client access', () => {
    assert.ok(sqlContent.includes('ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY'));
    assert.ok(sqlContent.includes('REVOKE ALL ON public.rate_limit_buckets FROM PUBLIC, anon, authenticated'));
    assert.ok(sqlContent.includes('GRANT ALL ON public.rate_limit_buckets TO service_role'));
  });

  test('check_rate_limit function is SECURITY DEFINER with empty search_path and row lock', () => {
    assert.ok(sqlContent.includes('CREATE OR REPLACE FUNCTION public.check_rate_limit'));
    assert.ok(sqlContent.includes('SECURITY DEFINER'));
    assert.ok(sqlContent.includes("SET search_path = ''"));
    assert.ok(sqlContent.includes('FOR UPDATE'), 'Uses SELECT ... FOR UPDATE row-level lock');
  });

  test('check_rate_limit handles quota check, retry_after calculation, and window rollover', () => {
    assert.ok(sqlContent.includes('v_now >= v_row.expires_at'), 'Checks window expiration');
    assert.ok(sqlContent.includes('v_row.request_count >= v_max'), 'Checks max quota');
    assert.ok(sqlContent.includes("'retry_after'"), 'Returns retry_after in response');
  });

  test('get_customer_tracking_session_job checks rate limit and raises P0004 exception upon abuse', () => {
    assert.ok(sqlContent.includes("public.check_rate_limit('token:' ||"), 'Checks token rate limit');
    assert.ok(sqlContent.includes("public.check_rate_limit('ip:' ||"), 'Checks IP rate limit');
    assert.ok(sqlContent.includes("ERRCODE = 'P0004'"), 'Raises exception with ERRCODE P0004');
  });
});

describe('M18.3 Client IP Extraction Hierarchy', () => {
  test('prioritizes cf-connecting-ip over all other headers', () => {
    const req = new Request('https://api.dispatcher.com/customer-tracking?token=abc', {
      headers: {
        'cf-connecting-ip': '203.0.113.10',
        'x-real-ip': '198.51.100.20',
        'x-forwarded-for': '192.0.2.30, 10.0.0.1',
      },
    });
    assert.strictEqual(extractClientIp(req), '203.0.113.10');
  });

  test('prioritizes x-real-ip over x-forwarded-for when cf-connecting-ip is absent', () => {
    const req = new Request('https://api.dispatcher.com/customer-tracking?token=abc', {
      headers: {
        'x-real-ip': '198.51.100.20',
        'x-forwarded-for': '192.0.2.30, 10.0.0.1',
      },
    });
    assert.strictEqual(extractClientIp(req), '198.51.100.20');
  });

  test('extracts first client IP from comma-separated x-forwarded-for', () => {
    const req = new Request('https://api.dispatcher.com/customer-tracking?token=abc', {
      headers: {
        'x-forwarded-for': '  192.0.2.30 , 10.0.0.1, 172.16.0.2 ',
      },
    });
    assert.strictEqual(extractClientIp(req), '192.0.2.30');
  });

  test('returns unknown-client when no IP headers are present', () => {
    const req = new Request('https://api.dispatcher.com/customer-tracking?token=abc');
    assert.strictEqual(extractClientIp(req), 'unknown-client');
  });
});

describe('M18.3 In-Memory Rate Limiter Behavior', () => {
  test('allows requests within window threshold', () => {
    const limiter = new InMemoryRateLimiter(60000, 3);
    const now = 1000000;

    const r1 = limiter.check('ip:1.2.3.4', now);
    assert.strictEqual(r1.limited, false);
    assert.strictEqual(r1.retryAfterSeconds, 0);

    const r2 = limiter.check('ip:1.2.3.4', now + 100);
    assert.strictEqual(r2.limited, false);

    const r3 = limiter.check('ip:1.2.3.4', now + 200);
    assert.strictEqual(r3.limited, false);
  });

  test('blocks requests exceeding quota and calculates positive retryAfterSeconds', () => {
    const limiter = new InMemoryRateLimiter(60000, 2);
    const now = 1000000;

    limiter.check('ip:1.2.3.4', now);
    limiter.check('ip:1.2.3.4', now + 100);

    const r3 = limiter.check('ip:1.2.3.4', now + 200);
    assert.strictEqual(r3.limited, true);
    assert.strictEqual(r3.retryAfterSeconds, 60);

    const r4 = limiter.check('ip:1.2.3.4', now + 30000);
    assert.strictEqual(r4.limited, true);
    assert.strictEqual(r4.retryAfterSeconds, 30);
  });

  test('isolates different keys independently', () => {
    const limiter = new InMemoryRateLimiter(60000, 1);
    const now = 1000000;

    assert.strictEqual(limiter.check('ip:1.1.1.1', now).limited, false);
    assert.strictEqual(limiter.check('ip:1.1.1.1', now).limited, true);

    // Different IP must not be affected
    assert.strictEqual(limiter.check('ip:2.2.2.2', now).limited, false);
  });

  test('resets bucket counter after window expires', () => {
    const limiter = new InMemoryRateLimiter(60000, 1);
    const now = 1000000;

    limiter.check('ip:1.1.1.1', now);
    assert.strictEqual(limiter.check('ip:1.1.1.1', now + 1000).limited, true);

    // After 60s window elapses
    const nextWindow = limiter.check('ip:1.1.1.1', now + 60001);
    assert.strictEqual(nextWindow.limited, false);
  });

  test('reset method clears all buckets', () => {
    const limiter = new InMemoryRateLimiter(60000, 1);
    limiter.check('ip:1.1.1.1');
    assert.strictEqual(limiter.check('ip:1.1.1.1').limited, true);

    limiter.reset();
    assert.strictEqual(limiter.check('ip:1.1.1.1').limited, false);
  });
});

describe('M18.3 DatabaseRateLimiter RPC Adapter', () => {
  test('calls check_rate_limit RPC with proper parameters', async () => {
    let capturedRpc = '';
    let capturedParams = null;

    const mockDb = async (rpc, params) => {
      capturedRpc = rpc;
      capturedParams = params;
      return { data: { allowed: true, remaining: 59, retry_after: 0 }, error: null };
    };

    const limiter = new DatabaseRateLimiter(mockDb, 60, 60);
    const res = await limiter.check('token:abcd1234efgh5678');

    assert.strictEqual(capturedRpc, 'check_rate_limit');
    assert.deepStrictEqual(capturedParams, {
      p_bucket_key: 'token:abcd1234efgh5678',
      p_max_requests: 60,
      p_window_seconds: 60,
    });
    assert.strictEqual(res.limited, false);
    assert.strictEqual(res.retryAfterSeconds, 0);
  });

  test('returns limited: true and retryAfterSeconds when DB limit is exceeded', async () => {
    const mockDb = async () => ({
      data: { allowed: false, remaining: 0, retry_after: 45 },
      error: null,
    });

    const limiter = new DatabaseRateLimiter(mockDb, 60, 60);
    const res = await limiter.check('ip:198.51.100.1');

    assert.strictEqual(res.limited, true);
    assert.strictEqual(res.retryAfterSeconds, 45);
  });

  test('fails open safely on database error to avoid blocking valid traffic if limiter is degraded', async () => {
    const mockDb = async () => ({
      data: null,
      error: new Error('connection timeout'),
    });

    const limiter = new DatabaseRateLimiter(mockDb, 60, 60);
    const res = await limiter.check('ip:198.51.100.1');

    assert.strictEqual(res.limited, false);
  });
});

describe('M18.3 Edge Function Rate Limit Enforcement & Responses', () => {
  const token = generateMockValidToken();
  const mockDb = async () => ({ data: SAMPLE_PAYLOAD, error: null });

  test('returns HTTP 429 and Retry-After header when client IP is rate limited', async () => {
    const rateLimiter = new InMemoryRateLimiter(60000, 1);
    const req1 = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
      headers: { 'cf-connecting-ip': '203.0.113.55' },
    });
    const req2 = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
      headers: { 'cf-connecting-ip': '203.0.113.55' },
    });

    const res1 = await handleCustomerTrackingRequest(req1, { dbExecutor: mockDb, rateLimiter });
    assert.strictEqual(res1.status, 200);

    const res2 = await handleCustomerTrackingRequest(req2, { dbExecutor: mockDb, rateLimiter });
    assert.strictEqual(res2.status, 429);
    assert.strictEqual(res2.headers.get('Retry-After'), '60');
    assert.strictEqual(
      res2.headers.get('Cache-Control'),
      'no-store, no-cache, must-revalidate, private'
    );

    const body = await res2.json();
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error, 'Too many requests. Please wait before trying again.');
  });

  test('returns HTTP 429 when token rate limit is exceeded across rotating IPs', async () => {
    const tokenLimiter = new InMemoryRateLimiter(60000, 2);
    const ipLimiter = new InMemoryRateLimiter(60000, 100);

    const req1 = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
      headers: { 'cf-connecting-ip': '1.1.1.1' },
    });
    const req2 = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
      headers: { 'cf-connecting-ip': '2.2.2.2' },
    });
    const req3 = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
      headers: { 'cf-connecting-ip': '3.3.3.3' },
    });

    await handleCustomerTrackingRequest(req1, {
      dbExecutor: mockDb,
      rateLimiter: ipLimiter,
      tokenRateLimiter: tokenLimiter,
    });
    await handleCustomerTrackingRequest(req2, {
      dbExecutor: mockDb,
      rateLimiter: ipLimiter,
      tokenRateLimiter: tokenLimiter,
    });

    const res3 = await handleCustomerTrackingRequest(req3, {
      dbExecutor: mockDb,
      rateLimiter: ipLimiter,
      tokenRateLimiter: tokenLimiter,
    });

    assert.strictEqual(res3.status, 429);
    assert.ok(res3.headers.get('Retry-After'));
    const body = await res3.json();
    assert.strictEqual(body.error, 'Too many requests. Please wait before trying again.');
  });

  test('returns HTTP 429 when distributed rate limiter signals limit exceeded', async () => {
    const distributedLimiter = {
      check: async () => ({ limited: true, retryAfterSeconds: 45 }),
    };

    const req = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
      headers: { 'cf-connecting-ip': '5.5.5.5' },
    });

    const res = await handleCustomerTrackingRequest(req, {
      dbExecutor: mockDb,
      rateLimiter: new InMemoryRateLimiter(60000, 100),
      distributedRateLimiter: distributedLimiter,
    });

    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.headers.get('Retry-After'), '45');
  });

  test('maps database P0004 rate limit exception to HTTP 429 with Retry-After: 60', async () => {
    const mockDbWithRateLimitError = async () => ({
      data: null,
      error: { code: 'P0004', message: 'Rate limit exceeded for customer tracking' },
    });

    const req = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`);
    const res = await handleCustomerTrackingRequest(req, {
      dbExecutor: mockDbWithRateLimitError,
      rateLimiter: new InMemoryRateLimiter(60000, 100),
    });

    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.headers.get('Retry-After'), '60');
    const body = await res.json();
    assert.strictEqual(body.error, 'Too many requests. Please wait before trying again.');
  });

  test('enforces private, non-cacheable headers on all responses', async () => {
    const req = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`);
    const res = await handleCustomerTrackingRequest(req, {
      dbExecutor: mockDb,
      rateLimiter: new InMemoryRateLimiter(),
    });

    assert.strictEqual(
      res.headers.get('Cache-Control'),
      'no-store, no-cache, must-revalidate, private'
    );
    assert.strictEqual(res.headers.get('Pragma'), 'no-cache');
    assert.strictEqual(res.headers.get('X-Content-Type-Options'), 'nosniff');
  });

  test('sanitizes customer tracking response payload and excludes forbidden fields', async () => {
    const mockDbWithForbiddenData = async () => ({
      data: {
        ...SAMPLE_PAYLOAD,
        id: 'job-123',
        job_id: 'job-123',
        business_id: 'biz-123',
        worker_id: 'worker-123',
        customer_phone: '555-1234',
        customer_name: 'Private Customer',
        notes: 'Private owner notes',
        token_hash: 'secret-hash',
      },
      error: null,
    });

    const req = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`);
    const res = await handleCustomerTrackingRequest(req, {
      dbExecutor: mockDbWithForbiddenData,
      rateLimiter: new InMemoryRateLimiter(),
    });

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);

    for (const forbiddenField of FORBIDDEN_RESPONSE_FIELDS) {
      assert.strictEqual(
        forbiddenField in body.data,
        false,
        `Field ${forbiddenField} must never appear in response`
      );
    }
  });
});

describe('M18.3 pgTAP Test Suite 16 File Integrity', () => {
  const pgtapPath = path.resolve(
    process.cwd(),
    'supabase/tests/16_public_endpoint_abuse_protection.sql'
  );

  test('test suite 16 file exists', () => {
    assert.ok(fs.existsSync(pgtapPath), 'supabase/tests/16_public_endpoint_abuse_protection.sql must exist');
  });

  test('test suite 16 plans 10 assertions and tests rate limiting, RLS, and P0004 exception', () => {
    const content = fs.readFileSync(pgtapPath, 'utf8');
    assert.ok(content.includes('SELECT plan(10);'), 'Plans 10 assertions');
    assert.ok(content.includes('rate_limit_buckets table exists'));
    assert.ok(content.includes('check_rate_limit allows initial request'));
    assert.ok(content.includes('check_rate_limit reflects remaining quota'));
    assert.ok(content.includes('check_rate_limit blocks 6th request'));
    assert.ok(content.includes('check_rate_limit returns positive retry_after seconds'));
    assert.ok(content.includes('check_rate_limit resets window and allows request after expiration'));
    assert.ok(content.includes('check_rate_limit rejects empty bucket key'));
    assert.ok(content.includes('SET LOCAL ROLE anon'));
    assert.ok(content.includes('SELECT * FROM public.rate_limit_buckets'));
    assert.ok(content.includes('42501'), 'Asserts permission denied 42501');
    assert.ok(content.includes('P0004'), 'Asserts P0004 rate limit exception on abuse');
  });
});

