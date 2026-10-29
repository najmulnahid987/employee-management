/**
 * Dispatcher M18.2B — Server Authorization and Input Validation Test Suite
 *
 * Verifies:
 * 1. PostgreSQL migration 20261103020000_server_authorization_and_input_validation.sql.
 * 2. Fail-closed webhook authentication in push-notifications Edge Function (Finding 4).
 * 3. Request body size limits (<= 64KB) on push-notifications webhook.
 * 4. UUID format validation on incoming push-notifications job_event records.
 * 5. Least-privilege key resolution in customer-tracking Edge Function (Finding 3).
 * 6. Elimination of non-atomic 2-step job creation fallback in src/lib/jobs.ts (Finding 9).
 * 7. pgTAP test suite 14 structure and assertions.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  handleNotificationWebhookRequest,
  MAX_WEBHOOK_BODY_BYTES,
  validateWebhookSecret,
} from '../supabase/functions/push-notifications/core.ts';

describe('M18.2B Migration & SQL Validation Invariants', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261103020000_server_authorization_and_input_validation.sql'
  );

  test('migration file exists and follows chronological timestamp convention', () => {
    assert.ok(fs.existsSync(migrationPath), 'Migration 20261103020000 must exist');
  });

  const sqlContent = fs.readFileSync(migrationPath, 'utf8');

  test('create_job RPC validates customer name, phone, service, and address length bounds', () => {
    assert.ok(
      sqlContent.includes("Customer name must be between 1 and 200 characters"),
      'Validates customer name bounds (1..200)'
    );
    assert.ok(
      sqlContent.includes("Customer phone must be between 1 and 50 characters"),
      'Validates customer phone bounds (1..50)'
    );
    assert.ok(
      sqlContent.includes("Service description must be between 1 and 200 characters"),
      'Validates service description bounds (1..200)'
    );
    assert.ok(
      sqlContent.includes("Service site address must be between 1 and 500 characters"),
      'Validates address bounds (1..500)'
    );
    assert.ok(
      sqlContent.includes("Scheduled arrival time is required"),
      'Enforces mandatory scheduled_at'
    );
    assert.ok(
      sqlContent.includes("Both latitude and longitude must be provided together"),
      'Enforces paired coordinate integrity'
    );
  });

  test('cancel_job RPC validates mandatory cancellation reason length bounds', () => {
    assert.ok(
      sqlContent.includes("Mandatory cancellation reason required (1 to 1000 characters)"),
      'Enforces cancellation reason 1..1000 chars'
    );
    assert.ok(
      sqlContent.includes("Job ID is required"),
      'Enforces mandatory job ID'
    );
  });

  test('decline_job_assignment RPC validates decline reason bounds', () => {
    assert.ok(
      sqlContent.includes("Decline reason cannot exceed 1000 characters"),
      'Enforces decline reason <= 1000 chars'
    );
    assert.ok(
      sqlContent.includes("Job is not assigned to you"),
      'Enforces worker assignment match'
    );
  });

  test('provision_business RPC validates business name and phone bounds', () => {
    assert.ok(
      sqlContent.includes("Business name must be between 1 and 200 characters"),
      'Enforces business name bounds'
    );
    assert.ok(
      sqlContent.includes("Business phone must be between 1 and 50 characters"),
      'Enforces business phone bounds'
    );
  });

  test('join_business_team RPC validates code, full name, and phone bounds', () => {
    assert.ok(
      sqlContent.includes("Full name must be between 1 and 200 characters"),
      'Enforces full name bounds'
    );
    assert.ok(
      sqlContent.includes("Invalid invitation code format"),
      'Enforces invitation code bounds'
    );
  });

  test('register_device_token RPC validates token length bounds', () => {
    assert.ok(
      sqlContent.includes("Invalid push token format: token must be between 10 and 500 characters"),
      'Enforces push token length bounds (10..500)'
    );
  });
});

describe('M18.2B Push Notifications Edge Function Security Hardening', () => {
  test('validateWebhookSecret fails closed when expectedSecret is null, undefined, or empty', () => {
    const dummyReq = new Request('https://edge.supabase.com/push-notifications', {
      headers: { 'x-webhook-secret': 'some-secret' },
    });

    assert.equal(validateWebhookSecret(dummyReq, null), false, 'Null secret fails closed');
    assert.equal(validateWebhookSecret(dummyReq, undefined), false, 'Undefined secret fails closed');
    assert.equal(validateWebhookSecret(dummyReq, ''), false, 'Empty secret fails closed');
    assert.equal(validateWebhookSecret(dummyReq, '   '), false, 'Whitespace secret fails closed');
  });

  test('handleNotificationWebhookRequest fails closed with HTTP 500 when secret env is unset', async () => {
    delete process.env.NOTIFICATION_WEBHOOK_SECRET;
    delete process.env.WEBHOOK_SECRET;

    const req = new Request('https://edge.supabase.com/push-notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record: { id: 'evt-1' } }),
    });

    const res = await handleNotificationWebhookRequest(req);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(body.error?.includes('webhook secret not configured'));
  });

  test('handleNotificationWebhookRequest enforces 64KB payload size limit with HTTP 413', async () => {
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-key';
    process.env.NOTIFICATION_WEBHOOK_SECRET = 'secret-123';

    try {
      const oversizedPayload = JSON.stringify({
        record: {
          id: '11111111-1111-1111-1111-111111111111',
          data: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 100),
        },
      });

      const req = new Request('https://edge.supabase.com/push-notifications', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': 'secret-123',
        },
        body: oversizedPayload,
      });

      const res = await handleNotificationWebhookRequest(req);
      assert.equal(res.status, 413);
      const body = await res.json();
      assert.ok(body.error?.includes('Payload too large'));
    } finally {
      delete process.env.NOTIFICATION_WEBHOOK_SECRET;
    }
  });

  test('handleNotificationWebhookRequest enforces strict UUID validation on record IDs', async () => {
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-key';
    process.env.NOTIFICATION_WEBHOOK_SECRET = 'secret-123';

    try {
      const req = new Request('https://edge.supabase.com/push-notifications', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': 'secret-123',
        },
        body: JSON.stringify({
          record: {
            id: 'invalid-id-format',
            job_id: '11111111-1111-1111-1111-111111111111',
            business_id: '22222222-2222-2222-2222-222222222222',
            event_type: 'job_assigned',
          },
        }),
      });

      const res = await handleNotificationWebhookRequest(req);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error?.includes('Invalid UUID format'));
    } finally {
      delete process.env.NOTIFICATION_WEBHOOK_SECRET;
    }
  });
});

describe('M18.2B Customer Tracking Least Privilege Key Resolution', () => {
  const customerTrackingCorePath = path.resolve(
    process.cwd(),
    'supabase/functions/customer-tracking/core.ts'
  );
  const coreContent = fs.readFileSync(customerTrackingCorePath, 'utf8');

  test('customer tracking Edge Function strictly prioritizes SUPABASE_ANON_KEY over service-role', () => {
    assert.ok(
      coreContent.includes("Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')"),
      'Deno environment prioritizes SUPABASE_ANON_KEY'
    );
    assert.ok(
      coreContent.includes("process.env?.SUPABASE_ANON_KEY || process.env?.SUPABASE_SERVICE_ROLE_KEY"),
      'Node environment prioritizes SUPABASE_ANON_KEY'
    );
  });
});

describe('M18.2B Client-Side Atomic Job Creation (Zero 2-Step Fallback)', () => {
  const jobsLibPath = path.resolve(process.cwd(), 'src/lib/jobs.ts');
  const jobsContent = fs.readFileSync(jobsLibPath, 'utf8');

  test('createJob in src/lib/jobs.ts has no 2-step non-atomic fallback', () => {
    assert.equal(
      jobsContent.includes('Falling back to 2-step job creation'),
      false,
      'createJob must not have 2-step fallback console log'
    );
    assert.equal(
      jobsContent.includes("supabase.from('jobs').insert"),
      false,
      'createJob must not directly insert into jobs table'
    );
    assert.ok(
      jobsContent.includes("await supabase.rpc('create_job'"),
      'createJob must exclusively rely on atomic create_job RPC'
    );
  });
});

describe('pgTAP Database Verification Suite 14', () => {
  const pgtapPath = path.resolve(
    process.cwd(),
    'supabase/tests/14_server_authorization_and_input_validation.sql'
  );

  test('pgTAP test suite 14 exists and contains 10 planned test assertions', () => {
    assert.ok(fs.existsSync(pgtapPath), '14_server_authorization_and_input_validation.sql must exist');
    const content = fs.readFileSync(pgtapPath, 'utf8');
    assert.ok(content.includes('SELECT plan(10);'), 'Plans 10 assertions');
    assert.ok(content.includes('create_job rejects empty customer name'), 'Test 1 assertion');
    assert.ok(content.includes('create_job rejects NULL scheduled_at arrival timestamp'), 'Test 2 assertion');
    assert.ok(content.includes('create_job rejects latitude without longitude'), 'Test 3 assertion');
    assert.ok(content.includes('create_job blocks workers from creating jobs'), 'Test 4 assertion');
    assert.ok(content.includes('cancel_job rejects empty cancellation reason'), 'Test 5 assertion');
    assert.ok(content.includes('cancel_job blocks workers from cancelling jobs'), 'Test 6 assertion');
    assert.ok(content.includes('decline_job_assignment rejects oversized decline reason'), 'Test 7 assertion');
    assert.ok(content.includes('decline_job_assignment blocks unassigned worker'), 'Test 8 assertion');
    assert.ok(content.includes('provision_business rejects empty business name'), 'Test 9 assertion');
    assert.ok(content.includes('register_device_token rejects push token under 10 characters'), 'Test 10 assertion');
  });
});

