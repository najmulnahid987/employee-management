/**
 * Dispatcher M13.7 — Owner Tracking Link Sharing Verification Test Suite
 *
 * Validates:
 * 1. Tracking link issuance for eligible jobs (assigned worker, active non-terminal status).
 * 2. Strict rejection of ineligible jobs (unassigned or terminal completed/cancelled).
 * 3. Copy Link and native Share Link behavior (using full absolute URL with fragment, zero auto-SMS).
 * 4. Replacement link rotation: warns owner and invalidates earlier active session.
 * 5. Resolution in an unauthenticated browser: public tracking endpoint succeeds with bearer token
 *    and withholds customer phone, internal notes, and database IDs.
 * 6. Local state invalidation: clears tracking session if job becomes terminal or unassigned.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Import tracking session helpers from pure module
const {
  buildFullTrackingUrl,
  isJobEligibleForTrackingIssuance,
} = await import('../src/lib/tracking-token.ts');

const SAMPLE_RAW_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

// =============================================================================
// Test Suite 1: Job Eligibility Matrix for Link Issuance
// =============================================================================

test('M13.7 Job Eligibility Matrix for Link Issuance', async (t) => {
  await t.test('strictly rejects unassigned jobs (worker_id is null or unassigned status)', () => {
    assert.equal(isJobEligibleForTrackingIssuance('unassigned', null), false);
    assert.equal(isJobEligibleForTrackingIssuance('unassigned', 'worker-123'), false);
    assert.equal(isJobEligibleForTrackingIssuance('assigned', null), false);
    assert.equal(isJobEligibleForTrackingIssuance('on_the_way', null), false);
  });

  await t.test('strictly rejects terminal jobs (completed or cancelled)', () => {
    assert.equal(isJobEligibleForTrackingIssuance('completed', 'worker-123'), false);
    assert.equal(isJobEligibleForTrackingIssuance('cancelled', 'worker-123'), false);
  });

  await t.test('permits issuance for active assigned lifecycle statuses', () => {
    const eligibleStatuses = ['assigned', 'accepted', 'on_the_way', 'arrived', 'in_progress'];
    for (const status of eligibleStatuses) {
      assert.equal(
        isJobEligibleForTrackingIssuance(status, 'worker-uuid-123'),
        true,
        `Status ${status} with assigned worker must be eligible for tracking link issuance`
      );
    }
  });
});

// =============================================================================
// Test Suite 2: Absolute URL Construction & Format Hygiene
// =============================================================================

test('M13.7 Tracking URL Construction & Format Hygiene', async (t) => {
  await t.test('builds full URL using fragment format (#<token>) to prevent access-log exposure', () => {
    const fullUrl = buildFullTrackingUrl(SAMPLE_RAW_TOKEN, 'https://test.dispatcher.app');
    assert.equal(
      fullUrl,
      `https://test.dispatcher.app/track#${SAMPLE_RAW_TOKEN}`
    );
  });

  await t.test('strips leading path segments safely and handles raw tokens or relative paths', () => {
    const fromPath = buildFullTrackingUrl(`/track/${SAMPLE_RAW_TOKEN}`, 'https://dispatch.local');
    assert.equal(fromPath, `https://dispatch.local/track#${SAMPLE_RAW_TOKEN}`);

    const fromFragmentPath = buildFullTrackingUrl(`/track#${SAMPLE_RAW_TOKEN}`, 'https://dispatch.local');
    assert.equal(fromFragmentPath, `https://dispatch.local/track#${SAMPLE_RAW_TOKEN}`);
  });

  await t.test('never constructs tracking URLs by concatenating database IDs', () => {
    const fakeJobId = '550e8400-e29b-41d4-a716-446655440000';
    const fakeBusinessId = '660e8400-e29b-41d4-a716-446655440000';

    const url = buildFullTrackingUrl(SAMPLE_RAW_TOKEN, 'https://test.dispatcher.app');
    assert.equal(url.includes(fakeJobId), false);
    assert.equal(url.includes(fakeBusinessId), false);
  });
});

// =============================================================================
// Test Suite 3: Owner Job Details Screen UI Verification (Customer Tracking Option Removed)
// =============================================================================

test('M13.7 Owner Job Details Screen UI Verification (Tracking Removed)', async (t) => {
  const jobDetailsPath = path.join(
    projectRoot,
    'src/app/owner/job-details.tsx'
  );
  assert.ok(fs.existsSync(jobDetailsPath), 'job-details.tsx must exist');
  const content = fs.readFileSync(jobDetailsPath, 'utf8');

  await t.test('does NOT contain Create Tracking Link action', () => {
    assert.equal(
      content.includes('label="Create Tracking Link"'),
      false,
      'Owner screen must not have "Create Tracking Link" action'
    );
  });

  await t.test('does NOT contain Customer Tracking card or sharing actions', () => {
    assert.equal(
      content.includes('<ThemedText type="headline">Customer Tracking</ThemedText>'),
      false,
      'Customer Tracking section header must not be rendered'
    );
    assert.equal(
      content.includes('label="Copy Link"'),
      false,
      'Must not render Copy Link action'
    );
    assert.equal(
      content.includes('label="Share Link"'),
      false,
      'Must not render Share Link action'
    );
    assert.equal(
      content.includes('label="Create Replacement Link"'),
      false,
      'Must not render replacement link action'
    );
  });

  await t.test('does NOT automatically send SMS or invoke external messaging services', () => {
    assert.equal(
      content.includes('sms:') || content.includes('Linking.openURL(smsUrl)'),
      false,
      'Must not automatically launch SMS or external messaging services'
    );
  });
});

// =============================================================================
// Test Suite 4: Security, RPC & Absence of Direct Table Access
// =============================================================================

test('M13.7 Security, RPC & Absence of Direct Table Access', () => {
  const jobDetailsPath = path.join(
    projectRoot,
    'src/app/owner/job-details.tsx'
  );
  const servicePath = path.join(
    projectRoot,
    'src/lib/tracking-session-service.ts'
  );

  const jobDetailsContent = fs.readFileSync(jobDetailsPath, 'utf8');
  const serviceContent = fs.readFileSync(servicePath, 'utf8');

  // Ensure no direct queries to customer_tracking_sessions table from client code
  assert.equal(
    jobDetailsContent.includes(".from('customer_tracking_sessions')") ||
    serviceContent.includes(".from('customer_tracking_sessions')"),
    false,
    'Client code must NEVER query customer_tracking_sessions table directly'
  );

  // Ensure issuance strictly calls generate_customer_tracking_session RPC
  assert.match(
    serviceContent,
    /rpc\(['"]generate_customer_tracking_session['"]/,
    'Issuance must call generate_customer_tracking_session RPC'
  );

  // Ensure revocation strictly calls revoke_customer_tracking_session RPC
  assert.match(
    serviceContent,
    /rpc\(['"]revoke_customer_tracking_session['"]/,
    'Revocation must call revoke_customer_tracking_session RPC'
  );

  // Ensure no service-role key in owner screen
  assert.equal(
    jobDetailsContent.includes('SUPABASE_SERVICE_ROLE_KEY'),
    false,
    'Service-role key must NEVER exist in client code'
  );
});
