-- =============================================================================
-- Dispatcher Test Suite: 04_job_lifecycle_security.sql
-- Verifies the frozen 8-status lifecycle progression and trigger enforcement
-- =============================================================================

BEGIN;
SELECT plan(13);

-- Fixtures Setup
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

INSERT INTO public.jobs (id, business_id, worker_id, customer_name, customer_phone, service, address, status, tracking_token) VALUES
    ('aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Customer Lifecycle', '555-0001', 'Full Lifecycle Service', '100 Test St', 'assigned', '00000000-0000-0000-0000-000000000001'),
    ('aaaaaaaa-0002-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Customer Decline', '555-0002', 'Decline Service', '102 Test St', 'assigned', '00000000-0000-0000-0000-000000000002'),
    ('aaaaaaaa-0003-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Customer Cancel', '555-0003', 'Cancel Service', '103 Test St', 'assigned', '00000000-0000-0000-0000-000000000003')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Test 1 to 5: Sequential Field Progression by Assigned Worker
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

-- 1. assigned -> accepted
UPDATE public.jobs SET status = 'accepted' WHERE id = 'aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa';
SELECT is(
    (SELECT status FROM public.jobs WHERE id = 'aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa'),
    'accepted',
    'Worker A1 transitions assigned -> accepted successfully'
);

-- 2. accepted -> on_the_way
UPDATE public.jobs SET status = 'on_the_way' WHERE id = 'aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa';
SELECT is(
    (SELECT status FROM public.jobs WHERE id = 'aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa'),
    'on_the_way',
    'Worker A1 transitions accepted -> on_the_way successfully'
);

-- 3. on_the_way -> arrived
UPDATE public.jobs SET status = 'arrived' WHERE id = 'aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa';
SELECT is(
    (SELECT status FROM public.jobs WHERE id = 'aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa'),
    'arrived',
    'Worker A1 transitions on_the_way -> arrived successfully'
);

-- 4. arrived -> in_progress
UPDATE public.jobs SET status = 'in_progress' WHERE id = 'aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa';
SELECT is(
    (SELECT status FROM public.jobs WHERE id = 'aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa'),
    'in_progress',
    'Worker A1 transitions arrived -> in_progress successfully'
);

-- 5. in_progress -> completed (Terminal)
UPDATE public.jobs SET status = 'completed' WHERE id = 'aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa';
SELECT is(
    (SELECT status FROM public.jobs WHERE id = 'aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa'),
    'completed',
    'Worker A1 transitions in_progress -> completed successfully'
);

-- -----------------------------------------------------------------------------
-- Test 6: Reopening a completed terminal job is strictly forbidden
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.jobs SET status = 'in_progress' WHERE id = 'aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa'$$,
    'P0001',
    'Cannot modify job in terminal status: completed',
    'Reopening a completed job must raise terminal status exception'
);

-- -----------------------------------------------------------------------------
-- Test 7: Worker Decline: assigned -> unassigned clears worker_id
-- -----------------------------------------------------------------------------
UPDATE public.jobs SET status = 'unassigned' WHERE id = 'aaaaaaaa-0002-aaaa-aaaa-aaaaaaaaaaaa';

-- Switch to Owner A to verify the unassigned job (unassigned jobs are visible to Owner, hidden from Workers)
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT ok(
    (SELECT status = 'unassigned' AND worker_id IS NULL 
     FROM public.jobs WHERE id = 'aaaaaaaa-0002-aaaa-aaaa-aaaaaaaaaaaa'),
    'Worker A1 declining assignment transitions to unassigned and clears worker_id (verified by Owner)'
);

-- -----------------------------------------------------------------------------
-- Test 8: Worker attempting out-of-order transition is rejected
-- -----------------------------------------------------------------------------
-- Re-assign Job 2 for illegal skip test
SET LOCAL ROLE postgres;
UPDATE public.jobs SET worker_id = 'a2222222-2222-2222-2222-222222222222', status = 'assigned' WHERE id = 'aaaaaaaa-0002-aaaa-aaaa-aaaaaaaaaaaa';

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT throws_ok(
    $$UPDATE public.jobs SET status = 'completed' WHERE id = 'aaaaaaaa-0002-aaaa-aaaa-aaaaaaaaaaaa'$$,
    'P0001',
    'Illegal worker status transition from assigned to completed',
    'Worker attempting to jump directly from assigned to completed must be rejected'
);

-- -----------------------------------------------------------------------------
-- Test 9: Worker attempting to cancel a job is rejected
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.jobs SET status = 'cancelled', cancellation_reason = 'Worker cancelled' WHERE id = 'aaaaaaaa-0002-aaaa-aaaa-aaaaaaaaaaaa'$$,
    'P0001',
    'Illegal worker status transition from assigned to cancelled',
    'Field worker is not permitted to cancel a service job'
);

-- -----------------------------------------------------------------------------
-- Test 10: Owner cancelling without mandatory reason is rejected
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT throws_ok(
    $$UPDATE public.jobs SET status = 'cancelled', cancellation_reason = '' WHERE id = 'aaaaaaaa-0003-aaaa-aaaa-aaaaaaaaaaaa'$$,
    'P0001',
    'Mandatory cancellation reason required to cancel a job',
    'Owner cancelling without a reason must be rejected'
);

-- -----------------------------------------------------------------------------
-- Test 11: Owner cancelling with valid reason succeeds
-- -----------------------------------------------------------------------------
UPDATE public.jobs 
SET status = 'cancelled', cancellation_reason = 'Customer requested cancellation due to weather' 
WHERE id = 'aaaaaaaa-0003-aaaa-aaaa-aaaaaaaaaaaa';

SELECT is(
    (SELECT status FROM public.jobs WHERE id = 'aaaaaaaa-0003-aaaa-aaaa-aaaaaaaaaaaa'),
    'cancelled',
    'Owner cancellation with non-empty reason succeeds'
);

-- -----------------------------------------------------------------------------
-- Test 12: Cancelled job cannot be modified or reopened
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.jobs SET status = 'assigned' WHERE id = 'aaaaaaaa-0003-aaaa-aaaa-aaaaaaaaaaaa'$$,
    'P0001',
    'Cannot modify job in terminal status: cancelled',
    'Cancelled job is terminal and cannot be reopened'
);

-- -----------------------------------------------------------------------------
-- Test 13: Audit Event Verification: Verify accurate event count and attribution
-- -----------------------------------------------------------------------------
-- Job 1 went: created -> worker_assigned -> accepted -> on_the_way -> arrived -> in_progress -> completed
SELECT is(
    (SELECT count(*)::int FROM public.job_events WHERE job_id = 'aaaaaaaa-0001-aaaa-aaaa-aaaaaaaaaaaa'),
    7,
    'Job 1 generates exactly 7 server-side chronological audit events'
);

SELECT * FROM finish();
ROLLBACK;
