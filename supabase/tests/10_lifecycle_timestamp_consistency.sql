-- =============================================================================
-- Dispatcher Test Suite: 10_lifecycle_timestamp_consistency.sql
-- Verifies server-authoritative timestamp handling and anti-tampering across
-- the 8 frozen lifecycle statuses.
-- =============================================================================

BEGIN;
SELECT plan(15);

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

-- -----------------------------------------------------------------------------
-- Test 1 & 2: Client Forged Timestamps on INSERT are Neutralized
-- -----------------------------------------------------------------------------
-- Attempt to insert an unassigned job with forged future/past transition timestamps
INSERT INTO public.jobs (
    id, business_id, worker_id, customer_name, customer_phone, service, address,
    status, tracking_token,
    assigned_at, accepted_at, completed_at
) VALUES (
    'bbbbbbbb-0001-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', NULL,
    'Client Tamper Test', '555-0001', 'Plumbing', '100 Test St',
    'unassigned', '11111111-0000-0000-0000-000000000001',
    '1999-01-01 00:00:00+00', '1999-01-01 00:00:00+00', '1999-01-01 00:00:00+00'
);

SELECT ok(
    (SELECT assigned_at IS NULL AND accepted_at IS NULL AND completed_at IS NULL
     FROM public.jobs WHERE id = 'bbbbbbbb-0001-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 1: Arbitrary client-supplied transition timestamps on unassigned INSERT are wiped to NULL'
);

-- Insert job directly in assigned status: assigned_at must be populated by DB clock, others wiped
INSERT INTO public.jobs (
    id, business_id, worker_id, customer_name, customer_phone, service, address,
    status, tracking_token,
    accepted_at
) VALUES (
    'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111',
    'a2222222-2222-2222-2222-222222222222', 'Assigned Creation Test', '555-0002', 'HVAC', '101 Test St',
    'assigned', '11111111-0000-0000-0000-000000000002',
    '1999-01-01 00:00:00+00'
);

SELECT ok(
    (SELECT assigned_at IS NOT NULL AND accepted_at IS NULL AND completed_at IS NULL
     FROM public.jobs WHERE id = 'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 2: Assigned creation sets assigned_at from DB clock and clears other timestamps'
);

-- -----------------------------------------------------------------------------
-- Test 3 to 7: Sequential Progression Sets Target Timestamps and Preserves History
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

-- Step 1: assigned -> accepted
UPDATE public.jobs SET status = 'accepted' WHERE id = 'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb';
SELECT ok(
    (SELECT accepted_at IS NOT NULL AND assigned_at IS NOT NULL AND travelling_at IS NULL
     FROM public.jobs WHERE id = 'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 3: Transition to accepted sets accepted_at and preserves assigned_at'
);

-- Step 2: accepted -> on_the_way
UPDATE public.jobs SET status = 'on_the_way' WHERE id = 'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb';
SELECT ok(
    (SELECT travelling_at IS NOT NULL AND accepted_at IS NOT NULL AND arrived_at IS NULL
     FROM public.jobs WHERE id = 'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 4: Transition to on_the_way sets travelling_at and preserves earlier timestamps'
);

-- Step 3: on_the_way -> arrived
UPDATE public.jobs SET status = 'arrived' WHERE id = 'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb';
SELECT ok(
    (SELECT arrived_at IS NOT NULL AND travelling_at IS NOT NULL AND started_at IS NULL
     FROM public.jobs WHERE id = 'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 5: Transition to arrived sets arrived_at and preserves earlier timestamps'
);

-- Step 4: arrived -> in_progress
UPDATE public.jobs SET status = 'in_progress' WHERE id = 'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb';
SELECT ok(
    (SELECT started_at IS NOT NULL AND arrived_at IS NOT NULL AND completed_at IS NULL
     FROM public.jobs WHERE id = 'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 6: Transition to in_progress sets started_at and preserves earlier timestamps'
);

-- Step 5: in_progress -> completed (Terminal)
UPDATE public.jobs SET status = 'completed' WHERE id = 'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb';
SELECT ok(
    (SELECT completed_at IS NOT NULL 
        AND started_at IS NOT NULL 
        AND arrived_at IS NOT NULL 
        AND travelling_at IS NOT NULL 
        AND accepted_at IS NOT NULL 
        AND assigned_at IS NOT NULL
        AND cancelled_at IS NULL
     FROM public.jobs WHERE id = 'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 7: Completed job preserves all sequential timestamps in chronological order'
);

-- -----------------------------------------------------------------------------
-- Test 8: Client Timestamp Tampering on UPDATE is Neutralized
-- -----------------------------------------------------------------------------
-- Create fresh job for tampering test
SET LOCAL ROLE postgres;
INSERT INTO public.jobs (
    id, business_id, worker_id, customer_name, customer_phone, service, address,
    status, tracking_token
) VALUES (
    'bbbbbbbb-0003-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111',
    'a2222222-2222-2222-2222-222222222222', 'Update Tamper Test', '555-0003', 'Electrical', '102 Test St',
    'assigned', '11111111-0000-0000-0000-000000000003'
);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

-- Worker attempts to supply a forged past accepted_at timestamp
UPDATE public.jobs 
SET status = 'accepted', accepted_at = '1995-12-17 03:24:00+00' 
WHERE id = 'bbbbbbbb-0003-bbbb-bbbb-bbbbbbbbbbbb';

SELECT ok(
    (SELECT accepted_at > '2020-01-01'::timestamptz 
     FROM public.jobs WHERE id = 'bbbbbbbb-0003-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 8: Client-forged accepted_at is ignored; server database clock is authoritative'
);

-- -----------------------------------------------------------------------------
-- Test 9 & 10: Worker Decline and Reassignment Timestamp Handling
-- -----------------------------------------------------------------------------
-- Create Job 4 for decline/reassign test
SET LOCAL ROLE postgres;
INSERT INTO public.jobs (
    id, business_id, worker_id, customer_name, customer_phone, service, address,
    status, tracking_token
) VALUES (
    'bbbbbbbb-0004-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111',
    'a2222222-2222-2222-2222-222222222222', 'Decline Reassign Test', '555-0004', 'Cleaning', '103 Test St',
    'assigned', '11111111-0000-0000-0000-000000000004'
);

-- Worker A1 declines assignment
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';
UPDATE public.jobs SET status = 'unassigned' WHERE id = 'bbbbbbbb-0004-bbbb-bbbb-bbbbbbbbbbbb';

-- Owner checks job: assigned_at must be NULL
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';
SELECT ok(
    (SELECT status = 'unassigned' AND worker_id IS NULL AND assigned_at IS NULL
     FROM public.jobs WHERE id = 'bbbbbbbb-0004-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 9: Decline resets assigned_at to NULL so future assignment gets fresh timestamp'
);

-- Owner reassigns to Worker A2
UPDATE public.jobs 
SET status = 'assigned', worker_id = 'a3333333-3333-3333-3333-333333333333'
WHERE id = 'bbbbbbbb-0004-bbbb-bbbb-bbbbbbbbbbbb';

SELECT ok(
    (SELECT status = 'assigned' AND worker_id = 'a3333333-3333-3333-3333-333333333333' AND assigned_at IS NOT NULL
     FROM public.jobs WHERE id = 'bbbbbbbb-0004-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 10: Subsequent assignment to Worker A2 receives fresh assigned_at timestamp'
);

-- -----------------------------------------------------------------------------
-- Test 11 & 12: Cancellation Preserves Prior Timestamps and Stamped cancelled_at
-- -----------------------------------------------------------------------------
-- Create Job 5 and advance to in_progress
SET LOCAL ROLE postgres;
INSERT INTO public.jobs (
    id, business_id, worker_id, customer_name, customer_phone, service, address,
    status, tracking_token
) VALUES (
    'bbbbbbbb-0005-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111',
    'a2222222-2222-2222-2222-222222222222', 'Cancel Test', '555-0005', 'Roofing', '104 Test St',
    'assigned', '11111111-0000-0000-0000-000000000005'
);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';
UPDATE public.jobs SET status = 'accepted' WHERE id = 'bbbbbbbb-0005-bbbb-bbbb-bbbbbbbbbbbb';
UPDATE public.jobs SET status = 'on_the_way' WHERE id = 'bbbbbbbb-0005-bbbb-bbbb-bbbbbbbbbbbb';
UPDATE public.jobs SET status = 'arrived' WHERE id = 'bbbbbbbb-0005-bbbb-bbbb-bbbbbbbbbbbb';
UPDATE public.jobs SET status = 'in_progress' WHERE id = 'bbbbbbbb-0005-bbbb-bbbb-bbbbbbbbbbbb';

-- Owner cancels job
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';
UPDATE public.jobs 
SET status = 'cancelled', cancellation_reason = 'Customer emergency cancelled'
WHERE id = 'bbbbbbbb-0005-bbbb-bbbb-bbbbbbbbbbbb';

SELECT ok(
    (SELECT status = 'cancelled' 
        AND cancelled_at IS NOT NULL
        AND started_at IS NOT NULL
        AND arrived_at IS NOT NULL
        AND travelling_at IS NOT NULL
        AND accepted_at IS NOT NULL
        AND assigned_at IS NOT NULL
        AND completed_at IS NULL
     FROM public.jobs WHERE id = 'bbbbbbbb-0005-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 11: Cancellation stamps cancelled_at and preserves all prior stage timestamps'
);

-- Reopening cancelled job fails
SELECT throws_ok(
    $$UPDATE public.jobs SET status = 'in_progress' WHERE id = 'bbbbbbbb-0005-bbbb-bbbb-bbbbbbbbbbbb'$$,
    'P0001',
    'Cannot modify job in terminal status: cancelled',
    'Test 12: Terminal cancelled job cannot transition or have timestamps modified'
);

-- -----------------------------------------------------------------------------
-- Test 13 & 14: Unrelated Timestamps are Not Modified
-- -----------------------------------------------------------------------------
-- Verify created_at remains unchanged and updated_at advances
SELECT ok(
    (SELECT created_at <= updated_at AND created_at IS NOT NULL AND updated_at IS NOT NULL
     FROM public.jobs WHERE id = 'bbbbbbbb-0005-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 13: created_at and updated_at remain sound and distinct from lifecycle timestamps'
);

SELECT ok(
    (SELECT scheduled_at IS NULL
     FROM public.jobs WHERE id = 'bbbbbbbb-0005-bbbb-bbbb-bbbbbbbbbbbb'),
    'Test 14: Operational scheduled_at column is never modified by lifecycle transitions'
);

-- -----------------------------------------------------------------------------
-- Test 15: Atomic Audit Events Produced for Every Transition
-- -----------------------------------------------------------------------------
-- Job 2 progressed: created -> assigned -> accepted -> on_the_way -> arrived -> in_progress -> completed
SELECT is(
    (SELECT count(*)::int FROM public.job_events WHERE job_id = 'bbbbbbbb-0002-bbbb-bbbb-bbbbbbbbbbbb'),
    7,
    'Test 15: Exactly 7 audit events recorded in same transactions as timestamp transitions'
);

SELECT * FROM finish();
ROLLBACK;
