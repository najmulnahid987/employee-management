-- =============================================================================
-- Dispatcher Test Suite: 11_idempotency_race_condition_protection.sql
-- Verifies:
-- 1. Conditional status transitions (p_expected_current_status) against stale screens
-- 2. Idempotent replay protection (repeated calls do not produce duplicate events)
-- 3. Locking & Terminal status immutability
-- =============================================================================

BEGIN;
SELECT plan(12);

-- -----------------------------------------------------------------------------
-- Fixtures Setup
-- -----------------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
    ('a2222222-2222-2222-2222-222222222222', 'worker-a1@test.com'),
    ('a3333333-3333-3333-3333-333333333333', 'worker-a2@test.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.businesses (id, name, phone, address) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Business Alpha', '555-0101', '100 Alpha St')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active) VALUES
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Owner Alpha', 'owner-a@test.com', '555-0101', 'owner', true),
    ('a2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Worker Alpha One', 'worker-a1@test.com', '555-0102', 'worker', true),
    ('a3333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Worker Alpha Two', 'worker-a2@test.com', '555-0103', 'worker', true)
ON CONFLICT (id) DO NOTHING;

-- Initial unassigned test job
INSERT INTO public.jobs (
    id, business_id, worker_id, customer_name, customer_phone, service, address,
    status, tracking_token
) VALUES (
    'cccccccc-0001-cccc-cccc-cccccccccccc',
    '11111111-1111-1111-1111-111111111111',
    NULL,
    'Alice Test',
    '555-0001',
    'Pipe Repair',
    '123 Main St',
    'unassigned',
    '11111111-2222-3333-4444-555555555555'
);

-- -----------------------------------------------------------------------------
-- Test 1 & 2: Conditional Assignment & Stale Status Detection (Owner)
-- -----------------------------------------------------------------------------
-- Authenticate as Owner
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = 'a1111111-1111-1111-1111-111111111111';

-- Stale request: owner thinks job is 'assigned' but it is actually 'unassigned'
SELECT throws_ok(
    $$ SELECT public.assign_job_worker('cccccccc-0001-cccc-cccc-cccccccccccc'::UUID, 'a2222222-2222-2222-2222-222222222222'::UUID, 'assigned') $$,
    'P0001',
    '%Job status has changed%',
    'Test 1: assign_job_worker rejects request when expected status does not match current database status'
);

-- Valid conditional assignment: expected 'unassigned'
SELECT lives_ok(
    $$ SELECT public.assign_job_worker('cccccccc-0001-cccc-cccc-cccccccccccc'::UUID, 'a2222222-2222-2222-2222-222222222222'::UUID, 'unassigned') $$,
    'Test 2: assign_job_worker succeeds when expected status matches'
);

-- -----------------------------------------------------------------------------
-- Test 3: Idempotent Replay for Worker Assignment (Zero Duplicate Events)
-- -----------------------------------------------------------------------------
-- Re-assign to same worker: should succeed idempotently without adding a new job_event
SELECT public.assign_job_worker('cccccccc-0001-cccc-cccc-cccccccccccc'::UUID, 'a2222222-2222-2222-2222-222222222222'::UUID, 'assigned');

SELECT is(
    (SELECT count(*)::int FROM public.job_events WHERE job_id = 'cccccccc-0001-cccc-cccc-cccccccccccc' AND new_status = 'assigned'),
    1,
    'Test 3: Idempotent re-assignment produces zero duplicate job_events'
);

-- -----------------------------------------------------------------------------
-- Test 4, 5, 6: Worker Advance Status & Idempotency
-- -----------------------------------------------------------------------------
-- Authenticate as Worker Alpha One
SET LOCAL "request.jwt.claim.sub" = 'a2222222-2222-2222-2222-222222222222';

-- Stale advance attempt: worker expects 'accepted' but job is still 'assigned'
SELECT throws_ok(
    $$ SELECT public.advance_job_status('cccccccc-0001-cccc-cccc-cccccccccccc'::UUID, 'on_the_way', 'accepted') $$,
    'P0001',
    '%Job status has changed%',
    'Test 4: advance_job_status rejects when expected status does not match database status'
);

-- Valid sequential advance: assigned -> accepted
SELECT lives_ok(
    $$ SELECT public.advance_job_status('cccccccc-0001-cccc-cccc-cccccccccccc'::UUID, 'accepted', 'assigned') $$,
    'Test 5: advance_job_status succeeds for valid sequential status transition'
);

-- Idempotent retry: advance to 'accepted' again (job is already 'accepted')
SELECT lives_ok(
    $$ SELECT public.advance_job_status('cccccccc-0001-cccc-cccc-cccccccccccc'::UUID, 'accepted', 'assigned') $$,
    'Test 6: advance_job_status handles idempotent retry when target status was already reached'
);

-- Verify no duplicate 'accepted' event was generated
SELECT is(
    (SELECT count(*)::int FROM public.job_events WHERE job_id = 'cccccccc-0001-cccc-cccc-cccccccccccc' AND new_status = 'accepted'),
    1,
    'Test 7: Idempotent advance status creates zero duplicate job_events'
);

-- -----------------------------------------------------------------------------
-- Test 8: Locked Field Execution
-- -----------------------------------------------------------------------------
-- Switch back to Owner
SET LOCAL "request.jwt.claim.sub" = 'a1111111-1111-1111-1111-111111111111';

-- Owner cannot reassign or unassign while job is 'accepted' (active field execution)
SELECT throws_ok(
    $$ SELECT public.assign_job_worker('cccccccc-0001-cccc-cccc-cccccccccccc'::UUID, 'a3333333-3333-3333-3333-333333333333'::UUID) $$,
    'P0001',
    '%Worker assignment is locked while job is in active field execution%',
    'Test 8: Owner cannot reassign worker while job is in active field execution'
);

-- -----------------------------------------------------------------------------
-- Test 9 & 10: Cancellation Idempotency
-- -----------------------------------------------------------------------------
-- Owner cancels job
SELECT lives_ok(
    $$ SELECT public.cancel_job('cccccccc-0001-cccc-cccc-cccccccccccc'::UUID, 'Customer called to cancel', 'accepted') $$,
    'Test 9: Owner can cancel non-terminal job with expected status'
);

-- Idempotent repeated cancellation: returns job without error and without duplicate event
SELECT lives_ok(
    $$ SELECT public.cancel_job('cccccccc-0001-cccc-cccc-cccccccccccc'::UUID, 'Customer called to cancel') $$,
    'Test 10: Repeated cancellation is idempotent and does not error'
);

-- Verify only one cancelled event was recorded
SELECT is(
    (SELECT count(*)::int FROM public.job_events WHERE job_id = 'cccccccc-0001-cccc-cccc-cccccccccccc' AND new_status = 'cancelled'),
    1,
    'Test 11: Idempotent cancellation creates zero duplicate job_events'
);

-- -----------------------------------------------------------------------------
-- Test 12: Terminal State Immutability
-- -----------------------------------------------------------------------------
-- Worker cannot advance cancelled job
SET LOCAL "request.jwt.claim.sub" = 'a2222222-2222-2222-2222-222222222222';
SELECT throws_ok(
    $$ SELECT public.advance_job_status('cccccccc-0001-cccc-cccc-cccccccccccc'::UUID, 'on_the_way') $$,
    'P0001',
    '%Job is in terminal status (cancelled) and cannot be modified%',
    'Test 12: Terminal job cannot be modified or advanced'
);

SELECT * FROM finish();
ROLLBACK;
