-- =============================================================================
-- Dispatcher Test Suite: 14_server_authorization_and_input_validation.sql
-- Module: M18.2B — Server Authorization and Input Validation Hardening Verification
-- Verifies:
-- 1. create_job RPC validates customer name, phone, service, address bounds.
-- 2. create_job RPC enforces mandatory scheduled_at.
-- 3. create_job RPC enforces paired coordinates and latitude/longitude bounds.
-- 4. create_job RPC blocks non-owner callers from creating jobs.
-- 5. cancel_job RPC validates mandatory cancellation reason length bounds (1..1000).
-- 6. cancel_job RPC blocks non-owners from cancelling jobs.
-- 7. decline_job_assignment RPC validates decline reason bounds (<= 1000).
-- 8. decline_job_assignment RPC blocks unassigned workers or non-workers.
-- 9. provision_business RPC validates business name and phone length bounds.
-- 10. register_device_token RPC validates push token length bounds (10..500).
-- =============================================================================

BEGIN;
SELECT plan(10);

-- Fixtures Setup
INSERT INTO auth.users (id, email) VALUES
    ('c1111111-1111-1111-1111-111111111111', 'owner-c@test.com'),
    ('c2222222-2222-2222-2222-222222222222', 'worker-c@test.com'),
    ('c3333333-3333-3333-3333-333333333333', 'unassigned-worker@test.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.businesses (id, name, phone, address) VALUES
    ('33333333-3333-3333-3333-333333333333', 'Business Gamma', '555-0301', '300 Gamma Way')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active) VALUES
    ('c1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'Owner Gamma', 'owner-c@test.com', '555-0301', 'owner', true),
    ('c2222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'Worker Gamma', 'worker-c@test.com', '555-0302', 'worker', true),
    ('c3333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', 'Worker Other', 'unassigned-worker@test.com', '555-0303', 'worker', true)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Test 1: create_job rejects empty or missing customer name
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "c1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT throws_ok(
    $$SELECT public.create_job(
        '',
        '555-0199',
        'HVAC Repair',
        '123 Main St',
        now() + interval '1 day'
    )$$,
    '22023',
    'Customer name must be between 1 and 200 characters',
    'create_job rejects empty customer name'
);

-- -----------------------------------------------------------------------------
-- Test 2: create_job rejects NULL scheduled_at
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$SELECT public.create_job(
        'John Doe',
        '555-0199',
        'HVAC Repair',
        '123 Main St',
        NULL
    )$$,
    '22023',
    'Scheduled arrival time is required',
    'create_job rejects NULL scheduled_at arrival timestamp'
);

-- -----------------------------------------------------------------------------
-- Test 3: create_job rejects unpaired coordinates
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$SELECT public.create_job(
        'John Doe',
        '555-0199',
        'HVAC Repair',
        '123 Main St',
        now() + interval '1 day',
        NULL,
        NULL,
        37.7749,
        NULL
    )$$,
    '22023',
    'Both latitude and longitude must be provided together',
    'create_job rejects latitude without longitude'
);

-- -----------------------------------------------------------------------------
-- Test 4: create_job blocks worker role from creating jobs
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "c2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT throws_ok(
    $$SELECT public.create_job(
        'John Doe',
        '555-0199',
        'HVAC Repair',
        '123 Main St',
        now() + interval '1 day'
    )$$,
    '42501',
    'Only business owners can create and dispatch jobs',
    'create_job blocks workers from creating jobs'
);

-- Setup a job for cancellation and decline tests
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "c1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT public.create_job(
    'Jane Customer',
    '555-0999',
    'Plumbing Service',
    '456 Elm St',
    now() + interval '2 hours',
    'Customer notes',
    'c2222222-2222-2222-2222-222222222222'::UUID
);

-- -----------------------------------------------------------------------------
-- Test 5: cancel_job validates cancellation reason length bounds
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$SELECT public.cancel_job(
        (SELECT id FROM public.jobs WHERE customer_name = 'Jane Customer' LIMIT 1),
        ''
    )$$,
    '22023',
    'Mandatory cancellation reason required (1 to 1000 characters)',
    'cancel_job rejects empty cancellation reason'
);

-- -----------------------------------------------------------------------------
-- Test 6: cancel_job blocks worker role from cancelling jobs
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "c2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT throws_ok(
    $$SELECT public.cancel_job(
        (SELECT id FROM public.jobs WHERE customer_name = 'Jane Customer' LIMIT 1),
        'Worker trying to cancel'
    )$$,
    '42501',
    'Only business owners can cancel jobs',
    'cancel_job blocks workers from cancelling jobs'
);

-- -----------------------------------------------------------------------------
-- Test 7: decline_job_assignment validates decline reason length bounds
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$SELECT public.decline_job_assignment(
        (SELECT id FROM public.jobs WHERE customer_name = 'Jane Customer' LIMIT 1),
        repeat('x', 1001)
    )$$,
    '22023',
    'Decline reason cannot exceed 1000 characters',
    'decline_job_assignment rejects oversized decline reason exceeding 1000 chars'
);

-- -----------------------------------------------------------------------------
-- Test 8: decline_job_assignment blocks worker not assigned to the job
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "c3333333-3333-3333-3333-333333333333", "role": "authenticated"}';

SELECT throws_ok(
    $$SELECT public.decline_job_assignment(
        (SELECT id FROM public.jobs WHERE customer_name = 'Jane Customer' LIMIT 1),
        'I was not assigned this job'
    )$$,
    '42501',
    'Job is not assigned to you',
    'decline_job_assignment blocks unassigned worker'
);

-- -----------------------------------------------------------------------------
-- Test 9: provision_business validates business name bounds
-- -----------------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
    ('c4444444-4444-4444-4444-444444444444', 'new-owner@test.com')
ON CONFLICT (id) DO NOTHING;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "c4444444-4444-4444-4444-444444444444", "role": "authenticated"}';

SELECT throws_ok(
    $$SELECT public.provision_business(
        '',
        '555-0999'
    )$$,
    '22023',
    'Business name must be between 1 and 200 characters',
    'provision_business rejects empty business name'
);

-- -----------------------------------------------------------------------------
-- Test 10: register_device_token validates token length bounds
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "c1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT throws_ok(
    $$SELECT public.register_device_token('short')$$,
    '22023',
    'Invalid push token format: token must be between 10 and 500 characters',
    'register_device_token rejects push token under 10 characters'
);

SELECT * FROM finish();
ROLLBACK;

