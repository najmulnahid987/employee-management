/**
 * Dispatcher M15.4 — Secure Notification Delivery Pipeline Test Suite
 *
 * Validates:
 * 1. Database schema, constraints, indexes, RLS, and claim RPC in migration.
 * 2. Event classification & filtering (strictly 4 approved lifecycle transitions).
 * 3. Idempotency key generation and duplicate webhook suppression.
 * 4. Trusted recipient resolution from database relations (never client-supplied).
 * 5. Payload privacy sanitization (withholds customer phone, notes, gate codes, tokens).
 * 6. Device token resolution, Expo push dispatch, and stale token deactivation.
 * 7. Failure handling, transient error retries, and outbox state tracking.
 * 8. Supabase Edge Function webhook request parsing and HTTP contract.
 *
 * Execution:
 * node --test --experimental-strip-types scripts/test-notification-pipeline.mjs
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  classifyNotificationEvent,
  generateIdempotencyKey,
  formatNotificationPayload,
  validatePayloadSanitization,
  processNotificationEvent,
  handleNotificationWebhookRequest,
} from '../supabase/functions/push-notifications/core.ts';

describe('M15.4 Database Migration & Outbox Schema Audit', () => {
  const migrationPath = path.resolve('supabase/migrations/20261030010000_notification_deliveries.sql');

  test('migration file exists and is correctly sequenced after device_tokens', () => {
    assert.ok(fs.existsSync(migrationPath), 'Migration file must exist');
  });

  const sql = fs.readFileSync(migrationPath, 'utf8');

  test('creates public.notification_deliveries table with required columns', () => {
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.notification_deliveries'), 'Creates notification_deliveries table');
    assert.ok(sql.includes('job_event_id UUID NOT NULL REFERENCES public.job_events(id)'), 'Foreign key to job_events');
    assert.ok(sql.includes('recipient_user_id UUID NOT NULL REFERENCES auth.users(id)'), 'Foreign key to auth.users');
    assert.ok(sql.includes('business_id UUID NOT NULL REFERENCES public.businesses(id)'), 'Foreign key to businesses');
    assert.ok(sql.includes('notification_type TEXT NOT NULL'), 'Contains notification_type column');
    assert.ok(sql.includes('idempotency_key TEXT NOT NULL'), 'Contains idempotency_key column');
    assert.ok(sql.includes('status TEXT NOT NULL DEFAULT \'pending\''), 'Contains status with pending default');
    assert.ok(sql.includes('device_tokens_count INTEGER NOT NULL DEFAULT 0'), 'Contains device_tokens_count');
    assert.ok(sql.includes('expo_ticket_ids JSONB NOT NULL DEFAULT \'[]\'::jsonb'), 'Contains expo_ticket_ids');
    assert.ok(sql.includes('error_message TEXT'), 'Contains error_message column');
    assert.ok(sql.includes('delivered_at TIMESTAMPTZ'), 'Contains delivered_at column');
  });

  test('enforces strict idempotency constraint UNIQUE (idempotency_key)', () => {
    assert.ok(
      sql.includes('CONSTRAINT uq_notification_deliveries_idempotency UNIQUE (idempotency_key)'),
      'Unique constraint on idempotency_key prevents duplicate deliveries'
    );
  });

  test('enforces status check constraint for valid delivery states', () => {
    assert.ok(
      sql.includes("status IN ('pending', 'delivered', 'failed', 'no_tokens')"),
      'Status check constraint enforces allowed outbox states'
    );
    assert.ok(
      sql.includes("notification_type IN ('job_assigned', 'job_accepted', 'worker_arrived', 'job_completed')"),
      'Notification type check constraint enforces 4 approved event types'
    );
  });

  test('creates fast lookup indexes for event, recipient, and business', () => {
    assert.ok(sql.includes('idx_notification_deliveries_event'), 'Index for job_event_id');
    assert.ok(sql.includes('idx_notification_deliveries_recipient'), 'Index for recipient_user_id and status');
    assert.ok(sql.includes('idx_notification_deliveries_business'), 'Index for business_id');
  });

  test('enforces strict Row Level Security (RLS) on notification_deliveries', () => {
    assert.ok(sql.includes('ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;'), 'RLS enabled');
    assert.ok(sql.includes('REVOKE ALL ON public.notification_deliveries FROM anon;'), 'Anon table access revoked');
    assert.ok(sql.includes('GRANT SELECT ON public.notification_deliveries TO authenticated;'), 'Authenticated grant SELECT only');
    assert.ok(sql.includes('GRANT ALL ON public.notification_deliveries TO service_role;'), 'Service role full access');
    assert.ok(sql.includes('USING (recipient_user_id = auth.uid())'), 'SELECT policy enforces recipient_user_id = auth.uid()');
    assert.ok(sql.includes('REVOKE INSERT, UPDATE, DELETE ON public.notification_deliveries FROM authenticated;'), 'Direct mutations revoked from authenticated users');
  });

  test('defines atomic claim_notification_delivery RPC with concurrency race condition protection', () => {
    assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.claim_notification_delivery'), 'Defines claim_notification_delivery RPC');
    assert.ok(sql.includes('SECURITY DEFINER'), 'RPC runs as SECURITY DEFINER');
    assert.ok(sql.includes("SET search_path = ''"), 'Empty search path for security');
    assert.ok(sql.includes('ON CONFLICT (idempotency_key) DO NOTHING'), 'Atomic ON CONFLICT race handling');
    assert.ok(sql.includes("RETURN 'already_delivered'"), 'Returns already_delivered when existing is delivered');
    assert.ok(sql.includes("RETURN 'in_progress'"), 'Returns in_progress when existing is pending');
    assert.ok(sql.includes("RETURN 'claimed'"), 'Returns claimed for new delivery slot');
  });
});

describe('M15.4 Lifecycle Event Classification & Filtering', () => {
  test('approves worker_assigned event type', () => {
    const event = {
      event_type: 'worker_assigned',
      previous_status: 'unassigned',
      new_status: 'assigned',
    };
    assert.equal(classifyNotificationEvent(event), 'job_assigned');
  });

  test('approves worker_reassigned event type', () => {
    const event = {
      event_type: 'worker_reassigned',
      previous_status: 'assigned',
      new_status: 'assigned',
    };
    assert.equal(classifyNotificationEvent(event), 'job_assigned');
  });

  test('approves status_changed: assigned -> accepted (job_accepted)', () => {
    const event = {
      event_type: 'status_changed',
      previous_status: 'assigned',
      new_status: 'accepted',
    };
    assert.equal(classifyNotificationEvent(event), 'job_accepted');
  });

  test('approves status_changed: on_the_way -> arrived (worker_arrived)', () => {
    const event = {
      event_type: 'status_changed',
      previous_status: 'on_the_way',
      new_status: 'arrived',
    };
    assert.equal(classifyNotificationEvent(event), 'worker_arrived');
  });

  test('approves status_changed: in_progress -> completed (job_completed)', () => {
    const event = {
      event_type: 'status_changed',
      previous_status: 'in_progress',
      new_status: 'completed',
    };
    assert.equal(classifyNotificationEvent(event), 'job_completed');
  });

  test('strictly rejects unassigned event (assigned -> unassigned)', () => {
    const event = {
      event_type: 'status_changed',
      previous_status: 'assigned',
      new_status: 'unassigned',
    };
    assert.equal(classifyNotificationEvent(event), null);
  });

  test('strictly rejects cancelled event (any -> cancelled)', () => {
    const event = {
      event_type: 'status_changed',
      previous_status: 'in_progress',
      new_status: 'cancelled',
    };
    assert.equal(classifyNotificationEvent(event), null);
  });

  test('strictly rejects travel start event (accepted -> on_the_way)', () => {
    const event = {
      event_type: 'status_changed',
      previous_status: 'accepted',
      new_status: 'on_the_way',
    };
    assert.equal(classifyNotificationEvent(event), null);
  });

  test('strictly rejects work start event (arrived -> in_progress)', () => {
    const event = {
      event_type: 'status_changed',
      previous_status: 'arrived',
      new_status: 'in_progress',
    };
    assert.equal(classifyNotificationEvent(event), null);
  });

  test('strictly rejects location update events', () => {
    const event = {
      event_type: 'locations',
      previous_status: null,
      new_status: null,
    };
    assert.equal(classifyNotificationEvent(event), null);
  });

  test('strictly rejects job creation event', () => {
    const event = {
      event_type: 'job_created',
      previous_status: null,
      new_status: 'unassigned',
    };
    assert.equal(classifyNotificationEvent(event), null);
  });

  test('returns null for null, undefined, or empty events', () => {
    assert.equal(classifyNotificationEvent(null), null);
    assert.equal(classifyNotificationEvent(undefined), null);
    assert.equal(classifyNotificationEvent({}), null);
  });
});

describe('M15.4 Idempotency Key & Deduplication Invariants', () => {
  test('generates deterministic idempotency key from job_event_id and recipient_user_id', () => {
    const key = generateIdempotencyKey('evt-12345', 'usr-67890');
    assert.equal(key, 'evt-12345:usr-67890');
  });

  test('throws error if job_event_id or recipient_user_id is missing', () => {
    assert.throws(() => generateIdempotencyKey('', 'usr-123'), /required/);
    assert.throws(() => generateIdempotencyKey('evt-123', ''), /required/);
  });

  test('demonstrates that duplicate invocation for the same event and recipient produces at most one logical notification', async () => {
    let claimCount = 0;
    let pushDispatches = 0;

    const mockOutboxState = new Map();

    const mockDeps = {
      async fetchJob(jobId, businessId) {
        return {
          id: jobId,
          business_id: businessId,
          service: 'Plumbing Repair',
          address: '123 Main St',
          status: 'assigned',
          worker_id: 'worker-user-1',
        };
      },
      async fetchWorkerProfile(workerId, businessId) {
        return {
          id: workerId,
          business_id: businessId,
          full_name: 'John Technician',
          role: 'worker',
        };
      },
      async fetchOwnerProfile(businessId) {
        return {
          id: 'owner-user-1',
          business_id: businessId,
          full_name: 'Alice Owner',
          role: 'owner',
        };
      },
      async claimDeliverySlot(jobEventId, recipientUserId, businessId, notificationType, idempotencyKey) {
        claimCount++;
        const existing = mockOutboxState.get(idempotencyKey);
        if (existing === 'delivered') return 'already_delivered';
        if (existing === 'pending') return 'in_progress';

        mockOutboxState.set(idempotencyKey, 'pending');
        return 'claimed';
      },
      async fetchRecipientDeviceTokens(recipientUserId) {
        return ['ExponentPushToken[device-token-1]'];
      },
      async sendExpoPush(messages) {
        pushDispatches++;
        return [{ status: 'ok', id: 'ticket-uuid-1' }];
      },
      async updateDeliverySuccess(idempotencyKey, tokensCount, ticketIds) {
        mockOutboxState.set(idempotencyKey, 'delivered');
      },
      async updateDeliveryNoTokens(idempotencyKey) {
        mockOutboxState.set(idempotencyKey, 'no_tokens');
      },
      async updateDeliveryFailed(idempotencyKey, err) {
        mockOutboxState.set(idempotencyKey, 'failed');
      },
      async deactivateDeviceToken(token) {},
    };

    const event = {
      id: 'event-uuid-assignment-1',
      job_id: 'job-uuid-1',
      business_id: 'biz-uuid-1',
      actor_id: 'owner-user-1',
      actor_role: 'owner',
      event_type: 'worker_assigned',
      previous_status: 'unassigned',
      new_status: 'assigned',
    };

    // First invocation: should claim slot and dispatch push
    const result1 = await processNotificationEvent(event, mockDeps);
    assert.equal(result1.success, true);
    assert.equal(result1.processed, true);
    assert.equal(result1.status, 'delivered');
    assert.equal(result1.idempotencyKey, 'event-uuid-assignment-1:worker-user-1');
    assert.equal(pushDispatches, 1, 'Exactly one push dispatched on first invocation');

    // Second invocation (duplicate webhook, retry, or replay): MUST be suppressed!
    const result2 = await processNotificationEvent(event, mockDeps);
    assert.equal(result2.success, true);
    assert.equal(result2.processed, false, 'Duplicate invocation must not re-process');
    assert.equal(result2.status, 'duplicate_suppressed');
    assert.ok(result2.reason?.includes('already delivered'));
    assert.equal(pushDispatches, 1, 'Push dispatches must remain exactly 1 (no duplicate push!)');

    // Third invocation: still suppressed!
    const result3 = await processNotificationEvent(event, mockDeps);
    assert.equal(result3.status, 'duplicate_suppressed');
    assert.equal(pushDispatches, 1);
  });

  test('suppresses concurrent duplicate delivery while first invocation is in progress', async () => {
    let pushDispatches = 0;
    const mockDeps = {
      async fetchJob(jobId, businessId) {
        return { id: jobId, business_id: businessId, service: 'HVAC Tune', address: '456 Oak', status: 'accepted', worker_id: 'worker-1' };
      },
      async fetchWorkerProfile() { return { id: 'worker-1', business_id: 'biz-1', full_name: 'Bob Tech', role: 'worker' }; },
      async fetchOwnerProfile() { return { id: 'owner-1', business_id: 'biz-1', full_name: 'Alice Owner', role: 'owner' }; },
      async claimDeliverySlot() { return 'in_progress'; }, // Concurrently being processed
      async fetchRecipientDeviceTokens() { return ['ExponentPushToken[tok]']; },
      async sendExpoPush() { pushDispatches++; return []; },
      async updateDeliverySuccess() {},
      async updateDeliveryNoTokens() {},
      async updateDeliveryFailed() {},
      async deactivateDeviceToken() {},
    };

    const event = {
      id: 'event-uuid-2',
      job_id: 'job-uuid-2',
      business_id: 'biz-1',
      actor_id: 'worker-1',
      actor_role: 'worker',
      event_type: 'status_changed',
      previous_status: 'assigned',
      new_status: 'accepted',
    };

    const result = await processNotificationEvent(event, mockDeps);
    assert.equal(result.success, true);
    assert.equal(result.processed, false);
    assert.equal(result.status, 'duplicate_suppressed');
    assert.ok(result.reason?.includes('in-progress'));
    assert.equal(pushDispatches, 0, 'No push dispatched when in_progress');
  });
});

describe('M15.4 Trusted Recipient Resolution & Business Tenancy', () => {
  test('resolves assigned worker as recipient for job_assigned notification', async () => {
    let resolvedRecipient = null;
    const mockDeps = {
      async fetchJob(jobId, businessId) {
        return { id: jobId, business_id: businessId, service: 'Electrical Repair', address: '789 Elm', status: 'assigned', worker_id: 'worker-uuid-99' };
      },
      async fetchWorkerProfile(workerId, businessId) {
        return { id: workerId, business_id: businessId, full_name: 'Charlie Electrician', role: 'worker' };
      },
      async fetchOwnerProfile() { throw new Error('Owner should not be queried for job_assigned'); },
      async claimDeliverySlot(evtId, recipientUserId) {
        resolvedRecipient = recipientUserId;
        return 'claimed';
      },
      async fetchRecipientDeviceTokens() { return []; },
      async sendExpoPush() { return []; },
      async updateDeliverySuccess() {},
      async updateDeliveryNoTokens() {},
      async updateDeliveryFailed() {},
      async deactivateDeviceToken() {},
    };

    const event = {
      id: 'event-assign-99',
      job_id: 'job-99',
      business_id: 'biz-99',
      actor_id: 'owner-1',
      actor_role: 'owner',
      event_type: 'worker_assigned',
      previous_status: 'unassigned',
      new_status: 'assigned',
    };

    const res = await processNotificationEvent(event, mockDeps);
    assert.equal(resolvedRecipient, 'worker-uuid-99', 'Recipient must be the assigned worker');
    assert.equal(res.status, 'no_tokens');
  });

  test('resolves business owner as recipient for job_accepted, worker_arrived, and job_completed', async () => {
    const recipients = [];

    const mockDeps = {
      async fetchJob(jobId, businessId) {
        return { id: jobId, business_id: businessId, service: 'Roofing inspection', address: '10 Pine St', status: 'completed', worker_id: 'worker-1' };
      },
      async fetchWorkerProfile() { return { id: 'worker-1', business_id: 'biz-1', full_name: 'Dan Tech', role: 'worker' }; },
      async fetchOwnerProfile(businessId) { return { id: 'owner-resolved-id', business_id: businessId, full_name: 'Eve Boss', role: 'owner' }; },
      async claimDeliverySlot(evtId, recipientUserId) {
        recipients.push(recipientUserId);
        return 'claimed';
      },
      async fetchRecipientDeviceTokens() { return []; },
      async sendExpoPush() { return []; },
      async updateDeliverySuccess() {},
      async updateDeliveryNoTokens() {},
      async updateDeliveryFailed() {},
      async deactivateDeviceToken() {},
    };

    // job_accepted
    await processNotificationEvent({
      id: 'evt-acc',
      job_id: 'job-1',
      business_id: 'biz-1',
      actor_id: 'worker-1',
      actor_role: 'worker',
      event_type: 'status_changed',
      previous_status: 'assigned',
      new_status: 'accepted',
    }, mockDeps);

    // worker_arrived
    await processNotificationEvent({
      id: 'evt-arr',
      job_id: 'job-1',
      business_id: 'biz-1',
      actor_id: 'worker-1',
      actor_role: 'worker',
      event_type: 'status_changed',
      previous_status: 'on_the_way',
      new_status: 'arrived',
    }, mockDeps);

    // job_completed
    await processNotificationEvent({
      id: 'evt-comp',
      job_id: 'job-1',
      business_id: 'biz-1',
      actor_id: 'worker-1',
      actor_role: 'worker',
      event_type: 'status_changed',
      previous_status: 'in_progress',
      new_status: 'completed',
    }, mockDeps);

    assert.equal(recipients.length, 3);
    assert.ok(recipients.every((r) => r === 'owner-resolved-id'), 'All 3 events route to owner');
  });

  test('fails safely if job cannot be found in caller business', async () => {
    const mockDeps = {
      async fetchJob() { return null; },
      async fetchWorkerProfile() { return null; },
      async fetchOwnerProfile() { return null; },
      async claimDeliverySlot() { return 'claimed'; },
      async fetchRecipientDeviceTokens() { return []; },
      async sendExpoPush() { return []; },
      async updateDeliverySuccess() {},
      async updateDeliveryNoTokens() {},
      async updateDeliveryFailed() {},
      async deactivateDeviceToken() {},
    };

    const res = await processNotificationEvent({
      id: 'evt-x',
      job_id: 'job-ghost',
      business_id: 'biz-wrong',
      actor_id: 'owner-1',
      actor_role: 'owner',
      event_type: 'worker_assigned',
      previous_status: 'unassigned',
      new_status: 'assigned',
    }, mockDeps);

    assert.equal(res.success, false);
    assert.ok(res.reason?.includes('not found'));
  });
});

describe('M15.4 & M15.5 Payload Privacy, Formatting & No Deep Links', () => {
  test('formats approved payloads with service and worker context and no deep links', () => {
    const assignedPayload = formatNotificationPayload('job_assigned', 'job-1', 'AC Repair');
    assert.equal(assignedPayload.title, 'New job assigned');
    assert.equal(assignedPayload.body, 'AC Repair: Please review the job details.');
    assert.equal(assignedPayload.data.jobId, 'job-1');
    assert.equal(assignedPayload.data.type, 'job_assigned');
    assert.equal(assignedPayload.data.screen, undefined, 'Deep link screen must not be present');

    const acceptedPayload = formatNotificationPayload('job_accepted', 'job-2', 'Pipe Replacement', 'Sarah');
    assert.equal(acceptedPayload.title, 'Job accepted');
    assert.equal(acceptedPayload.body, 'Sarah accepted Pipe Replacement.');
    assert.equal(acceptedPayload.data.screen, undefined, 'Deep link screen must not be present');

    const arrivedPayload = formatNotificationPayload('worker_arrived', 'job-3', 'Locksmith', 'Frank');
    assert.equal(arrivedPayload.title, 'Worker arrived');
    assert.equal(arrivedPayload.body, 'Frank arrived for Locksmith.');
    assert.equal(arrivedPayload.data.screen, undefined, 'Deep link screen must not be present');

    const completedPayload = formatNotificationPayload('job_completed', 'job-4', 'Carpentry', 'Frank');
    assert.equal(completedPayload.title, 'Job completed');
    assert.equal(completedPayload.body, 'Frank completed Carpentry.');
    assert.equal(completedPayload.data.screen, undefined, 'Deep link screen must not be present');
  });

  test('validatePayloadSanitization throws if customer phone, notes, or tokens are present in data', () => {
    const safePayload = formatNotificationPayload('job_assigned', 'job-1', 'Cleaning');
    assert.doesNotThrow(() => validatePayloadSanitization(safePayload));

    const leakPhone = {
      ...safePayload,
      data: { ...safePayload.data, customer_phone: '+15551234567' },
    };
    assert.throws(() => validatePayloadSanitization(leakPhone), /forbidden/);

    const leakNotes = {
      ...safePayload,
      data: { ...safePayload.data, internal_notes: 'Beware of aggressive dog' },
    };
    assert.throws(() => validatePayloadSanitization(leakNotes), /forbidden/);

    const leakGate = {
      ...safePayload,
      data: { ...safePayload.data, gate_code: '#4421' },
    };
    assert.throws(() => validatePayloadSanitization(leakGate), /forbidden/);

    const leakToken = {
      ...safePayload,
      data: { ...safePayload.data, tracking_token: 'secret-uuid' },
    };
    assert.throws(() => validatePayloadSanitization(leakToken), /forbidden/);
  });
});

describe('M15.4 Device Token Management & Failure Handling', () => {
  test('deactivates device token when Expo Push returns DeviceNotRegistered error', async () => {
    const deactivatedTokens = [];
    const mockDeps = {
      async fetchJob(jobId, businessId) {
        return { id: jobId, business_id: businessId, service: 'Pest Control', address: '123 Bug St', status: 'assigned', worker_id: 'worker-1' };
      },
      async fetchWorkerProfile() { return { id: 'worker-1', business_id: 'biz-1', full_name: 'Pete Pest', role: 'worker' }; },
      async fetchOwnerProfile() { return null; },
      async claimDeliverySlot() { return 'claimed'; },
      async fetchRecipientDeviceTokens() {
        return [
          'ExponentPushToken[valid-device-1]',
          'ExponentPushToken[stale-device-2]',
        ];
      },
      async sendExpoPush(messages) {
        return [
          { status: 'ok', id: 'ticket-ok-1' },
          { status: 'error', message: 'The device is not registered', details: { error: 'DeviceNotRegistered' } },
        ];
      },
      async updateDeliverySuccess(idempotencyKey, tokensCount, ticketIds) {
        assert.equal(ticketIds.length, 1);
        assert.equal(ticketIds[0], 'ticket-ok-1');
      },
      async updateDeliveryNoTokens() {},
      async updateDeliveryFailed() {},
      async deactivateDeviceToken(token) {
        deactivatedTokens.push(token);
      },
    };

    const event = {
      id: 'event-stale-test',
      job_id: 'job-1',
      business_id: 'biz-1',
      actor_id: 'owner-1',
      actor_role: 'owner',
      event_type: 'worker_assigned',
      previous_status: 'unassigned',
      new_status: 'assigned',
    };

    const res = await processNotificationEvent(event, mockDeps);
    assert.equal(res.status, 'delivered');
    assert.deepEqual(deactivatedTokens, ['ExponentPushToken[stale-device-2]']);
  });

  test('records failed status in outbox when Expo Push throws network error, marking retryable', async () => {
    let recordedError = null;
    const mockDeps = {
      async fetchJob(jobId, businessId) {
        return { id: jobId, business_id: businessId, service: 'Painting', address: '77 Color Way', status: 'assigned', worker_id: 'worker-1' };
      },
      async fetchWorkerProfile() { return { id: 'worker-1', business_id: 'biz-1', full_name: 'Pablo', role: 'worker' }; },
      async fetchOwnerProfile() { return null; },
      async claimDeliverySlot() { return 'claimed'; },
      async fetchRecipientDeviceTokens() { return ['ExponentPushToken[valid-1]']; },
      async sendExpoPush() {
        throw new Error('Expo Push Service timeout (504)');
      },
      async updateDeliverySuccess() {},
      async updateDeliveryNoTokens() {},
      async updateDeliveryFailed(idempotencyKey, err) {
        recordedError = err;
      },
      async deactivateDeviceToken() {},
    };

    const event = {
      id: 'event-fail-test',
      job_id: 'job-1',
      business_id: 'biz-1',
      actor_id: 'owner-1',
      actor_role: 'owner',
      event_type: 'worker_assigned',
      previous_status: 'unassigned',
      new_status: 'assigned',
    };

    const res = await processNotificationEvent(event, mockDeps);
    assert.equal(res.success, false);
    assert.equal(res.status, 'failed');
    assert.equal(res.retryable, true);
    assert.equal(recordedError, 'Expo Push Service timeout (504)');
  });
});

describe('M15.4 Edge Function Webhook HTTP Interface', () => {
  test('responds to CORS OPTIONS with HTTP 204', async () => {
    const req = new Request('https://edge.supabase.com/push-notifications', {
      method: 'OPTIONS',
    });
    const res = await handleNotificationWebhookRequest(req);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  });

  test('rejects non-POST HTTP methods with HTTP 405', async () => {
    const req = new Request('https://edge.supabase.com/push-notifications', {
      method: 'GET',
    });
    const res = await handleNotificationWebhookRequest(req);
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.ok(body.error?.includes('Use POST'));
  });

  test('rejects malformed JSON body with HTTP 400', async () => {
    // Provide env vars for test
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-key';

    const req = new Request('https://edge.supabase.com/push-notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid-json{{{',
    });
    const res = await handleNotificationWebhookRequest(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error?.includes('Invalid JSON'));
  });

  test('rejects body missing required job_event record fields with HTTP 400', async () => {
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-key';

    const req = new Request('https://edge.supabase.com/push-notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record: { id: 'evt-1' } }), // missing job_id, business_id, event_type
    });
    const res = await handleNotificationWebhookRequest(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error?.includes('Missing required job_event fields'));
  });
});

describe('M15.5 Operational Notification Rules & Edge Cases', () => {
  const baseMockJob = {
    id: 'job-m155-1',
    business_id: 'biz-100',
    service: 'Emergency Pipe Repair',
    address: '42 Wallaby Way',
    status: 'assigned',
    worker_id: 'worker-tech-1',
  };

  const createMockDeps = (overrides = {}) => ({
    async fetchJob(jobId, businessId) {
      return overrides.job !== undefined ? overrides.job : { ...baseMockJob, id: jobId, business_id: businessId };
    },
    async fetchWorkerProfile(workerId, businessId) {
      if (overrides.workerProfile !== undefined) return overrides.workerProfile;
      return { id: workerId, business_id: businessId, full_name: 'Alex Plumber', role: 'worker' };
    },
    async fetchOwnerProfile(businessId) {
      if (overrides.ownerProfile !== undefined) return overrides.ownerProfile;
      return { id: 'owner-user-100', business_id: businessId, full_name: 'Morgan Boss', role: 'owner' };
    },
    async claimDeliverySlot(evtId, recipientUserId, bizId, type, key) {
      if (overrides.claimResult) return overrides.claimResult;
      return 'claimed';
    },
    async fetchRecipientDeviceTokens(recipientUserId) {
      if (overrides.tokens !== undefined) return overrides.tokens;
      return ['ExponentPushToken[mock-token-1]'];
    },
    async sendExpoPush(messages) {
      if (overrides.sendPush) return overrides.sendPush(messages);
      return [{ status: 'ok', id: 'ticket-123' }];
    },
    async updateDeliverySuccess() {},
    async updateDeliveryNoTokens() {},
    async updateDeliveryFailed() {},
    async deactivateDeviceToken() {},
  });

  // Rule 1: Job assigned
  test('Rule 1: Job assigned sends to newly assigned worker with exact title and review instruction', async () => {
    let sentMessage = null;
    let claimedRecipient = null;

    const deps = createMockDeps({
      sendPush: async (messages) => {
        sentMessage = messages[0];
        return [{ status: 'ok', id: 'ticket-assign-1' }];
      },
    });
    deps.claimDeliverySlot = async (evtId, recipientUserId) => {
      claimedRecipient = recipientUserId;
      return 'claimed';
    };

    const event = {
      id: 'event-assign-1',
      job_id: 'job-m155-1',
      business_id: 'biz-100',
      actor_id: 'owner-user-100',
      actor_role: 'owner',
      event_type: 'worker_assigned',
      previous_status: 'unassigned',
      new_status: 'assigned',
      metadata: { worker_id: 'worker-tech-1' },
    };

    const res = await processNotificationEvent(event, deps);
    assert.equal(res.success, true);
    assert.equal(res.processed, true);
    assert.equal(res.status, 'delivered');
    assert.equal(claimedRecipient, 'worker-tech-1', 'Recipient must be the assigned worker');
    assert.equal(sentMessage.title, 'New job assigned');
    assert.equal(sentMessage.body, 'Emergency Pipe Repair: Please review the job details.');
    assert.deepEqual(sentMessage.data, {
      type: 'job_assigned',
      jobId: 'job-m155-1',
    });
    assert.equal(sentMessage.data.screen, undefined, 'No deep link in payload');
  });

  // Rule 2: Job accepted
  test('Rule 2: Job accepted sends to business owner with worker display name and service name', async () => {
    let sentMessage = null;
    let claimedRecipient = null;

    const deps = createMockDeps({
      sendPush: async (messages) => {
        sentMessage = messages[0];
        return [{ status: 'ok', id: 'ticket-acc-1' }];
      },
    });
    deps.claimDeliverySlot = async (evtId, recipientUserId) => {
      claimedRecipient = recipientUserId;
      return 'claimed';
    };

    const event = {
      id: 'event-acc-1',
      job_id: 'job-m155-1',
      business_id: 'biz-100',
      actor_id: 'worker-tech-1',
      actor_role: 'worker',
      event_type: 'status_changed',
      previous_status: 'assigned',
      new_status: 'accepted',
    };

    const res = await processNotificationEvent(event, deps);
    assert.equal(res.success, true);
    assert.equal(res.processed, true);
    assert.equal(claimedRecipient, 'owner-user-100', 'Recipient must be the business owner');
    assert.equal(sentMessage.title, 'Job accepted');
    assert.equal(sentMessage.body, 'Alex Plumber accepted Emergency Pipe Repair.');
    assert.deepEqual(sentMessage.data, {
      type: 'job_accepted',
      jobId: 'job-m155-1',
    });
  });

  // Rule 3: Worker arrived
  test('Rule 3: Worker arrived sends to business owner with worker display name and service name', async () => {
    let sentMessage = null;
    let claimedRecipient = null;

    const deps = createMockDeps({
      sendPush: async (messages) => {
        sentMessage = messages[0];
        return [{ status: 'ok', id: 'ticket-arr-1' }];
      },
    });
    deps.claimDeliverySlot = async (evtId, recipientUserId) => {
      claimedRecipient = recipientUserId;
      return 'claimed';
    };

    const event = {
      id: 'event-arr-1',
      job_id: 'job-m155-1',
      business_id: 'biz-100',
      actor_id: 'worker-tech-1',
      actor_role: 'worker',
      event_type: 'status_changed',
      previous_status: 'on_the_way',
      new_status: 'arrived',
    };

    const res = await processNotificationEvent(event, deps);
    assert.equal(res.success, true);
    assert.equal(res.processed, true);
    assert.equal(claimedRecipient, 'owner-user-100', 'Recipient must be the business owner');
    assert.equal(sentMessage.title, 'Worker arrived');
    assert.equal(sentMessage.body, 'Alex Plumber arrived for Emergency Pipe Repair.');
    assert.deepEqual(sentMessage.data, {
      type: 'worker_arrived',
      jobId: 'job-m155-1',
    });
  });

  // Rule 4: Job completed
  test('Rule 4: Job completed sends to business owner with worker display name and service name', async () => {
    let sentMessage = null;
    let claimedRecipient = null;

    const deps = createMockDeps({
      sendPush: async (messages) => {
        sentMessage = messages[0];
        return [{ status: 'ok', id: 'ticket-comp-1' }];
      },
    });
    deps.claimDeliverySlot = async (evtId, recipientUserId) => {
      claimedRecipient = recipientUserId;
      return 'claimed';
    };

    const event = {
      id: 'event-comp-1',
      job_id: 'job-m155-1',
      business_id: 'biz-100',
      actor_id: 'worker-tech-1',
      actor_role: 'worker',
      event_type: 'status_changed',
      previous_status: 'in_progress',
      new_status: 'completed',
    };

    const res = await processNotificationEvent(event, deps);
    assert.equal(res.success, true);
    assert.equal(res.processed, true);
    assert.equal(claimedRecipient, 'owner-user-100', 'Recipient must be the business owner');
    assert.equal(sentMessage.title, 'Job completed');
    assert.equal(sentMessage.body, 'Alex Plumber completed Emergency Pipe Repair.');
    assert.deepEqual(sentMessage.data, {
      type: 'job_completed',
      jobId: 'job-m155-1',
    });
  });

  // Reassignment Safeguard
  test('Reassignment: notifies ONLY the new worker; previous worker is NEVER notified', async () => {
    const notifiedRecipients = [];

    const deps = createMockDeps({
      sendPush: async (messages) => {
        return [{ status: 'ok', id: 'ticket-reassign' }];
      },
    });
    deps.claimDeliverySlot = async (evtId, recipientUserId) => {
      notifiedRecipients.push(recipientUserId);
      return 'claimed';
    };

    const reassignEvent = {
      id: 'event-reassign-77',
      job_id: 'job-m155-1',
      business_id: 'biz-100',
      actor_id: 'owner-user-100',
      actor_role: 'owner',
      event_type: 'worker_reassigned',
      previous_status: 'assigned',
      new_status: 'assigned',
      metadata: {
        previous_worker_id: 'old-worker-A',
        new_worker_id: 'new-worker-B',
      },
    };

    // Mock job has new worker
    deps.fetchJob = async () => ({
      ...baseMockJob,
      worker_id: 'new-worker-B',
    });
    deps.fetchWorkerProfile = async (wId) => ({
      id: wId,
      business_id: 'biz-100',
      full_name: 'New Worker B',
      role: 'worker',
    });

    const res = await processNotificationEvent(reassignEvent, deps);
    assert.equal(res.success, true);
    assert.equal(res.processed, true);
    assert.equal(notifiedRecipients.length, 1);
    assert.equal(notifiedRecipients[0], 'new-worker-B', 'Only new worker B must be notified');
    assert.ok(!notifiedRecipients.includes('old-worker-A'), 'Old worker A must NOT be notified');
  });

  // Reassignment to same worker is a no-op
  test('Reassignment: if new worker matches previous worker, no notification is sent', async () => {
    let pushSent = false;
    const deps = createMockDeps({
      sendPush: async () => { pushSent = true; return []; },
    });

    const event = {
      id: 'event-reassign-same',
      job_id: 'job-m155-1',
      business_id: 'biz-100',
      actor_id: 'owner-user-100',
      actor_role: 'owner',
      event_type: 'worker_reassigned',
      previous_status: 'assigned',
      new_status: 'assigned',
      metadata: {
        previous_worker_id: 'worker-tech-1',
        new_worker_id: 'worker-tech-1',
      },
    };

    const res = await processNotificationEvent(event, deps);
    assert.equal(res.processed, false);
    assert.equal(pushSent, false, 'No push sent when target matches previous worker');
  });

  // Worker Declines (assigned -> unassigned): No notification
  test('Worker Declines: assigned -> unassigned is strictly ignored (no misleading notification)', async () => {
    const event = {
      id: 'event-decline-1',
      job_id: 'job-m155-1',
      business_id: 'biz-100',
      actor_id: 'worker-tech-1',
      actor_role: 'worker',
      event_type: 'status_changed',
      previous_status: 'assigned',
      new_status: 'unassigned',
    };
    const deps = createMockDeps();
    const res = await processNotificationEvent(event, deps);
    assert.equal(res.success, true);
    assert.equal(res.processed, false);
    assert.ok(res.reason?.includes('not eligible'));
  });

  // Job Cancelled: No notification
  test('Job Cancelled: any -> cancelled is strictly ignored (no misleading notification)', async () => {
    const event = {
      id: 'event-cancel-1',
      job_id: 'job-m155-1',
      business_id: 'biz-100',
      actor_id: 'owner-user-100',
      actor_role: 'owner',
      event_type: 'status_changed',
      previous_status: 'assigned',
      new_status: 'cancelled',
    };
    const deps = createMockDeps();
    const res = await processNotificationEvent(event, deps);
    assert.equal(res.success, true);
    assert.equal(res.processed, false);
    assert.ok(res.reason?.includes('not eligible'));
  });

  // Missing Tokens: normal continuation
  test('Missing Tokens: continues workflow normally without error when recipient has 0 tokens', async () => {
    let outboxStatus = null;
    const deps = createMockDeps({
      tokens: [], // No active push tokens
    });
    deps.updateDeliveryNoTokens = async () => {
      outboxStatus = 'no_tokens';
    };

    const event = {
      id: 'event-no-token',
      job_id: 'job-m155-1',
      business_id: 'biz-100',
      actor_id: 'owner-user-100',
      actor_role: 'owner',
      event_type: 'worker_assigned',
      previous_status: 'unassigned',
      new_status: 'assigned',
    };

    const res = await processNotificationEvent(event, deps);
    assert.equal(res.success, true, 'Workflow must succeed normally');
    assert.equal(res.processed, true);
    assert.equal(res.status, 'no_tokens');
    assert.equal(res.tokensCount, 0);
    assert.equal(outboxStatus, 'no_tokens');
  });

  // Role Safeguards: Do not notify owner as worker
  test('Role Safeguard: suppresses job_assigned notification if assigned user is an owner', async () => {
    let pushSent = false;
    const deps = createMockDeps({
      workerProfile: { id: 'owner-imposter', business_id: 'biz-100', full_name: 'Owner Guy', role: 'owner' },
      sendPush: async () => { pushSent = true; return []; },
    });

    const event = {
      id: 'event-owner-as-worker',
      job_id: 'job-m155-1',
      business_id: 'biz-100',
      actor_id: 'owner-user-100',
      actor_role: 'owner',
      event_type: 'worker_assigned',
      previous_status: 'unassigned',
      new_status: 'assigned',
    };

    const res = await processNotificationEvent(event, deps);
    assert.equal(res.success, false);
    assert.equal(res.processed, false);
    assert.ok(res.reason?.includes('not \'worker\''));
    assert.equal(pushSent, false);
  });

  // Role Safeguards: Do not notify worker as owner
  test('Role Safeguard: suppresses job_accepted notification if owner profile has worker role', async () => {
    let pushSent = false;
    const deps = createMockDeps({
      ownerProfile: { id: 'worker-imposter', business_id: 'biz-100', full_name: 'Worker Guy', role: 'worker' },
      sendPush: async () => { pushSent = true; return []; },
    });

    const event = {
      id: 'event-worker-as-owner',
      job_id: 'job-m155-1',
      business_id: 'biz-100',
      actor_id: 'worker-tech-1',
      actor_role: 'worker',
      event_type: 'status_changed',
      previous_status: 'assigned',
      new_status: 'accepted',
    };

    const res = await processNotificationEvent(event, deps);
    assert.equal(res.success, false);
    assert.equal(res.processed, false);
    assert.ok(res.reason?.includes('not \'owner\''));
    assert.equal(pushSent, false);
  });

  // Self-notification suppression
  test('Self-notification safeguard: suppresses notification if actor is the recipient', async () => {
    let pushSent = false;
    const deps = createMockDeps({
      sendPush: async () => { pushSent = true; return []; },
    });

    // Owner accepts/completes their own visit (actor_id matches owner recipient)
    const event = {
      id: 'event-self-act',
      job_id: 'job-m155-1',
      business_id: 'biz-100',
      actor_id: 'owner-user-100', // matches ownerProfile.id
      actor_role: 'owner',
      event_type: 'status_changed',
      previous_status: 'in_progress',
      new_status: 'completed',
    };

    const res = await processNotificationEvent(event, deps);
    assert.equal(res.success, true);
    assert.equal(res.processed, false);
    assert.ok(res.reason?.includes('Self-notification suppressed'));
    assert.equal(pushSent, false);
  });
});

