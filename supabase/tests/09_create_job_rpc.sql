-- =============================================================================
-- Dispatcher Test Suite: 09_create_job_rpc.sql
-- Verifies the atomic create_job RPC, tenancy isolation, worker validation,
-- and append-only event log generation.
-- =============================================================================

BEGIN;
SELECT plan(11);

-- Fixtures Setup
INSERT INTO auth.users (id, email) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
    ('a2222222-2222-2222-2222-222222222222', 'worker-a1@test.com'),
    ('a3333333-3333-3333-3333-333333333333', 'worker-inactive@test.com'),
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
    ('a3333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Worker Inactive', 'worker-inactive@test.com', '555-0103', 'worker', false),
    ('b1111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Owner Beta', 'owner-b@test.com', '555-0201', 'owner', true),
    ('b2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Worker Beta', 'worker-b@test.com', '555-0202', 'worker', true)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Test 1: Authenticate as Owner Alpha and create an unassigned job
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT ok(
    (SELECT status = 'unassigned' AND worker_id IS NULL AND customer_name = 'Customer One'
     FROM public.create_job(
         'Customer One',
         '555-0100',
         'Plumbing Inspection',
         '101 Alpha St',
         now() + interval '2 hours',
         'Call on arrival'
     )),
    'Owner A creates an unassigned job successfully via atomic RPC'
);

-- -----------------------------------------------------------------------------
-- Test 2: Verify trigger logged job_created event for the unassigned job
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM public.job_events 
     WHERE business_id = '11111111-1111-1111-1111-111111111111'
       AND event_type = 'job_created'
       AND new_status = 'unassigned'
       AND actor_id = 'a1111111-1111-1111-1111-111111111111'),
    1,
    'Database trigger automatically logged job_created event with owner actor attribution'
);

-- -----------------------------------------------------------------------------
-- Test 3: Owner Alpha creates an assigned job with valid worker
-- -----------------------------------------------------------------------------
SELECT ok(
    (SELECT status = 'assigned' AND worker_id = 'a2222222-2222-2222-2222-222222222222' AND assigned_at IS NOT NULL
     FROM public.create_job(
         'Customer Two',
         '+1 (555) 234-5678',
         'Electrical Repair',
         '102 Alpha St',
         now() + interval '3 hours',
         NULL,
         'a2222222-2222-2222-2222-222222222222',
         37.7749,
         -122.4194
     )),
    'Owner A creates an assigned job with coordinates and assigned_at timestamp'
);

-- -----------------------------------------------------------------------------
-- Test 4: Verify both job_created and worker_assigned events were logged
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM public.job_events 
     WHERE business_id = '11111111-1111-1111-1111-111111111111'
       AND event_type = 'worker_assigned'
       AND actor_id = 'a1111111-1111-1111-1111-111111111111'),
    1,
    'Database trigger automatically logged worker_assigned event on atomic creation'
);

-- -----------------------------------------------------------------------------
-- Test 5: Field Worker attempting to call create_job is rejected
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT throws_ok(
    $$SELECT public.create_job(
        'Rogue Customer', '555-9999', 'Rogue Service', '999 Rogue St', now()
    )$$,
    'P0001',
    'Only business owners can create and dispatch jobs',
    'Worker attempting to invoke create_job is denied by authorization check'
);

-- -----------------------------------------------------------------------------
-- Test 6: Unauthenticated anonymous caller is rejected
-- -----------------------------------------------------------------------------
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" = '';

SELECT throws_ok(
    $$SELECT public.create_job(
        'Anon Customer', '555-0000', 'Anon Service', '000 Anon St', now()
    )$$,
    '42501',
    NULL,
    'Anonymous caller cannot execute create_job (revoked privilege)'
);

-- -----------------------------------------------------------------------------
-- Test 7: Cross-tenant worker assignment attempt is rejected
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT throws_ok(
    $$SELECT public.create_job(
        'Customer Cross', '555-1234', 'Cross Service', '103 Alpha St', now(),
        NULL, 'b2222222-2222-2222-2222-222222222222'
    )$$,
    'P0001',
    'Assigned worker must belong to the same business',
    'Attempting to assign a worker from Business B is rejected'
);

-- -----------------------------------------------------------------------------
-- Test 8: Assigning an inactive worker is rejected
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$SELECT public.create_job(
        'Customer Inactive', '555-1234', 'Service', '104 Alpha St', now(),
        NULL, 'a3333333-3333-3333-3333-333333333333'
    )$$,
    'P0001',
    'Cannot assign an inactive worker',
    'Attempting to assign an inactive worker profile is rejected'
);

-- -----------------------------------------------------------------------------
-- Test 9: Blank customer name is rejected
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$SELECT public.create_job(
        '   ', '555-1234', 'Service', '105 Alpha St', now()
    )$$,
    'P0001',
    'Customer name is required',
    'Whitespace customer name is rejected'
);

-- -----------------------------------------------------------------------------
-- Test 10: Empty notes stored as NULL without crashing
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT notes FROM public.create_job(
        'Customer Notes', '555-7777', 'Plumbing', '106 Alpha St', now(), '   '
    )),
    NULL,
    'Empty or whitespace notes are stored as NULL'
);

-- -----------------------------------------------------------------------------
-- Test 11: Owner Beta cannot read Owner Alpha jobs
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "b1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.jobs WHERE business_id = '11111111-1111-1111-1111-111111111111'),
    0,
    'Owner Beta cannot read jobs created in Business Alpha'
);

SELECT * FROM finish();
ROLLBACK;
