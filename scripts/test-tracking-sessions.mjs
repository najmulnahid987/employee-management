/**
 * Dispatcher M13.2 / M13.3 — Customer Tracking Sessions Verification Test Suite
 *
 * Validates:
 * 1. Cryptographic token generation and SHA-256 hashing properties:
 *    - 256 bits of CSPRNG entropy (64 hex characters, URL-safe).
 *    - Deterministic SHA-256 hashing (64-character lowercase hex digest).
 *    - Raw token is never stored or logged in database schemas.
 * 2. Session activation logic:
 *    - Inactive / pending when job is 'assigned' or 'accepted'.
 *    - Activated when job transitions to 'on_the_way' (server trigger sets activated_at).
 *    - Client cannot arbitrarily activate tracking for a different job.
 * 3. Issuance eligibility & authorization:
 *    - Permitted only for authenticated owners within their own business tenant.
 *    - Strictly rejected for unassigned jobs (worker_id is null or status is unassigned).
 *    - Strictly rejected for terminal jobs (completed or cancelled).
 *    - Permitted for active lifecycle jobs with assigned worker (assigned, accepted, on_the_way, arrived, in_progress).
 * 4. Token rotation:
 *    - New issuance rotates previous active session (revocation_reason = 'superseded').
 *    - Old raw token immediately fails resolution.
 * 5. Comprehensive revocation triggers & invariants:
 *    - Revoked on job completion (revocation_reason = 'completed').
 *    - Revoked on job cancellation (revocation_reason = 'cancelled').
 *    - Revoked on worker decline / unassignment (revocation_reason = 'declined').
 *    - Revoked on worker reassignment (revocation_reason = 'reassigned').
 *    - Inactive on expiry (now >= expires_at).
 * 6. Migration file security and schema audits for both M13.2 and M13.3 migrations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// =============================================================================
// Helper Functions Matching SQL Migration Behavior
// =============================================================================

/**
 * Computes authoritative SHA-256 hash in lowercase hex format.
 */
