-- =============================================================================
-- Dispatcher Test Suite: 08_customer_tracking.sql
-- Verifies unauthenticated customer tracking protections, field allowlists, and token isolation
-- =============================================================================

BEGIN;
SELECT plan(6);

-- Fixtures Setup
INSERT INTO auth.users (id, email) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
    ('a2222222-2222-2222-2222-222222222222', 'worker-a1@test.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.businesses (id, name, phone, address) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Acme Services', '(555) 019-2834', '100 Service Way')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active, avatar_url) VALUES
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Owner Alpha', 'owner-a@test.com', '555-0101', 'owner', true, NULL),
    ('a2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Alex Technician', 'worker-a1@test.com', '555-0199', 'worker', true, 'https://example.com/alex.jpg')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.jobs (id, business_id, worker_id, customer_name, customer_phone, service, address, notes, status, tracking_token, cancellation_reason) VALUES
    ('aaaaaaaa-9999-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Secret Customer', '555-9999', 'Emergency Plumbing', '742 Evergreen Terrace', 'Gate code is 1234. Customer is VIP.', 'on_the_way', '99999999-9999-9999-9999-999999999999', NULL)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Test 1: Anonymous client cannot read raw jobs table
-- -----------------------------------------------------------------------------
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" = '{"role": "anon"}';

SELECT throws_ok(
    $$SELECT * FROM public.jobs$$,
    '42501', -- Revoked SQL SELECT privilege on jobs
    NULL,
    'Anonymous client direct SELECT on jobs is rejected'
);

-- -----------------------------------------------------------------------------
-- Test 2: Anonymous client cannot read raw job_events table
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$SELECT * FROM public.job_events$$,
    '42501', -- Revoked SQL SELECT privilege on job_events
    NULL,
    'Anonymous client direct SELECT on job_events is rejected'
);

-- -----------------------------------------------------------------------------
-- Test 3: Guessing public job ID via tracking endpoint returns NULL
-- -----------------------------------------------------------------------------
-- Passing the job PK UUID 'aaaaaaaa-9999-aaaa-aaaa-aaaaaaaaaaaa' instead of tracking token
SELECT is(
    (SELECT public.get_customer_tracking_job('aaaaaaaa-9999-aaaa-aaaa-aaaaaaaaaaaa')),
    NULL,
    'Presenting job UUID instead of tracking token returns NULL'
);

-- -----------------------------------------------------------------------------
-- Test 4: Invalid random tracking token returns NULL
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT public.get_customer_tracking_job('00000000-0000-0000-0000-000000000000')),
    NULL,
    'Non-existent tracking token returns NULL'
);

-- -----------------------------------------------------------------------------
-- Test 5: Valid tracking token returns approved allowlist fields
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT public.get_customer_tracking_job('99999999-9999-9999-9999-999999999999') ->> 'status_label'),
    'Technician is on the way',
    'Customer tracking returns friendly translated status label'
);

-- -----------------------------------------------------------------------------
-- Test 6: Sensitive data fields are strictly withheld from tracking response
-- -----------------------------------------------------------------------------
SELECT ok(
    (SELECT 
        (res ? 'notes') = false
        AND (res ? 'customer_phone') = false
        AND (res ? 'customer_name') = false
        AND (res ? 'cancellation_reason') = false
        AND (res ? 'business_id') = false
        AND (res ? 'worker_id') = false
        AND (res ->> 'worker_first_name') = 'Alex'
     FROM (SELECT public.get_customer_tracking_job('99999999-9999-9999-9999-999999999999') AS res) q),
    'Customer tracking response excludes notes, phone, full names, and internal IDs'
);

SELECT * FROM finish();
ROLLBACK;
