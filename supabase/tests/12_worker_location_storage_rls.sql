-- =============================================================================
-- Dispatcher Test Suite: 12_worker_location_storage_rls.sql
-- Module: M11.2 — Location Storage and RLS Verification
-- Verifies latest-location-only storage, unique constraints, RLS policies,
-- status eligibility rules, cross-business isolation, and tamper protection.
-- =============================================================================

BEGIN;
SELECT plan(17);

-- -----------------------------------------------------------------------------
-- Fixtures Setup
-- -----------------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
    ('a2222222-2222-2222-2222-222222222222', 'worker-a1@test.com'),
    ('a3333333-3333-3333-3333-333333333333', 'worker-a2@test.com'),
    ('b1111111-1111-1111-1111-111111111111', 'owner-b@test.com'),
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
    ('b1111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Owner Beta', 'owner-b@test.com', '555-0201', 'owner', true),
    ('b2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Worker Beta', 'worker-b@test.com', '555-0202', 'worker', true)
ON CONFLICT (id) DO NOTHING;

-- Jobs fixture across various statuses
INSERT INTO public.jobs (id, business_id, worker_id, customer_name, customer_phone, service, address, status, tracking_token) VALUES
    ('aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Alpha Active 1', '555-1001', 'Leak Repair', '101 Main St', 'in_progress', '00000000-0000-0000-0000-000000000011'),
    ('aaaaaaaa-2222-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a3333333-3333-3333-3333-333333333333', 'Alpha Active 2', '555-1002', 'HVAC Check', '102 Main St', 'on_the_way', '00000000-0000-0000-0000-000000000012'),
    ('aaaaaaaa-3333-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Alpha Accepted', '555-1003', 'Wiring', '103 Main St', 'accepted', '00000000-0000-0000-0000-000000000013'),
    ('aaaaaaaa-4444-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', NULL, 'Alpha Unassigned', '555-1004', 'Filter Change', '104 Main St', 'unassigned', '00000000-0000-0000-0000-000000000014'),
    ('aaaaaaaa-5555-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Alpha Completed', '555-1005', 'Inspection', '105 Main St', 'completed', '00000000-0000-0000-0000-000000000015'),
    ('aaaaaaaa-6666-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Alpha Cancelled', '555-1006', 'Duct Work', '106 Main St', 'cancelled', '00000000-0000-0000-0000-000000000016'),
    ('bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', 'Beta Active', '555-2001', 'Boiler Service', '201 Oak St', 'in_progress', '00000000-0000-0000-0000-000000000021')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Test 1: Worker A1 can insert valid location for assigned active job
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

INSERT INTO public.locations (id, worker_id, job_id, latitude, longitude, accuracy)
VALUES ('cccccccc-1111-cccc-cccc-cccccccccccc', 'a2222222-2222-2222-2222-222222222222', 'aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa', 37.7749, -122.4194, 5.0);

SELECT is(
    (SELECT count(*)::int FROM public.locations WHERE id = 'cccccccc-1111-cccc-cccc-cccccccccccc'),
    1,
    'Worker A1 inserts valid location record for active assigned job'
);

-- -----------------------------------------------------------------------------
-- Test 2: Worker A1 can UPDATE existing location for assigned active job
-- -----------------------------------------------------------------------------
UPDATE public.locations
SET latitude = 37.7750, longitude = -122.4190, accuracy = 4.0
WHERE id = 'cccccccc-1111-cccc-cccc-cccccccccccc';

SELECT is(
    (SELECT latitude FROM public.locations WHERE id = 'cccccccc-1111-cccc-cccc-cccccccccccc'),
    37.7750,
    'Worker A1 successfully updates existing location (latest-location overwrite)'
);

-- -----------------------------------------------------------------------------
-- Test 3: Worker A1 can upsert location via record_worker_location RPC
-- -----------------------------------------------------------------------------
SELECT lives_ok(
    $$SELECT public.record_worker_location('aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 37.7760, -122.4180, 3.5)$$,
    'Worker A1 can record updated location via record_worker_location RPC'
);

SELECT is(
    (SELECT count(*)::int FROM public.locations WHERE worker_id = 'a2222222-2222-2222-2222-222222222222' AND job_id = 'aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa'),
    1,
    'Exactly one current location record is retained per (worker_id, job_id)'
);

-- -----------------------------------------------------------------------------
-- Test 4: Worker A1 CANNOT spoof Worker A2 identity
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.locations (worker_id, job_id, latitude, longitude)
      VALUES ('a3333333-3333-3333-3333-333333333333', 'aaaaaaaa-2222-aaaa-aaaa-aaaaaaaaaaaa', 37.7749, -122.4194)$$,
    '42501',
    NULL,
    'Worker A1 cannot insert location posing as Worker A2'
);

-- -----------------------------------------------------------------------------
-- Test 5: Worker A1 CANNOT write location for a job assigned to Worker A2
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.locations (worker_id, job_id, latitude, longitude)
      VALUES ('a2222222-2222-2222-2222-222222222222', 'aaaaaaaa-2222-aaaa-aaaa-aaaaaaaaaaaa', 37.7749, -122.4194)$$,
    '42501',
    NULL,
    'Worker A1 cannot write location for job assigned to another worker'
);

