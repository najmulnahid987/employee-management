-- =============================================================================
-- Dispatcher Test Suite: 05_profiles_and_roles.sql
-- Verifies profile protection, role immutability, and tenant membership locking
-- =============================================================================

BEGIN;
SELECT plan(12);

-- Fixtures Setup
INSERT INTO auth.users (id, email) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
    ('a2222222-2222-2222-2222-222222222222', 'worker-a1@test.com'),
    ('a3333333-3333-3333-3333-333333333333', 'worker-a2@test.com'),
    ('b1111111-1111-1111-1111-111111111111', 'owner-b@test.com'),
    ('c1111111-1111-1111-1111-111111111111', 'new-owner@test.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.businesses (id, name, phone, address) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Business Alpha', '555-0101', '100 Alpha St'),
    ('22222222-2222-2222-2222-222222222222', 'Business Beta', '555-0202', '200 Beta St')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active) VALUES
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Owner Alpha', 'owner-a@test.com', '555-0101', 'owner', true),
    ('a2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Worker Alpha One', 'worker-a1@test.com', '555-0102', 'worker', true),
    ('a3333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Worker Alpha Two', 'worker-a2@test.com', '555-0103', 'worker', true),
    ('b1111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Owner Beta', 'owner-b@test.com', '555-0201', 'owner', true)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Test 1: Worker A1 attempting to elevate role to 'owner' is rejected
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT throws_ok(
    $$UPDATE public.profiles 
      SET role = 'owner' 
      WHERE id = 'a2222222-2222-2222-2222-222222222222'$$,
    '42501', -- RLS WITH CHECK policy violation (profiles_self_update)
    NULL,
    'Worker self-promotion to owner must be rejected by RLS WITH CHECK'
);

-- -----------------------------------------------------------------------------
-- Test 2: Worker A1 attempting to switch business_id is rejected
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.profiles 
      SET business_id = '22222222-2222-2222-2222-222222222222' 
      WHERE id = 'a2222222-2222-2222-2222-222222222222'$$,
    '42501', -- RLS WITH CHECK policy violation
    NULL,
    'Worker attempt to alter business_id must be rejected by RLS WITH CHECK'
);

-- -----------------------------------------------------------------------------
-- Test 3: Worker A1 CANNOT read peer Worker A2's private profile
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM public.profiles WHERE id = 'a3333333-3333-3333-3333-333333333333'),
    0,
    'Worker A1 cannot view the private profile of peer Worker A2'
);

-- -----------------------------------------------------------------------------
-- Test 4: Worker A1 CAN read Owner A's profile for business communication
-- -----------------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM public.profiles WHERE id = 'a1111111-1111-1111-1111-111111111111'),
    1,
    'Worker A1 can view the business owner profile for team contact'
);

-- -----------------------------------------------------------------------------
-- Test 5: Worker A1 can update personal contact details
-- -----------------------------------------------------------------------------
UPDATE public.profiles 
SET full_name = 'Alex Alpha Renamed', phone = '555-9999' 
WHERE id = 'a2222222-2222-2222-2222-222222222222';

SELECT is(
    (SELECT full_name FROM public.profiles WHERE id = 'a2222222-2222-2222-2222-222222222222'),
    'Alex Alpha Renamed',
    'Worker A1 can update personal non-sensitive fields'
);

-- -----------------------------------------------------------------------------
-- Test 6: Owner A cannot transfer worker to another business
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT throws_ok(
    $$UPDATE public.profiles 
      SET business_id = '22222222-2222-2222-2222-222222222222' 
      WHERE id = 'a2222222-2222-2222-2222-222222222222'$$,
    '42501', -- RLS WITH CHECK policy violation (profiles_owner_worker_update)
    NULL,
    'Owner cannot alter a worker profile business_id'
);

-- -----------------------------------------------------------------------------
-- Test 7: Direct client INSERT into profiles is rejected (revoked privilege)
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.profiles (id, business_id, full_name, email, role) 
      VALUES ('c1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Rogue User', 'rogue@test.com', 'owner')$$,
    '42501', -- permission denied for table profiles
    NULL,
    'Direct client INSERT on public.profiles must be rejected'
);

-- -----------------------------------------------------------------------------
-- Test 8: Direct client INSERT into businesses is rejected (revoked privilege)
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.businesses (id, name, phone) 
      VALUES ('99999999-9999-9999-9999-999999999999', 'Rogue Corp', '555-0000')$$,
    '42501', -- permission denied for table businesses
    NULL,
    'Direct client INSERT on public.businesses must be rejected'
);

-- -----------------------------------------------------------------------------
-- Test 9: An unauthenticated user cannot provision a business
-- -----------------------------------------------------------------------------
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" = '';

SELECT throws_ok(
    $$SELECT public.provision_business('Unauth Corp', '555-1111')$$,
    '42501', -- permission denied for function provision_business
    NULL,
    'Unauthenticated callers cannot execute provision_business'
);

-- -----------------------------------------------------------------------------
-- Test 10: New authenticated user provisions a business and owner profile
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "c1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT lives_ok(
    $$SELECT public.provision_business('Omega Services', '555-9000', '500 Omega Way', 'New Owner')$$,
    'New authenticated user can provision a business and owner profile'
);

-- -----------------------------------------------------------------------------
-- Test 11: Repeated provisioning by the same user is rejected
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$SELECT public.provision_business('Omega Duplicate', '555-9001')$$,
    'P0001', -- user-defined exception: User profile already exists
    'User profile already exists and cannot provision a new business',
    'Repeated provisioning by an existing profile must be rejected'
);

-- -----------------------------------------------------------------------------
-- Test 12: An authenticated user cannot overwrite another user''s profile
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.profiles
      SET full_name = 'Hacked Name'
      WHERE id = 'a1111111-1111-1111-1111-111111111111'$$,
    '42501', -- RLS WITH CHECK policy violation (profiles_self_update)
    NULL,
    'User cannot update or overwrite another user''s profile'
);

SELECT * FROM finish();
ROLLBACK;
