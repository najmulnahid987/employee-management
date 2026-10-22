-- =============================================================================
-- Dispatcher Test Suite: 06_locations.sql
-- Verifies GPS telemetry insertion, identity spoofing prevention, and immutability
-- =============================================================================

BEGIN;
SELECT plan(6);

-- Fixtures Setup
INSERT INTO auth.users (id, email) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
    ('a2222222-2222-2222-2222-222222222222', 'worker-a1@test.com'),
    ('a3333333-3333-3333-3333-333333333333', 'worker-a2@test.com'),
    ('b2222222-2222-2222-2222-222222222222', 'worker-b@test.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.businesses (id, name, phone, address) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Business Alpha', '555-0101', '100 Alpha St'),
    ('22222222-2222-2222-2222-222222222222', 'Business Beta', '555-0202', '200 Beta St')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active) VALUES
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Owner Alpha', 'owner-a@test.com', '555-0101', 'owner', true),
    ('a2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Worker Alpha One', 'worker-a1@test.com', '555-0102', 'worker', true),
    ('a3333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Worker Alpha Two', 'worker-a2@test.com', '555-0103', 'worker', true),
    ('b2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Worker Beta', 'worker-b@test.com', '555-0202', 'worker', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.jobs (id, business_id, worker_id, customer_name, customer_phone, service, address, status, tracking_token) VALUES
    ('aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Job Alpha 1', '555-1001', 'Leak Repair', '101 Main St', 'in_progress', '00000000-0000-0000-0000-000000000001'),
    ('aaaaaaaa-2222-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a3333333-3333-3333-3333-333333333333', 'Job Alpha 2', '555-1002', 'Pipe Replacement', '102 Main St', 'in_progress', '00000000-0000-0000-0000-000000000002')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Test 1: Worker A1 can insert valid location for themselves
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

INSERT INTO public.locations (id, worker_id, job_id, latitude, longitude, accuracy)
VALUES ('cccccccc-1111-cccc-cccc-cccccccccccc', 'a2222222-2222-2222-2222-222222222222', 'aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa', 37.7749, -122.4194, 5.0);

SELECT is(
    (SELECT count(*)::int FROM public.locations WHERE id = 'cccccccc-1111-cccc-cccc-cccccccccccc'),
    1,
    'Worker A1 inserts valid GPS telemetry record'
);

-- -----------------------------------------------------------------------------
-- Test 2: Worker A1 CANNOT insert location pretending to be Worker A2 (Spoofing)
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.locations (worker_id, latitude, longitude)
      VALUES ('a3333333-3333-3333-3333-333333333333', 37.7749, -122.4194)$$,
    '42501', -- RLS WITH CHECK policy violation (locations_worker_insert)
    NULL,
    'Worker A1 attempting to spoof worker_id on location INSERT must be rejected'
);

-- -----------------------------------------------------------------------------
-- Test 3: Worker A1 CANNOT link a location to a job assigned to Worker A2
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.locations (worker_id, job_id, latitude, longitude)
      VALUES ('a2222222-2222-2222-2222-222222222222', 'aaaaaaaa-2222-aaaa-aaaa-aaaaaaaaaaaa', 37.7749, -122.4194)$$,
    '42501', -- RLS WITH CHECK policy violation
    NULL,
    'Worker A1 linking location to another workers job must be rejected'
);

-- -----------------------------------------------------------------------------
-- Test 4: Cross-business location reads fail
-- -----------------------------------------------------------------------------
-- Insert location for Worker B as superuser
SET LOCAL ROLE postgres;
INSERT INTO public.locations (id, worker_id, latitude, longitude)
VALUES ('cccccccc-2222-cccc-cccc-cccccccccccc', 'b2222222-2222-2222-2222-222222222222', 40.7128, -74.0060);

-- Authenticate as Owner A
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.locations WHERE id = 'cccccccc-2222-cccc-cccc-cccccccccccc'),
    0,
    'Owner A cannot read locations of workers in Business B'
);

-- -----------------------------------------------------------------------------
-- Test 5: Ordinary clients cannot modify historical location records
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT throws_ok(
    $$UPDATE public.locations SET latitude = 0.0 WHERE id = 'cccccccc-1111-cccc-cccc-cccccccccccc'$$,
    '42501', -- Revoked SQL UPDATE privilege
    NULL,
    'Client attempt to UPDATE location history must be rejected'
);

-- -----------------------------------------------------------------------------
-- Test 6: Ordinary clients cannot DELETE historical location records
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$DELETE FROM public.locations WHERE id = 'cccccccc-1111-cccc-cccc-cccccccccccc'$$,
    '42501', -- Revoked SQL DELETE privilege
    NULL,
    'Client attempt to DELETE location history must be rejected'
);

SELECT * FROM finish();
ROLLBACK;
