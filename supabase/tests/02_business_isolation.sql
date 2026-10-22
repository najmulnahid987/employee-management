-- =============================================================================
-- Dispatcher Test Suite: 02_business_isolation.sql
-- Verifies strict multi-tenant business boundary enforcement
-- =============================================================================

BEGIN;
SELECT plan(8);

-- -----------------------------------------------------------------------------
-- Fixtures Setup (Superuser Mode)
-- -----------------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
    ('a2222222-2222-2222-2222-222222222222', 'worker-a1@test.com'),
    ('b1111111-1111-1111-1111-111111111111', 'owner-b@test.com'),
    ('b2222222-2222-2222-2222-222222222222', 'worker-b@test.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.businesses (id, name, phone, address) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Business Alpha', '555-0101', '100 Alpha St'),
    ('22222222-2222-2222-2222-222222222222', 'Business Beta', '555-0202', '200 Beta St')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active) VALUES
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Owner Alpha', 'owner-a@test.com', '555-0101', 'owner', true),
    ('a2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Worker Alpha', 'worker-a1@test.com', '555-0102', 'worker', true),
    ('b1111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Owner Beta', 'owner-b@test.com', '555-0201', 'owner', true),
    ('b2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Worker Beta', 'worker-b@test.com', '555-0202', 'worker', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.jobs (id, business_id, worker_id, customer_name, customer_phone, service, address, status, tracking_token) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Customer A', '555-1001', 'Alpha Service', '101 Alpha St', 'assigned', '00000000-0000-0000-0000-000000000001'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', 'Customer B', '555-2001', 'Beta Service', '201 Beta St', 'assigned', '00000000-0000-0000-0000-000000000002')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Test 1: Owner A reads Business A rows
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.jobs WHERE business_id = '11111111-1111-1111-1111-111111111111'),
    1,
    'Owner A can read jobs belonging to Business A'
);

-- -----------------------------------------------------------------------------
-- Test 2: Owner A CANNOT read Business B jobs (returns 0)
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM public.jobs WHERE business_id = '22222222-2222-2222-2222-222222222222'),
    0,
    'Owner A cannot read jobs belonging to Business B'
);

-- -----------------------------------------------------------------------------
-- Test 3: Owner A CANNOT read Business B profiles
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM public.profiles WHERE business_id = '22222222-2222-2222-2222-222222222222'),
    0,
    'Owner A cannot read profiles belonging to Business B'
);

-- -----------------------------------------------------------------------------
-- Test 4: Owner A cannot modify Business B's jobs
-- -----------------------------------------------------------------------------
UPDATE public.jobs 
SET notes = 'Malicious cross-tenant note' 
WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

SELECT is(
    (SELECT notes FROM public.jobs WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
    NULL,
    'Owner A update on Business B job must affect 0 rows'
);

-- -----------------------------------------------------------------------------
-- Test 5: Owner A cannot assign a worker belonging to Business B
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.jobs 
      SET worker_id = 'b2222222-2222-2222-2222-222222222222', status = 'assigned' 
      WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
    'P0001',
    'Assigned worker must belong to the same business',
    'Owner A assigning a worker from Business B must be rejected by lifecycle trigger'
);

-- -----------------------------------------------------------------------------
-- Test 6: Worker A cannot read Business B jobs
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.jobs WHERE business_id = '22222222-2222-2222-2222-222222222222'),
    0,
    'Worker A cannot read jobs belonging to Business B'
);

-- -----------------------------------------------------------------------------
-- Test 7: Worker A cannot read Business B locations
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM public.locations WHERE worker_id = 'b2222222-2222-2222-2222-222222222222'),
    0,
    'Worker A cannot read locations of workers in Business B'
);

-- -----------------------------------------------------------------------------
-- Test 8: Owner A cannot spoof business_id when inserting a new job
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT throws_ok(
    $$INSERT INTO public.jobs (
        business_id, customer_name, customer_phone, service, address, status
      ) VALUES (
        '22222222-2222-2222-2222-222222222222', 'Spoofed Customer', '555-9999', 'Spoofed Service', '999 Spoof Ave', 'unassigned'
      )$$,
    '42501', -- RLS WITH CHECK policy violation
    NULL,
    'Inserting job with spoofed business_id must be rejected by RLS WITH CHECK'
);

SELECT * FROM finish();
ROLLBACK;
