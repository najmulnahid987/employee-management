-- =============================================================================
-- Dispatcher Test Suite: 18_security_and_reliability_verification.sql
-- Module: M18.6 — Security and Reliability Verification
-- Verifies:
-- 1. Owner A cannot read Business B jobs (RLS cross-business isolation).
-- 2. Owner A cannot read Business B worker profiles (profile isolation).
-- 3. Worker A cannot read unassigned jobs (worker assignment scoping).
-- 4. Worker A can read assigned jobs (valid worker scoping).
-- 5. Worker A cannot elevate role to owner (mutation guard trigger).
-- 6. Worker A cannot change business_id (tenancy immutability).
-- 7. Terminal jobs cannot transition or reopen (lifecycle immutability).
-- 8. Non-owner cannot invoke cancel_job RPC (role authorization).
-- 9. Anonymous caller cannot read public.jobs table (RLS anon protection).
-- 10. get_customer_tracking_session_job rejects malformed tokens and returns NULL.
-- =============================================================================

BEGIN;
SELECT plan(10);

-- Fixtures Setup
INSERT INTO auth.users (id, email) VALUES
    ('e1111111-1111-1111-1111-111111111111', 'owner-e1@test.com'),
    ('e2222222-2222-2222-2222-222222222222', 'worker-e1@test.com'),
    ('f1111111-1111-1111-1111-111111111111', 'owner-f1@test.com'),
    ('f2222222-2222-2222-2222-222222222222', 'worker-f1@test.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.businesses (id, name, phone, address) VALUES
    ('55555555-5555-5555-5555-555555555555', 'Business Echo', '555-0501', '500 Echo St'),
    ('66666666-6666-6666-6666-666666666666', 'Business Foxtrot', '555-0601', '600 Foxtrot St')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active) VALUES
    ('e1111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', 'Owner Echo', 'owner-e1@test.com', '555-0501', 'owner', true),
    ('e2222222-2222-2222-2222-222222222222', '55555555-5555-5555-5555-555555555555', 'Worker Echo', 'worker-e1@test.com', '555-0502', 'worker', true),
    ('f1111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666', 'Owner Foxtrot', 'owner-f1@test.com', '555-0601', 'owner', true),
    ('f2222222-2222-2222-2222-222222222222', '66666666-6666-6666-6666-666666666666', 'Worker Foxtrot', 'worker-f1@test.com', '555-0602', 'worker', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.jobs (id, business_id, worker_id, customer_name, customer_phone, service, address, status, tracking_token) VALUES
    ('eeeeeeee-0001-0000-0000-000000000001', '55555555-5555-5555-5555-555555555555', NULL, 'Customer Unassigned', '555-5001', 'Echo Unassigned', '501 Echo St', 'unassigned', '00000000-0000-0000-0000-000000000001'),
    ('eeeeeeee-0002-0000-0000-000000000002', '55555555-5555-5555-5555-555555555555', 'e2222222-2222-2222-2222-222222222222', 'Customer Assigned', '555-5002', 'Echo Assigned', '502 Echo St', 'assigned', '00000000-0000-0000-0000-000000000002'),
    ('ffffffff-0001-0000-0000-000000000001', '66666666-6666-6666-6666-666666666666', 'f2222222-2222-2222-2222-222222222222', 'Customer Foxtrot', '555-6001', 'Foxtrot Assigned', '601 Foxtrot St', 'assigned', '00000000-0000-0000-0000-000000000003')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Test 1: Owner Echo cannot read Business Foxtrot jobs
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "e1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.jobs WHERE business_id = '66666666-6666-6666-6666-666666666666'),
    0,
    'Owner Echo cannot read Business Foxtrot jobs'
);

-- -----------------------------------------------------------------------------
-- Test 2: Owner Echo cannot read Business Foxtrot profiles
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM public.profiles WHERE business_id = '66666666-6666-6666-6666-666666666666'),
    0,
    'Owner Echo cannot read Business Foxtrot profiles'
);

-- -----------------------------------------------------------------------------
-- Test 3: Worker Echo cannot read unassigned jobs in Business Echo
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "e2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.jobs WHERE id = 'eeeeeeee-0001-0000-0000-000000000001'),
    0,
    'Worker Echo cannot read unassigned jobs'
);

-- -----------------------------------------------------------------------------
-- Test 4: Worker Echo can read jobs assigned to Worker Echo
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM public.jobs WHERE id = 'eeeeeeee-0002-0000-0000-000000000002'),
    1,
    'Worker Echo can read jobs assigned to them'
);

-- -----------------------------------------------------------------------------
-- Test 5: Worker Echo cannot elevate role to owner
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.profiles SET role = 'owner' WHERE id = 'e2222222-2222-2222-2222-222222222222'$$,
    'P0001',
    'Cannot modify profile role once set',
    'Worker role elevation is rejected by handle_profile_mutation_guard trigger'
);

-- -----------------------------------------------------------------------------
-- Test 6: Worker Echo cannot alter business_id tenancy
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.profiles SET business_id = '66666666-6666-6666-6666-666666666666' WHERE id = 'e2222222-2222-2222-2222-222222222222'$$,
    'P0001',
    'Cannot modify profile business_id once set',
    'Profile business_id tampering is rejected by handle_profile_mutation_guard trigger'
);

-- -----------------------------------------------------------------------------
-- Test 7: Terminal jobs cannot be reopened
-- -----------------------------------------------------------------------------
-- As superuser, set job to completed
RESET ROLE;
UPDATE public.jobs SET status = 'completed', completed_at = now() WHERE id = 'eeeeeeee-0002-0000-0000-000000000002';

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "e1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT throws_ok(
    $$UPDATE public.jobs SET status = 'in_progress' WHERE id = 'eeeeeeee-0002-0000-0000-000000000002'$$,
    'P0001',
    'Cannot transition terminal status',
    'Reopening completed terminal job is strictly rejected'
);

-- -----------------------------------------------------------------------------
-- Test 8: Worker Echo cannot invoke cancel_job RPC
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "e2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT throws_ok(
    $$SELECT public.cancel_job('eeeeeeee-0002-0000-0000-000000000002'::UUID, 'Worker cancelled')$$,
    'P0001',
    'Only business owners can cancel jobs',
    'Worker invoking cancel_job RPC is rejected with owner-only authorization error'
);

-- -----------------------------------------------------------------------------
-- Test 9: Anonymous caller cannot read public.jobs
-- -----------------------------------------------------------------------------
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" = '{"role": "anon"}';

SELECT is(
    (SELECT count(*)::int FROM public.jobs),
    0,
    'Anonymous user has zero SELECT access on public.jobs'
);

-- -----------------------------------------------------------------------------
-- Test 10: get_customer_tracking_session_job rejects malformed tokens
-- -----------------------------------------------------------------------------
SELECT is(
    public.get_customer_tracking_session_job('not-a-valid-hex-token'),
    NULL,
    'get_customer_tracking_session_job returns NULL for malformed token'
);

SELECT * FROM finish();
ROLLBACK;