-- -----------------------------------------------------------------------------
-- Test 6: Worker A1 CANNOT write location for an unassigned job
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.locations (worker_id, job_id, latitude, longitude)
      VALUES ('a2222222-2222-2222-2222-222222222222', 'aaaaaaaa-4444-aaaa-aaaa-aaaaaaaaaaaa', 37.7749, -122.4194)$$,
    '42501',
    NULL,
    'Worker A1 cannot write location for unassigned job'
);

-- -----------------------------------------------------------------------------
-- Test 7: Worker A1 CANNOT write location for job in accepted status (pre-travel)
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.locations (worker_id, job_id, latitude, longitude)
      VALUES ('a2222222-2222-2222-2222-222222222222', 'aaaaaaaa-3333-aaaa-aaaa-aaaaaaaaaaaa', 37.7749, -122.4194)$$,
    '42501',
    NULL,
    'Worker A1 cannot write location before job is on_the_way (accepted status rejected)'
);

-- -----------------------------------------------------------------------------
-- Test 8: Worker A1 CANNOT write location for completed job (terminal)
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.locations (worker_id, job_id, latitude, longitude)
      VALUES ('a2222222-2222-2222-2222-222222222222', 'aaaaaaaa-5555-aaaa-aaaa-aaaaaaaaaaaa', 37.7749, -122.4194)$$,
    '42501',
    NULL,
    'Worker A1 cannot write location for completed terminal job'
);

-- -----------------------------------------------------------------------------
-- Test 9: Worker A1 CANNOT write location for cancelled job (terminal)
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.locations (worker_id, job_id, latitude, longitude)
      VALUES ('a2222222-2222-2222-2222-222222222222', 'aaaaaaaa-6666-aaaa-aaaa-aaaaaaaaaaaa', 37.7749, -122.4194)$$,
    '42501',
    NULL,
    'Worker A1 cannot write location for cancelled terminal job'
);

-- -----------------------------------------------------------------------------
-- Test 10: Worker A1 CANNOT write ambient location with job_id IS NULL
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.locations (worker_id, job_id, latitude, longitude)
      VALUES ('a2222222-2222-2222-2222-222222222222', NULL, 37.7749, -122.4194)$$,
    '42501',
    NULL,
    'Worker A1 cannot write ambient location when job_id is null'
);

-- -----------------------------------------------------------------------------
-- Test 11: Worker A1 CANNOT modify identity fields (worker_id, job_id) on existing record
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.locations
      SET worker_id = 'a3333333-3333-3333-3333-333333333333'
      WHERE id = 'cccccccc-1111-cccc-cccc-cccccccccccc'$$,
    '42501',
    NULL,
    'Trigger forbids modifying worker_id of existing location record'
);

-- -----------------------------------------------------------------------------
-- Test 12: Client applications CANNOT DELETE location records
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$DELETE FROM public.locations WHERE id = 'cccccccc-1111-cccc-cccc-cccccccccccc'$$,
    '42501',
    NULL,
    'Client applications cannot delete location records'
);

-- -----------------------------------------------------------------------------
-- Test 13: Owner A CAN read locations of workers in Business Alpha
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.locations WHERE worker_id = 'a2222222-2222-2222-2222-222222222222'),
    1,
    'Owner Alpha can read location of Worker Alpha One'
);

-- -----------------------------------------------------------------------------
-- Test 14: Cross-business location reads are prevented (Owner A cannot read Worker B)
-- -----------------------------------------------------------------------------
-- First insert location for Worker B as superuser
SET LOCAL ROLE postgres;
INSERT INTO public.locations (id, worker_id, job_id, latitude, longitude)
VALUES ('cccccccc-2222-cccc-cccc-cccccccccccc', 'b2222222-2222-2222-2222-222222222222', 'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb', 40.7128, -74.0060)
ON CONFLICT (worker_id, job_id) DO UPDATE SET latitude = 40.7128, longitude = -74.0060;

-- Authenticate as Owner Alpha
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.locations WHERE id = 'cccccccc-2222-cccc-cccc-cccccccccccc'),
    0,
    'Owner Alpha cannot read location of Worker Beta in Business Beta'
);

-- -----------------------------------------------------------------------------
-- Test 15: Cross-business location reads are prevented (Owner B cannot read Worker A)
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "b1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.locations WHERE id = 'cccccccc-1111-cccc-cccc-cccccccccccc'),
    0,
    'Owner Beta cannot read location of Worker Alpha One in Business Alpha'
);

-- -----------------------------------------------------------------------------
-- Test 16: Anonymous clients are rejected from all table operations
-- -----------------------------------------------------------------------------
SET LOCAL ROLE anon;
SELECT throws_ok(
    $$SELECT * FROM public.locations$$,
    '42501',
    NULL,
    'Anonymous users cannot read locations'
);

-- -----------------------------------------------------------------------------
-- Test 17: Owner A get_owner_active_locations RPC returns Business Alpha active locations
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.get_owner_active_locations()),
    1,
    'Owner Alpha get_owner_active_locations returns active worker location'
);

SELECT * FROM finish();
ROLLBACK;
