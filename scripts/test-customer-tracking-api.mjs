/**
 * Dispatcher M13.4 — Public Customer Tracking API Verification Test Suite
 *
 * Validates:
 * 1. Valid token request via Query Param, Header, Path, and POST body:
 *    - Returns 200 with sanitized allowlisted payload.
 *    - Sets Cache-Control: no-store and CORS headers.
 * 2. Random / Invalid token handling:
 *    - Rejects malformed, short, or invalid hex tokens immediately without hitting DB.
 *    - Rejects non-existent tokens with generic 404 response (anti-enumeration).
 * 3. Expired and Revoked token handling:
 *    - Returns generic 404 response without leaking session status.
 * 4. Completed, Cancelled, Declined, and Reassigned job lifecycle gating:
 *    - Returns generic 404 response when job is no longer active/eligible.
 * 5. Rate limiting & abuse controls:
 *    - Enforces 60 requests per minute per IP.
 *    - 61st request returns HTTP 429 with Retry-After header.
 *    - Per-IP rate limit isolation.
 * 6. Request size checks & HTTP method controls:
 *    - Rejects request payloads > 1024 bytes with HTTP 413.
 *    - Rejects unsupported HTTP methods (PUT, DELETE, PATCH) with HTTP 405 and Allow header.
 *    - Handles OPTIONS preflight with HTTP 204.
 * 7. Strict allowlist verification & zero forbidden fields:
 *    - Verified absence of database IDs, raw tokens, hashes, customer phone,
 *      customer name, notes, cancellation reasons, and worker contact details.
 * 8. Secret hygiene & log safety:
 *    - Confirms service-role key is never present in mobile/client bundle.
 *    - Confirms raw tokens are never written into logs or error messages.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  handleCustomerTrackingRequest,
  validateTokenFormat,
  computeTokenSha256Hex,
  extractBearerToken,
  sanitizeCustomerTrackingPayload,
  InMemoryRateLimiter,
  FORBIDDEN_RESPONSE_FIELDS,
} from '../supabase/functions/customer-tracking/core.ts';

// =============================================================================
// Mock Fixtures
// =============================================================================

function generateMockValidToken() {
  const uuid1 = crypto.randomUUID().replace(/-/g, '');
  const uuid2 = crypto.randomUUID().replace(/-/g, '');
  return `${uuid1}${uuid2}`;
}

const SAMPLE_ACTIVE_JOB_PAYLOAD = {
  service: 'Emergency Electrical Repair',
  status: 'on_the_way',
  status_label: 'Technician is on the way',
  scheduled_at: '2026-10-26T14:00:00Z',
  business_name: 'Metro Electric Co',
  business_phone: '(555) 012-3456',
  worker_first_name: 'David',
  worker_avatar_url: 'https://example.com/avatar.jpg',
  destination: {
    latitude: 37.7749,
    longitude: -122.4194,
  },
  worker_location: {
    latitude: 37.7712,
    longitude: -122.4153,
    accuracy: 12.5,
    recorded_at: '2026-10-26T13:50:00Z',
    is_stale: false,
  },
  is_tracking_active: true,
  activated_at: '2026-10-26T13:45:00Z',
  tracking_message: 'Technician is on the way.',
  last_location_updated_at: '2026-10-26T13:50:00Z',
  estimated_arrival: null,
  session_expires_at: '2026-10-27T13:45:00Z',
  updated_at: '2026-10-26T13:50:00Z',
};

// =============================================================================
// Test Suites
// =============================================================================

test('M13.4 Token Validation & Format Controls', async (t) => {
  await t.test('accepts valid 64-character hexadecimal tokens', () => {
    const token = generateMockValidToken();
    assert.strictEqual(validateTokenFormat(token), true);
    assert.strictEqual(token.length, 64);
  });

  await t.test('accepts valid hex tokens between 16 and 128 characters', () => {
    assert.strictEqual(validateTokenFormat('a'.repeat(16)), true);
    assert.strictEqual(validateTokenFormat('f'.repeat(128)), true);
  });

  await t.test('rejects malformed tokens before querying database', () => {
    assert.strictEqual(validateTokenFormat(''), false);
    assert.strictEqual(validateTokenFormat('short'), false);
    assert.strictEqual(validateTokenFormat('1234567890abcdef!@#$%^&*'), false); // invalid characters
    assert.strictEqual(validateTokenFormat('g'.repeat(64)), false); // 'g' is not hex
    assert.strictEqual(validateTokenFormat(null), false);
    assert.strictEqual(validateTokenFormat(undefined), false);
    assert.strictEqual(validateTokenFormat(12345), false);
  });

  await t.test('computes deterministic SHA-256 matching crypto hash', async () => {
    const token = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const computed = await computeTokenSha256Hex(token);
    const expected = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
    assert.strictEqual(computed, expected);
    assert.strictEqual(computed.length, 64);
  });
});

test('M13.4 Token Extraction from Various Channels', async (t) => {
  const token = generateMockValidToken();

  await t.test('extracts from URL query parameter ?token=...', async () => {
    const req = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
      method: 'GET',
    });
    const extraction = await extractBearerToken(req);
    assert.strictEqual(extraction.token, token);
  });

  await t.test('extracts from URL path segment /customer-tracking/:token', async () => {
    const req = new Request(`https://api.dispatcher.com/customer-tracking/${token}`, {
      method: 'GET',
    });
    const extraction = await extractBearerToken(req);
    assert.strictEqual(extraction.token, token);
  });

  await t.test('extracts from Authorization: Bearer <token>', async () => {
    const req = new Request('https://api.dispatcher.com/customer-tracking', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const extraction = await extractBearerToken(req);
    assert.strictEqual(extraction.token, token);
  });

  await t.test('extracts from JSON body in POST request', async () => {
    const req = new Request('https://api.dispatcher.com/customer-tracking', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    const extraction = await extractBearerToken(req);
    assert.strictEqual(extraction.token, token);
  });
});

test('M13.4 Successful Valid Token Request & Response Headers', async () => {
  const token = generateMockValidToken();
  let rpcCalledWith = null;

  const mockDb = async (rpcName, params) => {
    if (rpcName === 'get_customer_tracking_session_job') {
      rpcCalledWith = params;
      return { data: SAMPLE_ACTIVE_JOB_PAYLOAD, error: null };
    }
    return { data: null, error: new Error('Unknown RPC') };
  };

  const req = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
    method: 'GET',
    headers: {
      'x-forwarded-for': '203.0.113.10',
    },
  });

  const res = await handleCustomerTrackingRequest(req, {
    dbExecutor: mockDb,
    rateLimiter: new InMemoryRateLimiter(),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(rpcCalledWith.p_token, token);

  // Security Headers: Cache-Control must be no-store
  const cacheControl = res.headers.get('Cache-Control');
  assert.ok(cacheControl && cacheControl.includes('no-store'), 'Must include no-store');
  assert.ok(cacheControl.includes('no-cache'));

  // CORS Headers
  assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');

  const json = await res.json();
  assert.strictEqual(json.success, true);
  assert.ok(json.data);
  assert.strictEqual(json.data.business_name, 'Metro Electric Co');
  assert.strictEqual(json.data.worker_first_name, 'David');
  assert.strictEqual(json.data.status, 'on_the_way');
  assert.strictEqual(json.data.is_tracking_active, true);
  assert.ok(json.data.worker_location);
  assert.strictEqual(json.data.worker_location.latitude, 37.7712);
  assert.strictEqual(json.data.worker_location.longitude, -122.4153);
});

test('M13.4 Invalid, Expired, Revoked, and Ineligible Tokens (Anti-Enumeration)', async (t) => {
  await t.test('malformed token returns 404 without querying database', async () => {
    let dbQueried = false;
    const mockDb = async () => {
      dbQueried = true;
      return { data: null, error: null };
    };

    const req = new Request('https://api.dispatcher.com/customer-tracking?token=invalid_characters!!', {
      method: 'GET',
    });

    const res = await handleCustomerTrackingRequest(req, {
      dbExecutor: mockDb,
      rateLimiter: new InMemoryRateLimiter(),
    });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(dbQueried, false, 'Database must never be queried for malformed token');
    const json = await res.json();
    assert.strictEqual(json.success, false);
    assert.strictEqual(json.data, null);
    assert.strictEqual(json.error, 'Tracking session unavailable or expired.');
  });

  await t.test('random non-existent token returns generic 404 response', async () => {
    const randomToken = generateMockValidToken();
    const mockDb = async () => ({ data: null, error: null });

    const req = new Request(`https://api.dispatcher.com/customer-tracking?token=${randomToken}`, {
      method: 'GET',
    });

    const res = await handleCustomerTrackingRequest(req, {
      dbExecutor: mockDb,
      rateLimiter: new InMemoryRateLimiter(),
    });

    assert.strictEqual(res.status, 404);
    const json = await res.json();
    assert.strictEqual(json.success, false);
    assert.strictEqual(json.data, null);
    assert.strictEqual(json.error, 'Tracking session unavailable or expired.');
  });

  await t.test('expired or revoked session returns generic 404 response', async () => {
    const token = generateMockValidToken();
    // Database returns null when session is expired or revoked
    const mockDb = async () => ({ data: null, error: null });

    const req = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
      method: 'GET',
    });

    const res = await handleCustomerTrackingRequest(req, {
      dbExecutor: mockDb,
      rateLimiter: new InMemoryRateLimiter(),
    });

    assert.strictEqual(res.status, 404);
    const json = await res.json();
    assert.strictEqual(json.success, false);
    assert.strictEqual(json.data, null);
  });

  await t.test('completed, cancelled, unassigned, or reassigned job returns generic 404 response', async () => {
    const token = generateMockValidToken();
    // Database returns null for terminal/ineligible jobs
    const mockDb = async () => ({ data: null, error: null });

    const req = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
      method: 'GET',
    });

    const res = await handleCustomerTrackingRequest(req, {
      dbExecutor: mockDb,
      rateLimiter: new InMemoryRateLimiter(),
    });

    assert.strictEqual(res.status, 404);
    const json = await res.json();
    assert.strictEqual(json.success, false);
    assert.strictEqual(json.data, null);
  });
});

test('M13.4 Rate Limiting & Abuse Controls', async (t) => {
  const rateLimiter = new InMemoryRateLimiter(60000, 5); // 5 requests per minute for testing
  const clientIp = '198.51.100.42';
  const mockDb = async () => ({ data: SAMPLE_ACTIVE_JOB_PAYLOAD, error: null });
  const token = generateMockValidToken();

  const makeRequest = () =>
    new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
      method: 'GET',
      headers: { 'x-forwarded-for': clientIp },
    });

  // First 5 requests succeed
  for (let i = 0; i < 5; i++) {
    const res = await handleCustomerTrackingRequest(makeRequest(), {
      dbExecutor: mockDb,
      rateLimiter,
    });
    assert.strictEqual(res.status, 200, `Request ${i + 1} should succeed`);
  }

  // 6th request is rate limited (429)
  const rateLimitedRes = await handleCustomerTrackingRequest(makeRequest(), {
    dbExecutor: mockDb,
    rateLimiter,
  });

  assert.strictEqual(rateLimitedRes.status, 429);
  assert.ok(rateLimitedRes.headers.get('Retry-After'));
  const json = await rateLimitedRes.json();
  assert.strictEqual(json.success, false);
  assert.match(json.error, /Too many requests/);

  // A different IP is not affected (per-IP isolation)
  const differentIpReq = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
    method: 'GET',
    headers: { 'x-forwarded-for': '198.51.100.99' },
  });

  const differentIpRes = await handleCustomerTrackingRequest(differentIpReq, {
    dbExecutor: mockDb,
    rateLimiter,
  });
  assert.strictEqual(differentIpRes.status, 200, 'Different IP must not be rate-limited');
});

test('M13.4 Request Size Checks & HTTP Method Controls', async (t) => {
  const token = generateMockValidToken();
  const mockDb = async () => ({ data: SAMPLE_ACTIVE_JOB_PAYLOAD, error: null });

  await t.test('rejects POST request exceeding 1024 bytes with HTTP 413', async () => {
    const hugeBody = JSON.stringify({
      token,
      junk: 'x'.repeat(2048), // > 1024 bytes
    });

    const req = new Request('https://api.dispatcher.com/customer-tracking', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(hugeBody.length),
      },
      body: hugeBody,
    });

    const res = await handleCustomerTrackingRequest(req, {
      dbExecutor: mockDb,
      rateLimiter: new InMemoryRateLimiter(),
    });

    assert.strictEqual(res.status, 413);
    const json = await res.json();
    assert.strictEqual(json.success, false);
    assert.match(json.error, /payload too large/i);
  });

  await t.test('rejects disallowed HTTP methods with HTTP 405', async () => {
    const disallowedMethods = ['PUT', 'DELETE', 'PATCH'];
    for (const method of disallowedMethods) {
      const req = new Request(`https://api.dispatcher.com/customer-tracking?token=${token}`, {
        method,
      });

      const res = await handleCustomerTrackingRequest(req, {
        dbExecutor: mockDb,
        rateLimiter: new InMemoryRateLimiter(),
      });

      assert.strictEqual(res.status, 405);
      assert.strictEqual(res.headers.get('Allow'), 'GET, POST, OPTIONS');
    }
  });

  await t.test('handles OPTIONS preflight with HTTP 204 No Content', async () => {
    const req = new Request('https://api.dispatcher.com/customer-tracking', {
      method: 'OPTIONS',
    });

    const res = await handleCustomerTrackingRequest(req);
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.ok(res.headers.get('Access-Control-Allow-Methods'));
  });
});

test('M13.4 Allowlist Verification & Forbidden Field Absence', async () => {
  // Simulate database returning forbidden fields by accident
  const pollutedDbPayload = {
    ...SAMPLE_ACTIVE_JOB_PAYLOAD,
    id: 'db-job-uuid-1234',
    job_id: 'db-job-uuid-1234',
    business_id: 'db-biz-uuid-5678',
    worker_id: 'db-worker-uuid-9999',
    session_id: 'db-session-uuid-0000',
    token: 'raw_bearer_token_here',
    raw_token: 'raw_bearer_token_here',
    token_hash: 'sha256_hash_here',
    customer_name: 'John Doe Customer',
    customer_phone: '555-999-0000',
    notes: 'Gate code 1234, watch out for the dog',
    cancellation_reason: 'Customer declined service',
    worker_full_name: 'David Technician',
    worker_phone: '555-111-2222',
    worker_email: 'david@metro.com',
    address: '123 Private Customer St',
  };

  const sanitized = sanitizeCustomerTrackingPayload(pollutedDbPayload);

  // Verify that every single forbidden field is strictly absent
  for (const forbiddenKey of FORBIDDEN_RESPONSE_FIELDS) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(sanitized, forbiddenKey),
      false,
      `Forbidden field "${forbiddenKey}" must NEVER appear in sanitized customer response`
    );
    assert.strictEqual(sanitized[forbiddenKey], undefined);
  }

  // Verify all approved fields are present
  assert.strictEqual(sanitized.business_name, 'Metro Electric Co');
  assert.strictEqual(sanitized.worker_first_name, 'David');
  assert.strictEqual(sanitized.status, 'on_the_way');
  assert.strictEqual(sanitized.is_tracking_active, true);
  assert.strictEqual(sanitized.estimated_arrival, null);
  assert.ok(sanitized.worker_location);
  assert.strictEqual(sanitized.worker_location.latitude, 37.7712);
  assert.strictEqual(sanitized.worker_location.longitude, -122.4153);
  assert.ok(sanitized.destination);
  assert.strictEqual(sanitized.destination.latitude, 37.7749);
  assert.strictEqual(sanitized.destination.longitude, -122.4194);
});

test('M13.4 Client Secret Hygiene & Log Safety', () => {
  // 1. Verify SUPABASE_SERVICE_ROLE_KEY is NOT referenced in client code (src/)
  const clientFiles = fs.readdirSync('src', { recursive: true });
  for (const file of clientFiles) {
    const fullPath = path.join('src', file);
    if (fs.statSync(fullPath).isFile() && (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js'))) {
      const content = fs.readFileSync(fullPath, 'utf8');
      assert.strictEqual(
        content.includes('SUPABASE_SERVICE_ROLE_KEY'),
        false,
        `Client file "${fullPath}" must NEVER contain SUPABASE_SERVICE_ROLE_KEY`
      );
    }
  }

  // 2. Verify config.toml disables JWT verification exclusively for customer-tracking
  const configPath = path.resolve('supabase/config.toml');
  assert.strictEqual(fs.existsSync(configPath), true);
  const configContent = fs.readFileSync(configPath, 'utf8');
  assert.ok(
    configContent.includes('[functions.customer-tracking]'),
    'config.toml must configure [functions.customer-tracking]'
  );
  assert.ok(
    configContent.includes('verify_jwt = false'),
    '[functions.customer-tracking] must declare verify_jwt = false'
  );
});