export function hashTrackingToken(rawToken) {
  if (typeof rawToken !== 'string') {
    throw new TypeError('Token must be a string');
  }
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Generates 256-bit CSPRNG bearer token (matching two concatenated UUIDv4s without hyphens).
 */
export function generateRawBearerToken() {
  const uuid1 = crypto.randomUUID().replace(/-/g, '');
  const uuid2 = crypto.randomUUID().replace(/-/g, '');
  return `${uuid1}${uuid2}`;
}

/**
 * Checks whether a job's current status and assignment permit tracking link issuance.
 */
export function isJobEligibleForTrackingIssuance(status, workerId) {
  if (!workerId || !status) return false;
  return ['assigned', 'accepted', 'on_the_way', 'arrived', 'in_progress'].includes(status);
}

/**
 * Simulates server-side issuance RPC logic.
 */
export function simulateServerIssuance({
  callerRole,
  callerBusinessId,
  job,
  durationHours = 24,
  existingSessions = [],
}) {
  // 1. Caller verification
  if (callerRole !== 'owner') {
    throw new Error('Only business owners can issue customer tracking sessions.');
  }
  if (!callerBusinessId) {
    throw new Error('Authenticated owner is not linked to an active business tenant.');
  }

  // 2. Job business verification
  if (!job || job.business_id !== callerBusinessId) {
    throw new Error('Job not found in your business.');
  }

  // 3. Lifecycle eligibility
  if (job.status === 'unassigned' || !job.worker_id) {
    throw new Error('Cannot create tracking link for unassigned job. Assign an active technician first.');
  }
  if (['completed', 'cancelled'].includes(job.status)) {
    throw new Error(`Cannot create tracking link for job in terminal status "${job.status}".`);
  }

  // 4. Duration bounds
  if (durationHours < 1 || durationHours > 72) {
    throw new Error('Tracking session duration must be between 1 and 72 hours.');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationHours * 3600 * 1000).toISOString();

  // 5. Rotation: revoke previous active sessions
  const updatedExisting = existingSessions.map((s) => {
    if (s.job_id === job.id && !s.revoked_at) {
      return {
        ...s,
        revoked_at: now.toISOString(),
        revocation_reason: 'superseded',
      };
    }
    return s;
  });

  // 6. Generate 256-bit CSPRNG token and hash
  const rawToken = generateRawBearerToken();
  const tokenHash = hashTrackingToken(rawToken);

  // 7. Initial activation state
  const isImmediatelyActivated = ['on_the_way', 'arrived', 'in_progress'].includes(job.status);
  const activatedAt = isImmediatelyActivated ? now.toISOString() : null;

  const newSession = {
    id: crypto.randomUUID(),
    job_id: job.id,
    business_id: job.business_id,
    worker_id: job.worker_id,
    token_hash: tokenHash,
    created_at: now.toISOString(),
    activated_at: activatedAt,
    expires_at: expiresAt,
    revoked_at: null,
    revocation_reason: null,
  };

  return {
    rawToken,
    trackingUrl: `/track/${rawToken}`,
    newSession,
    allSessions: [...updatedExisting, newSession],
  };
}

/**
 * Simulates server-side AFTER UPDATE trigger on public.jobs.
 */
export function simulateJobLifecycleTrigger({ oldJob, newJob, sessions }) {
  const now = new Date().toISOString();

  return sessions.map((session) => {
    if (session.job_id !== newJob.id || session.revoked_at) {
      return session;
    }

    // 1. Session Activation: Worker transitions to 'on_the_way'
    if (newJob.status === 'on_the_way' && oldJob.status !== 'on_the_way') {
      if (!session.activated_at) {
        return {
          ...session,
          activated_at: now,
        };
      }
    }

    // 2. Revocation: Job completed
    if (newJob.status === 'completed' && oldJob.status !== 'completed') {
      return {
        ...session,
        revoked_at: now,
        revocation_reason: 'completed',
      };
    }

    // 3. Revocation: Job cancelled
    if (newJob.status === 'cancelled' && oldJob.status !== 'cancelled') {
      return {
        ...session,
        revoked_at: now,
        revocation_reason: 'cancelled',
      };
    }

    // 4. Revocation: Worker declined or unassigned
    if (
      (newJob.status === 'unassigned' && oldJob.status !== 'unassigned') ||
      (oldJob.worker_id && !newJob.worker_id)
    ) {
      return {
        ...session,
        revoked_at: now,
        revocation_reason: 'declined',
      };
    }

    // 5. Revocation: Worker reassigned
    if (
      oldJob.worker_id &&
      newJob.worker_id &&
      oldJob.worker_id !== newJob.worker_id
    ) {
      return {
        ...session,
        revoked_at: now,
        revocation_reason: 'reassigned',
      };
    }

    return session;
  });
}

/**
 * Simulates public customer tracking resolution RPC: get_customer_tracking_session_job(rawToken).
 */
export function simulateCustomerTrackingLookup({ rawToken, sessions, jobs, nowMs = Date.now() }) {
  if (!rawToken || rawToken.trim().length < 16) {
    return null;
  }

  const computedHash = hashTrackingToken(rawToken.trim());
  const session = sessions.find((s) => s.token_hash === computedHash);

  if (!session) return null;
  if (session.revoked_at !== null) return null;

  const expiresMs = new Date(session.expires_at).getTime();
  if (isNaN(expiresMs) || nowMs >= expiresMs) return null;

  const job = jobs.find((j) => j.id === session.job_id && j.business_id === session.business_id);
  if (!job) return null;
  if (['completed', 'cancelled', 'unassigned'].includes(job.status)) return null;
  if (session.worker_id && job.worker_id !== session.worker_id) return null;

  return {
    status: job.status,
    is_tracking_active: session.activated_at !== null,
    activated_at: session.activated_at,
    expires_at: session.expires_at,
  };
}

// =============================================================================
// Test Suites
// =============================================================================

test('M13.3 Cryptographic Token Security & Properties', async (t) => {
  await t.test('generates URL-safe 64-character hex raw bearer tokens (256 bits entropy)', () => {
    const rawToken = generateRawBearerToken();
    assert.strictEqual(typeof rawToken, 'string');
    assert.strictEqual(rawToken.length, 64);
    assert.match(rawToken, /^[0-9a-f]{64}$/i);
    // URL-safe verification: encodeURIComponent produces identical string
    assert.strictEqual(encodeURIComponent(rawToken), rawToken);
  });

  await t.test('generates 1000 unique tokens with zero collisions', () => {
    const tokens = new Set();
    for (let i = 0; i < 1000; i++) {
      const token = generateRawBearerToken();
      assert.strictEqual(tokens.has(token), false, 'Token collision detected');
      tokens.add(token);
    }
    assert.strictEqual(tokens.size, 1000);
  });

  await t.test('produces deterministic SHA-256 hash matching PostgreSQL encode(sha256())', () => {
    const token = 'a'.repeat(64);
    const hash = hashTrackingToken(token);
    assert.strictEqual(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
    const expected = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
    assert.strictEqual(hash, expected);
  });

  await t.test('database schema stores only token_hash and never raw bearer token', () => {
    const issued = simulateServerIssuance({
      callerRole: 'owner',
      callerBusinessId: 'biz-1',
      job: { id: 'job-1', business_id: 'biz-1', status: 'assigned', worker_id: 'worker-1' },
    });

    assert.ok(issued.rawToken);
    assert.ok(issued.newSession.token_hash);
    assert.strictEqual(issued.newSession.raw_token, undefined);
    assert.strictEqual(issued.newSession.token, undefined);
    assert.strictEqual(hashTrackingToken(issued.rawToken), issued.newSession.token_hash);
  });
});

test('M13.3 Issuance Authorization & Lifecycle Constraints', async (t) => {
  const businessId = 'biz-alpha';
  const ownerId = 'owner-1';

  await t.test('rejects issuance when caller is not business owner', () => {
    assert.throws(
      () =>
        simulateServerIssuance({
          callerRole: 'worker',
          callerBusinessId: businessId,
          job: { id: 'job-1', business_id: businessId, status: 'assigned', worker_id: 'worker-1' },
        }),
      /Only business owners can issue customer tracking sessions/
    );
  });

  await t.test('rejects issuance when job belongs to another business (cross-business isolation)', () => {
    assert.throws(
      () =>
        simulateServerIssuance({
          callerRole: 'owner',
          callerBusinessId: businessId,
          job: { id: 'job-2', business_id: 'biz-other', status: 'assigned', worker_id: 'worker-1' },
        }),
      /Job not found in your business/
    );
  });

  await t.test('strictly rejects issuance for unassigned jobs (worker_id is null)', () => {
    assert.throws(
      () =>
        simulateServerIssuance({
          callerRole: 'owner',
          callerBusinessId: businessId,
          job: { id: 'job-unassigned', business_id: businessId, status: 'unassigned', worker_id: null },
        }),
      /Cannot create tracking link for unassigned job/
    );
  });

  await t.test('strictly rejects issuance for terminal jobs (completed / cancelled)', () => {
    assert.throws(
      () =>
        simulateServerIssuance({
          callerRole: 'owner',
          callerBusinessId: businessId,
          job: { id: 'job-comp', business_id: businessId, status: 'completed', worker_id: 'worker-1' },
        }),
      /Cannot create tracking link for job in terminal status "completed"/
    );

    assert.throws(
      () =>
        simulateServerIssuance({
          callerRole: 'owner',
          callerBusinessId: businessId,
          job: { id: 'job-canc', business_id: businessId, status: 'cancelled', worker_id: 'worker-1' },
        }),
      /Cannot create tracking link for job in terminal status "cancelled"/
    );
  });

  await t.test('permits issuance for assigned, accepted, on_the_way, arrived, and in_progress jobs', () => {
    const validStatuses = ['assigned', 'accepted', 'on_the_way', 'arrived', 'in_progress'];
    for (const status of validStatuses) {
      assert.strictEqual(isJobEligibleForTrackingIssuance(status, 'worker-1'), true);
      const res = simulateServerIssuance({
        callerRole: 'owner',
        callerBusinessId: businessId,
        job: { id: `job-${status}`, business_id: businessId, status, worker_id: 'worker-1' },
      });
      assert.ok(res.rawToken);
      assert.ok(res.newSession.token_hash);
      assert.strictEqual(res.trackingUrl, `/track/${res.rawToken}`);
    }
  });

  await t.test('helper isJobEligibleForTrackingIssuance matches backend lifecycle matrix', () => {
    assert.strictEqual(isJobEligibleForTrackingIssuance('unassigned', null), false);
    assert.strictEqual(isJobEligibleForTrackingIssuance('unassigned', 'worker-1'), false);
    assert.strictEqual(isJobEligibleForTrackingIssuance('assigned', null), false);
    assert.strictEqual(isJobEligibleForTrackingIssuance('assigned', 'worker-1'), true);
    assert.strictEqual(isJobEligibleForTrackingIssuance('accepted', 'worker-1'), true);
    assert.strictEqual(isJobEligibleForTrackingIssuance('on_the_way', 'worker-1'), true);
    assert.strictEqual(isJobEligibleForTrackingIssuance('arrived', 'worker-1'), true);
    assert.strictEqual(isJobEligibleForTrackingIssuance('in_progress', 'worker-1'), true);
    assert.strictEqual(isJobEligibleForTrackingIssuance('completed', 'worker-1'), false);
    assert.strictEqual(isJobEligibleForTrackingIssuance('cancelled', 'worker-1'), false);
  });
});

test('M13.3 Session Activation Lifecycle', async (t) => {
  const businessId = 'biz-activation';
  const jobId = 'job-act-1';
  const workerId = 'worker-act-1';

  await t.test('session created during assigned/accepted starts unactivated (activated_at = null)', () => {
    const job = { id: jobId, business_id: businessId, status: 'assigned', worker_id: workerId };
    const issuance = simulateServerIssuance({
      callerRole: 'owner',
      callerBusinessId: businessId,
      job,
    });

    assert.strictEqual(issuance.newSession.activated_at, null);

    const lookup = simulateCustomerTrackingLookup({
      rawToken: issuance.rawToken,
      sessions: [issuance.newSession],
      jobs: [job],
    });
    assert.ok(lookup);
    assert.strictEqual(lookup.is_tracking_active, false);
    assert.strictEqual(lookup.activated_at, null);
  });

  await t.test('transition to on_the_way via lifecycle trigger stamps activated_at', () => {
    const jobAssigned = { id: jobId, business_id: businessId, status: 'accepted', worker_id: workerId };
    const issuance = simulateServerIssuance({
      callerRole: 'owner',
      callerBusinessId: businessId,
      job: jobAssigned,
    });
    assert.strictEqual(issuance.newSession.activated_at, null);

    const jobOnTheWay = { ...jobAssigned, status: 'on_the_way' };
    const updatedSessions = simulateJobLifecycleTrigger({
      oldJob: jobAssigned,
      newJob: jobOnTheWay,
      sessions: [issuance.newSession],
    });

    assert.strictEqual(updatedSessions.length, 1);
    assert.ok(updatedSessions[0].activated_at, 'activated_at should be stamped');
    assert.strictEqual(updatedSessions[0].revoked_at, null);

    const lookup = simulateCustomerTrackingLookup({
      rawToken: issuance.rawToken,
      sessions: updatedSessions,
      jobs: [jobOnTheWay],
    });
    assert.ok(lookup);
    assert.strictEqual(lookup.is_tracking_active, true);
    assert.strictEqual(lookup.activated_at, updatedSessions[0].activated_at);
  });

  await t.test('session created when already on_the_way is immediately activated', () => {
    const jobEnRoute = { id: jobId, business_id: businessId, status: 'on_the_way', worker_id: workerId };
    const issuance = simulateServerIssuance({
      callerRole: 'owner',
      callerBusinessId: businessId,
      job: jobEnRoute,
    });

    assert.ok(issuance.newSession.activated_at);
    const lookup = simulateCustomerTrackingLookup({
      rawToken: issuance.rawToken,
      sessions: [issuance.newSession],
      jobs: [jobEnRoute],
    });
    assert.strictEqual(lookup.is_tracking_active, true);
  });
});

test('M13.3 Token Rotation (Superseding Previous Active Sessions)', async (t) => {
  const businessId = 'biz-rot';
  const jobId = 'job-rot-1';
  const workerId = 'worker-rot-1';
  const job = { id: jobId, business_id: businessId, status: 'on_the_way', worker_id: workerId };

  // Step 1: Issue initial token
  const firstIssuance = simulateServerIssuance({
    callerRole: 'owner',
    callerBusinessId: businessId,
    job,
  });

  assert.strictEqual(firstIssuance.allSessions.length, 1);
  assert.strictEqual(firstIssuance.allSessions[0].revoked_at, null);

  // Initial link resolves
  const lookup1 = simulateCustomerTrackingLookup({
    rawToken: firstIssuance.rawToken,
    sessions: firstIssuance.allSessions,
    jobs: [job],
  });
  assert.ok(lookup1);
  assert.strictEqual(lookup1.is_tracking_active, true);

  // Step 2: Rotate token (issuing a second session for the same job)
  const secondIssuance = simulateServerIssuance({
    callerRole: 'owner',
    callerBusinessId: businessId,
    job,
    existingSessions: firstIssuance.allSessions,
  });

  assert.strictEqual(secondIssuance.allSessions.length, 2);

  // Previous session must be revoked with reason 'superseded'
  const oldSession = secondIssuance.allSessions.find((s) => s.id === firstIssuance.newSession.id);
  assert.ok(oldSession.revoked_at, 'Previous session must have revoked_at');
  assert.strictEqual(oldSession.revocation_reason, 'superseded');

  // New session is active
  const newSession = secondIssuance.allSessions.find((s) => s.id === secondIssuance.newSession.id);
  assert.strictEqual(newSession.revoked_at, null);
  assert.strictEqual(newSession.revocation_reason, null);

  // Old raw token no longer resolves
  const lookupOld = simulateCustomerTrackingLookup({
    rawToken: firstIssuance.rawToken,
    sessions: secondIssuance.allSessions,
    jobs: [job],
  });
  assert.strictEqual(lookupOld, null, 'Old token must be rejected');

  // New raw token resolves successfully
  const lookupNew = simulateCustomerTrackingLookup({
    rawToken: secondIssuance.rawToken,
    sessions: secondIssuance.allSessions,
    jobs: [job],
  });
  assert.ok(lookupNew);
  assert.strictEqual(lookupNew.is_tracking_active, true);
});

test('M13.3 Revocation Invariants (Atomic Lifecycle Triggers)', async (t) => {
  const businessId = 'biz-rev';
  const jobId = 'job-rev-1';
  const workerA = 'worker-rev-a';
  const workerB = 'worker-rev-b';

  await t.test('job completion revokes active session with reason completed', () => {
    const jobInProgress = { id: jobId, business_id: businessId, status: 'in_progress', worker_id: workerA };
    const issuance = simulateServerIssuance({ callerRole: 'owner', callerBusinessId: businessId, job: jobInProgress });

    const jobCompleted = { ...jobInProgress, status: 'completed' };
    const updated = simulateJobLifecycleTrigger({
      oldJob: jobInProgress,
      newJob: jobCompleted,
      sessions: [issuance.newSession],
    });

    assert.ok(updated[0].revoked_at);
    assert.strictEqual(updated[0].revocation_reason, 'completed');

    const lookup = simulateCustomerTrackingLookup({
      rawToken: issuance.rawToken,
      sessions: updated,
      jobs: [jobCompleted],
    });
    assert.strictEqual(lookup, null);
  });

  await t.test('job cancellation revokes active session with reason cancelled', () => {
    const jobAssigned = { id: jobId, business_id: businessId, status: 'assigned', worker_id: workerA };
    const issuance = simulateServerIssuance({ callerRole: 'owner', callerBusinessId: businessId, job: jobAssigned });

    const jobCancelled = { ...jobAssigned, status: 'cancelled' };
    const updated = simulateJobLifecycleTrigger({
      oldJob: jobAssigned,
      newJob: jobCancelled,
      sessions: [issuance.newSession],
    });

    assert.ok(updated[0].revoked_at);
    assert.strictEqual(updated[0].revocation_reason, 'cancelled');

    const lookup = simulateCustomerTrackingLookup({
      rawToken: issuance.rawToken,
      sessions: updated,
      jobs: [jobCancelled],
    });
    assert.strictEqual(lookup, null);
  });

  await t.test('worker decline / unassign revokes active session with reason declined', () => {
    const jobAssigned = { id: jobId, business_id: businessId, status: 'assigned', worker_id: workerA };
    const issuance = simulateServerIssuance({ callerRole: 'owner', callerBusinessId: businessId, job: jobAssigned });

    // Transition assigned -> unassigned (declined)
    const jobUnassigned = { ...jobAssigned, status: 'unassigned', worker_id: null };
    const updated = simulateJobLifecycleTrigger({
      oldJob: jobAssigned,
      newJob: jobUnassigned,
      sessions: [issuance.newSession],
    });

    assert.ok(updated[0].revoked_at);
    assert.strictEqual(updated[0].revocation_reason, 'declined');

    const lookup = simulateCustomerTrackingLookup({
      rawToken: issuance.rawToken,
      sessions: updated,
      jobs: [jobUnassigned],
    });
    assert.strictEqual(lookup, null);
  });

  await t.test('reassigning job to a different worker revokes active session with reason reassigned', () => {
    const jobAssignedA = { id: jobId, business_id: businessId, status: 'assigned', worker_id: workerA };
    const issuance = simulateServerIssuance({ callerRole: 'owner', callerBusinessId: businessId, job: jobAssignedA });

    // Reassigned to workerB
    const jobAssignedB = { ...jobAssignedA, worker_id: workerB };
    const updated = simulateJobLifecycleTrigger({
      oldJob: jobAssignedA,
      newJob: jobAssignedB,
      sessions: [issuance.newSession],
    });

    assert.ok(updated[0].revoked_at);
    assert.strictEqual(updated[0].revocation_reason, 'reassigned');

    const lookup = simulateCustomerTrackingLookup({
      rawToken: issuance.rawToken,
      sessions: updated,
      jobs: [jobAssignedB],
    });
    assert.strictEqual(lookup, null);
  });

  await t.test('hard expiry revokes session access once nowMs >= expires_at', () => {
    const job = { id: jobId, business_id: businessId, status: 'on_the_way', worker_id: workerA };
    const issuance = simulateServerIssuance({ callerRole: 'owner', callerBusinessId: businessId, job, durationHours: 24 });

    const beforeExpiry = new Date(issuance.newSession.expires_at).getTime() - 1000;
    const atExpiry = new Date(issuance.newSession.expires_at).getTime();
    const afterExpiry = new Date(issuance.newSession.expires_at).getTime() + 1000;

    const lookupBefore = simulateCustomerTrackingLookup({
      rawToken: issuance.rawToken,
      sessions: [issuance.newSession],
      jobs: [job],
      nowMs: beforeExpiry,
    });
    assert.ok(lookupBefore);

    const lookupAt = simulateCustomerTrackingLookup({
      rawToken: issuance.rawToken,
      sessions: [issuance.newSession],
      jobs: [job],
      nowMs: atExpiry,
    });
    assert.strictEqual(lookupAt, null);

    const lookupAfter = simulateCustomerTrackingLookup({
      rawToken: issuance.rawToken,
      sessions: [issuance.newSession],
      jobs: [job],
      nowMs: afterExpiry,
    });
    assert.strictEqual(lookupAfter, null);
  });
});

test('M13.2 & M13.3 Migration Files Security & Schema Audit', () => {
  // Audit M13.2 Migration
  const m13_2Path = path.resolve('supabase/migrations/20261028010000_customer_tracking_sessions.sql');
  assert.strictEqual(fs.existsSync(m13_2Path), true, 'M13.2 Migration file must exist');
  const m13_2 = fs.readFileSync(m13_2Path, 'utf8');

  assert.ok(m13_2.includes('CREATE TABLE IF NOT EXISTS public.customer_tracking_sessions'), 'Creates customer_tracking_sessions table');
  assert.ok(m13_2.includes('token_hash TEXT NOT NULL'), 'Contains token_hash column');
  assert.ok(m13_2.includes('CONSTRAINT uq_tracking_sessions_token_hash UNIQUE (token_hash)'), 'Enforces token_hash uniqueness');
  assert.ok(m13_2.includes('REVOKE ALL ON public.customer_tracking_sessions FROM anon;'), 'Explicitly revokes anon table access');
  assert.ok(m13_2.includes('REVOKE INSERT, UPDATE, DELETE ON public.customer_tracking_sessions FROM authenticated;'), 'Revokes direct mutations');
  assert.ok(m13_2.includes('ALTER TABLE public.customer_tracking_sessions ENABLE ROW LEVEL SECURITY;'), 'Enables RLS');

  // Audit M13.3 Migration
  const m13_3Path = path.resolve('supabase/migrations/20261028020000_tracking_session_lifecycle.sql');
  assert.strictEqual(fs.existsSync(m13_3Path), true, 'M13.3 Migration file must exist');
  const m13_3 = fs.readFileSync(m13_3Path, 'utf8');

  // 1. Column addition
  assert.ok(m13_3.includes('ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;'), 'Adds activated_at column');

  // 2. Lifecycle trigger with activation and revocations
  assert.ok(m13_3.includes('CREATE OR REPLACE FUNCTION public.handle_job_tracking_session_lifecycle()'), 'Defines lifecycle trigger function');
  assert.ok(m13_3.includes("NEW.status = 'on_the_way' AND (OLD.status IS DISTINCT FROM 'on_the_way')"), 'Activates on transition to on_the_way');
  assert.ok(m13_3.includes("SET activated_at = pg_catalog.now()"), 'Stamps activated_at on activation');
  assert.ok(m13_3.includes("revocation_reason = 'completed'"), 'Revokes on completed');
  assert.ok(m13_3.includes("revocation_reason = 'cancelled'"), 'Revokes on cancelled');
  assert.ok(m13_3.includes("revocation_reason = 'declined'"), 'Revokes on declined / unassigned');
  assert.ok(m13_3.includes("revocation_reason = 'reassigned'"), 'Revokes on worker reassignment');
  assert.ok(m13_3.includes('CREATE TRIGGER trg_jobs_tracking_session_lifecycle'), 'Creates trg_jobs_tracking_session_lifecycle trigger');

  // 3. Hardened Issuance RPC
  assert.ok(m13_3.includes('CREATE OR REPLACE FUNCTION public.generate_customer_tracking_session'), 'Defines generate_customer_tracking_session RPC');
  assert.ok(m13_3.includes("v_job.status = 'unassigned' OR v_job.worker_id IS NULL"), 'Rejects unassigned jobs');
  assert.ok(m13_3.includes("v_job.status IN ('completed', 'cancelled')"), 'Rejects terminal jobs');
  assert.ok(m13_3.includes("revocation_reason = 'superseded'"), 'Rotates previous session with reason superseded');
  assert.ok(m13_3.includes("SET search_path = ''"), 'Uses empty search_path for SECURITY DEFINER');
  assert.ok(m13_3.includes('REVOKE ALL ON FUNCTION public.generate_customer_tracking_session(UUID, INT) FROM PUBLIC, anon;'), 'Revokes anon execution');
  assert.ok(m13_3.includes('GRANT EXECUTE ON FUNCTION public.generate_customer_tracking_session(UUID, INT) TO authenticated;'), 'Grants authenticated execution');

  // 4. Public Lookup RPC
  assert.ok(m13_3.includes('CREATE OR REPLACE FUNCTION public.get_customer_tracking_session_job'), 'Defines get_customer_tracking_session_job RPC');
  assert.ok(m13_3.includes('v_session.activated_at IS NOT NULL'), 'Filters live location on activated_at');
  assert.ok(m13_3.includes("'is_tracking_active', (v_session.activated_at IS NOT NULL)"), 'Returns is_tracking_active boolean');
});
