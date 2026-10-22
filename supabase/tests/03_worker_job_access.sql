-- =============================================================================
-- Dispatcher Test Suite: 03_worker_job_access.sql
-- Verifies worker job visibility, assignment protection, and column locks
-- =============================================================================

BEGIN;
SELECT plan(8);

-- Fixtures Setup
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

INSERT INTO public.jobs (id, business_id, worker_id, customer_name, customer_phone, service, address, status, tracking_token) VALUES
    ('aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Customer One', '555-1001', 'Pipe Repair', '101 Main St', 'assigned', '00000000-0000-0000-0000-000000000001'),
    ('aaaaaaaa-2222-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a3333333-3333-3333-3333-333333333333', 'Customer Two', '555-1002', 'Wiring Inspection', '102 Main St', 'assigned', '00000000-0000-0000-0000-000000000002'),
    ('aaaaaaaa-3333-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', NULL, 'Customer Three', '555-1003', 'HVAC Check', '103 Main St', 'unassigned', '00000000-0000-0000-0000-000000000003'),
    ('bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', 'Customer Beta', '555-2001', 'Drain Cleaning', '201 Elm St', 'assigned', '00000000-0000-0000-0000-000000000004')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Test 1: Worker A1 can read their own assigned job
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.jobs WHERE id = 'aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa'),
    1,
    'Worker A1 can view a job currently assigned to them'
);

-- -----------------------------------------------------------------------------
-- Test 2: Worker A1 CANNOT read peer Worker A2's private job
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM public.jobs WHERE id = 'aaaaaaaa-2222-aaaa-aaaa-aaaaaaaaaaaa'),
    0,
    'Worker A1 cannot view a job assigned to another technician'
);

-- -----------------------------------------------------------------------------
-- Test 3: Worker A1 CANNOT read unassigned jobs
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM public.jobs WHERE id = 'aaaaaaaa-3333-aaaa-aaaa-aaaaaaaaaaaa'),
    0,
    'Worker A1 cannot view unassigned jobs awaiting owner dispatch'
);

-- -----------------------------------------------------------------------------
-- Test 4: Worker A1 cannot self-assign an unassigned job by updating worker_id
-- -----------------------------------------------------------------------------
UPDATE public.jobs 
SET worker_id = 'a2222222-2222-2222-2222-222222222222', status = 'assigned' 
WHERE id = 'aaaaaaaa-3333-aaaa-aaaa-aaaaaaaaaaaa';

SELECT is(
    (SELECT count(*)::int FROM public.jobs WHERE id = 'aaaaaaaa-3333-aaaa-aaaa-aaaaaaaaaaaa'),
    0,
    'Worker A1 self-assignment update on unassigned job affects 0 rows (denied by RLS)'
);

-- -----------------------------------------------------------------------------
-- Test 5: Worker A1 cannot change customer details or address on assigned job
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.jobs 
      SET customer_name = 'Tampered Customer Name' 
      WHERE id = 'aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa'$$,
    'P0001',
    'Field workers are not permitted to modify job customer or schedule details',
    'Worker A1 update on customer_name must be rejected by trigger'
);

-- -----------------------------------------------------------------------------
-- Test 6: Worker A1 cannot change notes or schedule on assigned job
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.jobs 
      SET notes = 'Worker injected internal notes' 
      WHERE id = 'aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa'$$,
    'P0001',
    'Field workers are not permitted to modify job customer or schedule details',
    'Worker A1 update on notes must be rejected by trigger'
);

-- -----------------------------------------------------------------------------
-- Test 7: Worker A1 cannot change business_id on assigned job
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.jobs 
      SET business_id = '22222222-2222-2222-2222-222222222222' 
      WHERE id = 'aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa'$$,
    'P0001',
    'Job business_id cannot be altered',
    'Worker A1 attempt to alter job business_id must be rejected'
);

-- -----------------------------------------------------------------------------
-- Test 8: Worker A1 cannot modify Business B jobs
-- -----------------------------------------------------------------------------
UPDATE public.jobs 
SET status = 'accepted' 
WHERE id = 'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb';

SELECT is(
    (SELECT status FROM public.jobs WHERE id = 'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb'),
    NULL,
    'Worker A1 update on Business B job affects 0 rows'
);

SELECT * FROM finish();
ROLLBACK;
