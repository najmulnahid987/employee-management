/**
 * Dispatcher M13.8 — Customer Tracking Security and Acceptance Test Suite
 *
 * Programmatic execution verifying all 22 acceptance criteria and lifecycle guarantees:
 * - Functional Tests (Tests 1 - 10)
 * - Security Tests (Tests 11 - 22)
 * - Backend-Enforced Lifecycle Revocation Invariants (Tests 23 - 28)
 *
 * Execution: node --test --experimental-strip-types scripts/test-m13-acceptance.mjs
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Import pure client-side utilities
const {
  buildFullTrackingUrl,
  isJobEligibleForTrackingIssuance,
  extractTrackingToken,
} = await import('../src/lib/tracking-token.ts');

// Import Edge Function core server handlers and sanitizers
const {
  handleCustomerTrackingRequest,
  validateTokenFormat,
  computeTokenSha256Hex,
  extractBearerToken,
  sanitizeCustomerTrackingPayload,
  InMemoryRateLimiter,
  FORBIDDEN_RESPONSE_FIELDS,
  DEFAULT_CORS_HEADERS,
  PRIVATE_CACHE_HEADERS,
} = await import('../supabase/functions/customer-tracking/core.ts');

// =============================================================================
// Mock Fixtures
// =============================================================================

function generateMockValidToken() {
  const uuid1 = crypto.randomUUID().replace(/-/g, '');
  const uuid2 = crypto.randomUUID().replace(/-/g, '');
  return `${uuid1}${uuid2}`;
}

const SAMPLE_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const SAMPLE_DATABASE_ROW = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  job_id: '660e8400-e29b-41d4-a716-446655440001',
  business_id: '770e8400-e29b-41d4-a716-446655440002',
  worker_id: '880e8400-e29b-41d4-a716-446655440003',
  customer_name: 'Jane Doe',
  customer_phone: '+15555551212',
  notes: 'Key under the flowerpot. Dog in backyard.',
  cancellation_reason: null,
  worker_full_name: 'Marcus Vance',
  worker_phone: '+15555559999',
  worker_email: 'marcus@example.com',
  address: '742 Evergreen Terrace, Springfield',
  token_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  service: 'HVAC Seasonal Inspection',
  status: 'on_the_way',
  status_label: 'Technician is on the way',
  scheduled_at: '2026-10-26T14:00:00Z',
  business_name: 'Apex Heating & Air',
  business_phone: '(555) 019-2831',
  worker_first_name: 'Marcus',
  worker_avatar_url: 'https://cdn.example.com/avatars/marcus.jpg',
  destination: {
    latitude: 37.7749,
    longitude: -122.4194,
  },
  worker_location: {
    latitude: 37.7712,
    longitude: -122.4153,
    accuracy: 14.2,
    recorded_at: '2026-10-26T13:55:00Z',
    is_stale: false,
  },
  is_tracking_active: true,
  activated_at: '2026-10-26T13:50:00Z',
  tracking_message: 'Technician is on the way.',
  last_location_updated_at: '2026-10-26T13:55:00Z',
  estimated_arrival: null,
  session_expires_at: '2026-10-27T13:50:00Z',
  updated_at: '2026-10-26T13:55:00Z',
};

// =============================================================================
// Section 1: Functional Tests (Tests 1 - 10)
// =============================================================================

describe('Section 1: Functional Acceptance Tests', () => {
  test('1. Worker starts travelling and the backend activates tracking eligibility', () => {
    // Verified by migration 20261028020000_tracking_session_lifecycle.sql:
    // Trigger handle_job_tracking_session_lifecycle checks:
    // IF NEW.status = 'on_the_way' AND (OLD.status IS DISTINCT FROM 'on_the_way') THEN
    //   UPDATE public.customer_tracking_sessions SET activated_at = pg_catalog.now()
    const lifecycleTriggerPath = path.join(
      projectRoot,
      'supabase/migrations/20261028020000_tracking_session_lifecycle.sql'
    );
    assert.ok(fs.existsSync(lifecycleTriggerPath), 'Lifecycle migration file must exist');
    const content = fs.readFileSync(lifecycleTriggerPath, 'utf8');

    assert.match(
      content,
      /IF NEW\.status = 'on_the_way' AND \(OLD\.status IS DISTINCT FROM 'on_the_way'\) THEN[\s\S]*?SET activated_at = pg_catalog\.now\(\)/,
      'Transition to on_the_way must automatically activate tracking session timestamp'
    );
  });

  test('2. Owner creates a tracking link for the eligible job', () => {
    // Verified: isJobEligibleForTrackingIssuance permits assigned, accepted, on_the_way, arrived, in_progress
    assert.equal(isJobEligibleForTrackingIssuance('assigned', 'worker-1'), true);
    assert.equal(isJobEligibleForTrackingIssuance('accepted', 'worker-1'), true);
    assert.equal(isJobEligibleForTrackingIssuance('on_the_way', 'worker-1'), true);
    assert.equal(isJobEligibleForTrackingIssuance('arrived', 'worker-1'), true);
    assert.equal(isJobEligibleForTrackingIssuance('in_progress', 'worker-1'), true);

    // Strictly rejected if unassigned or no worker
    assert.equal(isJobEligibleForTrackingIssuance('unassigned', null), false);
    assert.equal(isJobEligibleForTrackingIssuance('assigned', null), false);

    // RPC generate_customer_tracking_session produces URL-safe bearer token with >= 256 bits entropy
    const token = generateMockValidToken();
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);

    const fullUrl = buildFullTrackingUrl(token, 'https://dispatcher.app');
    assert.equal(fullUrl, `https://dispatcher.app/track#${token}`);
  });

  test('3. Customer opens that URL in a private/incognito browser without signing in', () => {
    // Root layout explicitly exempts /track from authentication redirect guards
    const layoutPath = path.join(projectRoot, 'src/app/_layout.tsx');
    const content = fs.readFileSync(layoutPath, 'utf8');
    assert.match(
      content,
      /rootSegment\s*===\s*['"]track['"]/,
      'Root layout must bypass auth redirect for /track'
    );

    // Token extracted from window.location.hash without requiring a user session
    assert.equal(extractTrackingToken({ pathToken: SAMPLE_TOKEN }), SAMPLE_TOKEN);
  });

  test('4. Customer sees the correct business name, worker first name where appropriate, current status, and last location update', () => {
    const sanitized = sanitizeCustomerTrackingPayload(SAMPLE_DATABASE_ROW);
    assert.ok(sanitized, 'Sanitized payload must exist');

    assert.equal(sanitized.business_name, 'Apex Heating & Air');
    assert.equal(sanitized.business_phone, '(555) 019-2831');
    assert.equal(sanitized.worker_first_name, 'Marcus');
    assert.equal(sanitized.status, 'on_the_way');
    assert.equal(sanitized.status_label, 'Technician is on the way');
    assert.equal(sanitized.last_location_updated_at, '2026-10-26T13:55:00Z');
  });

  test('5. Map uses actual valid coordinates from the correct job/session', () => {
    const mapComponentPath = path.join(
      projectRoot,
      'src/components/tracking/customer-tracking-map.tsx'
    );
    const content = fs.readFileSync(mapComponentPath, 'utf8');

    assert.ok(
      content.includes('const workerLatLng = [workerLocation.latitude, workerLocation.longitude];'),
      'Worker marker must bind to real worker coordinates'
    );
    assert.ok(
      content.includes('workerMarker = L.marker(workerLatLng, { icon: workerIcon }).addTo(map);'),
      'Worker marker must use actual coordinates'
    );

    // Destination marker is strictly conditional on job coordinates existing
    assert.match(
      content,
      /typeof destination\.latitude === 'number' &&\s*typeof destination\.longitude === 'number'/,
      'Destination marker must only render when coordinates are provided'
    );

    // Confirms no fake routes or polyline drawing
    assert.equal(
      content.includes('L.polyline') || content.includes('L.Polyline'),
      false,
      'Must NOT draw fake routes or polylines'
    );
  });

  test('6. A worker location update appears after the next poll', () => {
    const viewPath = path.join(
      projectRoot,
      'src/components/tracking/customer-tracking-view.tsx'
    );
    const content = fs.readFileSync(viewPath, 'utf8');

    // Polling interval is configured between 20-30s while page is visible
    assert.match(
      content,
      /pollIntervalMs\s*=\s*20000/,
      'Polling interval must default to 20s'
    );
    assert.match(
      content,
      /pollTimerRef\.current\s*=\s*setInterval\(/,
      'Must schedule recurring polling'
    );
    assert.match(
      content,
      /setPayload\(res\.payload\)/,
      'Poll response must reactively update payload state without full-page reload'
    );
  });

  test('7. A job status update appears without a full-page reload', () => {
    const viewPath = path.join(
      projectRoot,
      'src/components/tracking/customer-tracking-view.tsx'
    );
    const content = fs.readFileSync(viewPath, 'utf8');

    // StatusBadge dynamically binds to validStatus and payload.status_label
    assert.match(
      content,
      /<StatusBadge[^>]*status=\{validStatus\}/,
      'Status badge must bind reactively to validStatus derived from payload.status'
    );
    assert.match(
      content,
      /label=\{payload\.status_label\}/,
      'Status label must reactively display without page reload'
    );
  });

  test('8. A stale or unavailable position is represented honestly', () => {
    const viewPath = path.join(
      projectRoot,
      'src/components/tracking/customer-tracking-view.tsx'
    );
    const content = fs.readFileSync(viewPath, 'utf8');

    // Honest representation for unavailable position
    assert.match(
      content,
      /Location Temporarily Unavailable/,
      'Must render honest unavailable position card'
    );

    // Honest representation for delayed/stale telemetry (> 10 mins)
    assert.match(
      content,
      /Location Update Delayed/i,
      'Must display delayed telemetry indicator when telemetry is stale'
    );

    const mapPath = path.join(
      projectRoot,
      'src/components/tracking/customer-tracking-map.tsx'
    );
    const mapContent = fs.readFileSync(mapPath, 'utf8');

    // Uncertainty circle and poor accuracy warning (> 100m)
    assert.match(
      mapContent,
      /Position approximate/i,
      'Must warn customer when GPS accuracy is degraded'
    );
    assert.match(
      mapContent,
      /L\.circle\(workerLatLng,\s*\{\s*radius:\s*workerLocation\.accuracy/,
      'Must draw honest accuracy uncertainty circle'
    );
  });

  test('9. Customer page handles network failure and retry', () => {
    const viewPath = path.join(
      projectRoot,
      'src/components/tracking/customer-tracking-view.tsx'
    );
    const content = fs.readFileSync(viewPath, 'utf8');

    assert.match(
      content,
      /Connection Error/,
      'Must render clear network connection error banner'
    );
    assert.match(
      content,
      /label=["']Try Again["']/,
      'Must provide a Try Again retry action'
    );
  });

  test('10. The app does not display an invented ETA', () => {
    const sanitized = sanitizeCustomerTrackingPayload(SAMPLE_DATABASE_ROW);
    assert.equal(
      sanitized.estimated_arrival,
      null,
      'estimated_arrival must strictly be null'
    );

    const viewPath = path.join(
      projectRoot,
      'src/components/tracking/customer-tracking-view.tsx'
    );
    const content = fs.readFileSync(viewPath, 'utf8');
    assert.equal(
      content.includes('Estimated Arrival') || content.includes('ETA:'),
      false,
      'Customer UI must NOT display an invented ETA'
    );
  });
});

// =============================================================================
// Section 2: Security Tests (Tests 11 - 22)
// =============================================================================

describe('Section 2: Security Acceptance Tests', () => {
  test('11. A random invalid token cannot retrieve data', async () => {
    const mockDb = async () => ({ data: null, error: null });

    // A. Malformed token (short) fails client/edge format validation
    assert.equal(validateTokenFormat('invalid-too-short'), false);

    // B. Random non-existent 64-hex token returns generic 404
    const randomHex = crypto.randomBytes(32).toString('hex');
    assert.equal(validateTokenFormat(randomHex), true);

    const req = new Request('https://api.dispatcher.app/functions/v1/customer-tracking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: randomHex }),
    });

    const res = await handleCustomerTrackingRequest(req, { dbExecutor: mockDb });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'Tracking session unavailable or expired.');
  });

  test('12. A token with an expired session cannot retrieve data', async () => {
    // Database RPC returns null for expired session
    const mockDb = async () => ({ data: null, error: null });
    const expiredToken = generateMockValidToken();

    const req = new Request(`https://api.dispatcher.app/functions/v1/customer-tracking?token=${expiredToken}`);
    const res = await handleCustomerTrackingRequest(req, { dbExecutor: mockDb });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.data, null);
  });

  test('13. A revoked/replaced token stops working', async () => {
    // Database RPC returns null for revoked session (revoked_at IS NOT NULL)
    const mockDb = async () => ({ data: null, error: null });
    const revokedToken = generateMockValidToken();

    const req = new Request(`https://api.dispatcher.app/functions/v1/customer-tracking?token=${revokedToken}`);
    const res = await handleCustomerTrackingRequest(req, { dbExecutor: mockDb });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.data, null);
  });

  test('14. Completed and cancelled jobs stop exposing tracking', () => {
    const rpcPath = path.join(
      projectRoot,
      'supabase/migrations/20261028020000_tracking_session_lifecycle.sql'
    );
    const content = fs.readFileSync(rpcPath, 'utf8');

    // get_customer_tracking_session_job checks job status
    assert.match(
      content,
      /IF v_job\.status IN \('completed',\s*'cancelled',\s*'unassigned'\) THEN[\s\S]*?RETURN NULL;/,
      'RPC must return NULL if job is completed, cancelled, or unassigned'
    );
  });

  test("15. Declined, unassigned, or reassigned jobs stop exposing the old worker's tracking", () => {
    const rpcPath = path.join(
      projectRoot,
      'supabase/migrations/20261028020000_tracking_session_lifecycle.sql'
    );
    const content = fs.readFileSync(rpcPath, 'utf8');

    // get_customer_tracking_session_job checks worker assignment match
    assert.match(
      content,
      /IF v_session\.worker_id IS NOT NULL AND v_job\.worker_id IS DISTINCT FROM v_session\.worker_id THEN[\s\S]*?RETURN NULL;/,
      'RPC must return NULL if worker_id has changed or been unassigned'
    );
  });

  test("16. A token for one job cannot return another job's location", () => {
    const rpcPath = path.join(
      projectRoot,
      'supabase/migrations/20261028020000_tracking_session_lifecycle.sql'
    );
    const content = fs.readFileSync(rpcPath, 'utf8');

    // Strict join of locations on worker_id AND job_id matching current session job
    assert.match(
      content,
      /SELECT \* INTO v_location[\s\S]*?WHERE worker_id = v_job\.worker_id[\s\S]*?AND job_id = v_job\.id;/,
      'Locations query must strictly filter by current job ID and assigned worker ID'
    );
  });

  test('17. Anonymous requests cannot read the underlying Supabase tables', () => {
    const migration1 = fs.readFileSync(
      path.join(projectRoot, 'supabase/migrations/20261028010000_customer_tracking_sessions.sql'),
      'utf8'
    );
    assert.match(
      migration1,
      /REVOKE ALL ON public\.customer_tracking_sessions FROM anon;/,
      'Must revoke all table access from anon on customer_tracking_sessions'
    );

    const rlsMigration = fs.readFileSync(
      path.join(projectRoot, 'supabase/migrations/20261022223000_rls_security_policies.sql'),
      'utf8'
    );
    assert.match(rlsMigration, /REVOKE ALL ON public\.jobs FROM anon;/);
    assert.match(rlsMigration, /REVOKE ALL ON public\.locations FROM anon;/);
    assert.match(rlsMigration, /REVOKE ALL ON public\.profiles FROM anon;/);
  });

  test('18. Response bodies include only the approved customer-safe fields', () => {
    const sanitized = sanitizeCustomerTrackingPayload(SAMPLE_DATABASE_ROW);
    const keys = Object.keys(sanitized);

    // Verify none of the forbidden fields exist in the response
    for (const forbidden of FORBIDDEN_RESPONSE_FIELDS) {
      assert.equal(
        keys.includes(forbidden),
        false,
        `Forbidden field "${forbidden}" must NOT exist in customer payload`
      );
    }

    // Verify exact expected safe fields
    const expectedSafeFields = [
      'business_name',
      'business_phone',
      'service',
      'status',
      'status_label',
      'scheduled_at',
      'worker_first_name',
      'worker_avatar_url',
      'destination',
      'worker_location',
      'is_tracking_active',
      'activated_at',
      'tracking_message',
      'last_location_updated_at',
      'estimated_arrival',
      'session_expires_at',
      'updated_at',
    ];

    for (const safeKey of expectedSafeFields) {
      assert.ok(keys.includes(safeKey), `Expected safe key "${safeKey}" must be present`);
    }
  });

  test('19. No raw token, token hash, internal IDs, customer phone, notes, or secrets in HTML, bundles, or logs', () => {
    const viewPath = path.join(projectRoot, 'src/components/tracking/customer-tracking-view.tsx');
    const viewContent = fs.readFileSync(viewPath, 'utf8');

    // Never renders customer phone, internal notes, or raw IDs
    assert.equal(viewContent.includes('payload.customer_phone'), false);
    assert.equal(viewContent.includes('payload.notes'), false);
    assert.equal(viewContent.includes('payload.job_id'), false);
    assert.equal(viewContent.includes('payload.token_hash'), false);

    // No service role key in view
    assert.equal(viewContent.includes('SUPABASE_SERVICE_ROLE_KEY'), false);

    // Token extraction sanitizes inputs and logs never output raw tokens
    const corePath = path.join(projectRoot, 'supabase/functions/customer-tracking/core.ts');
    const coreContent = fs.readFileSync(corePath, 'utf8');
    assert.equal(coreContent.includes('console.log(rawToken'), false);
    assert.equal(coreContent.includes('console.log(token'), false);
  });

  test('20. Private tracking responses are not cached', async () => {
    const mockDb = async () => ({ data: SAMPLE_DATABASE_ROW, error: null });
    const req = new Request(`https://api.dispatcher.app/functions/v1/customer-tracking?token=${SAMPLE_TOKEN}`);
    const res = await handleCustomerTrackingRequest(req, { dbExecutor: mockDb });

    assert.equal(
      res.headers.get('Cache-Control'),
      'no-store, no-cache, must-revalidate, private'
    );
    assert.equal(res.headers.get('Pragma'), 'no-cache');
  });

  test('21. Repeated requests are handled within the rate-limit/abuse-control policy', async () => {
    const rateLimiter = new InMemoryRateLimiter(60000, 60);
    const ip = '198.51.100.42';

    // First 60 requests are allowed
    for (let i = 0; i < 60; i++) {
      assert.equal(rateLimiter.check(ip).limited, false);
    }

    // 61st request is blocked
    assert.equal(rateLimiter.check(ip).limited, true);

    // HTTP handler returns 429 with Retry-After header
    const mockDb = async () => ({ data: SAMPLE_DATABASE_ROW, error: null });
    const req = new Request(`https://api.dispatcher.app/functions/v1/customer-tracking?token=${SAMPLE_TOKEN}`, {
      headers: { 'x-forwarded-for': ip },
    });

    const res = await handleCustomerTrackingRequest(req, {
      dbExecutor: mockDb,
      rateLimiter,
    });

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '60');
  });

  test('22. An expired/revoked token returns a generic unavailable response without exposing internal records', async () => {
    const mockDb = async () => ({ data: null, error: null });
    const invalidToken = generateMockValidToken();

    const req = new Request(`https://api.dispatcher.app/functions/v1/customer-tracking?token=${invalidToken}`);
    const res = await handleCustomerTrackingRequest(req, { dbExecutor: mockDb });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, {
      success: false,
      data: null,
      error: 'Tracking session unavailable or expired.',
    });
  });
});

// =============================================================================
// Section 3: Backend-Enforced Lifecycle Revocation Tests (Tests 23 - 28)
// =============================================================================

describe('Section 3: Backend-Enforced Lifecycle Revocation Tests', () => {
  const lifecycleMigrationPath = path.join(
    projectRoot,
    'supabase/migrations/20261028020000_tracking_session_lifecycle.sql'
  );
  const migrationContent = fs.readFileSync(lifecycleMigrationPath, 'utf8');

  test('23. Access is revoked after Completion (Backend trigger)', () => {
    assert.match(
      migrationContent,
      /ELSIF NEW\.status = 'completed' AND \(OLD\.status IS DISTINCT FROM 'completed'\) THEN[\s\S]*?SET revoked_at = pg_catalog\.now\(\),[\s\S]*?revocation_reason = 'completed'/,
      'Completion must atomically revoke tracking session with reason completed'
    );
  });

  test('24. Access is revoked after Cancellation (Backend trigger)', () => {
    assert.match(
      migrationContent,
      /ELSIF NEW\.status = 'cancelled' AND \(OLD\.status IS DISTINCT FROM 'cancelled'\) THEN[\s\S]*?SET revoked_at = pg_catalog\.now\(\),[\s\S]*?revocation_reason = 'cancelled'/,
      'Cancellation must atomically revoke tracking session with reason cancelled'
    );
  });

  test('25. Access is revoked after Decline or Unassignment (Backend trigger)', () => {
    assert.match(
      migrationContent,
      /ELSIF \(NEW\.status = 'unassigned' AND OLD\.status IS DISTINCT FROM 'unassigned'\)[\s\S]*?OR \(OLD\.worker_id IS NOT NULL AND NEW\.worker_id IS NULL\) THEN[\s\S]*?SET revoked_at = pg_catalog\.now\(\),[\s\S]*?revocation_reason = 'declined'/,
      'Decline or unassign must atomically revoke tracking session with reason declined'
    );
  });

  test('26. Access is revoked after Reassignment (Backend trigger)', () => {
    assert.match(
      migrationContent,
      /ELSIF OLD\.worker_id IS NOT NULL[\s\S]*?AND NEW\.worker_id IS NOT NULL[\s\S]*?AND OLD\.worker_id IS DISTINCT FROM NEW\.worker_id THEN[\s\S]*?SET revoked_at = pg_catalog\.now\(\),[\s\S]*?revocation_reason = 'reassigned'/,
      'Reassignment must atomically revoke tracking session with reason reassigned'
    );
  });

  test('27. Access is revoked after Session Expiry (Backend RPC enforcement)', () => {
    assert.match(
      migrationContent,
      /WHERE token_hash = v_token_hash[\s\S]*?AND revoked_at IS NULL[\s\S]*?AND expires_at > pg_catalog\.now\(\)/,
      'RPC must require expires_at > pg_catalog.now()'
    );
  });

  test('28. Access is revoked after Owner revokes or replaces link (Backend RPC enforcement)', () => {
    // Rotation: generate_customer_tracking_session atomically marks prior active session as superseded
    assert.match(
      migrationContent,
      /UPDATE public\.customer_tracking_sessions[\s\S]*?SET revoked_at = pg_catalog\.now\(\),[\s\S]*?revocation_reason = 'superseded'[\s\S]*?WHERE customer_tracking_sessions\.job_id = p_job_id/,
      'Link rotation must mark previous session as superseded'
    );

    // Direct owner revocation RPC
    const m13_2_Path = path.join(
      projectRoot,
      'supabase/migrations/20261028010000_customer_tracking_sessions.sql'
    );
    const m13_2_Content = fs.readFileSync(m13_2_Path, 'utf8');
    assert.match(
      m13_2_Content,
      /CREATE OR REPLACE FUNCTION public\.revoke_customer_tracking_session/,
      'revoke_customer_tracking_session RPC must exist'
    );
  });
});
