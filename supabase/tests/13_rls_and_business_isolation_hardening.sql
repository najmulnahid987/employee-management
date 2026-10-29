-- =============================================================================
-- Dispatcher Test Suite: 13_rls_and_business_isolation_hardening.sql
-- Module: M18.2A — RLS and Business Isolation Security Hardening Verification
-- Verifies:
-- 1. Legacy get_customer_tracking_job(UUID) is dropped.
-- 2. claim_notification_delivery RPC is revoked from authenticated clients.
-- 3. verify_worker_invitation RPC is revoked from anonymous clients.
-- 4. Functional index idx_worker_invitations_upper_code exists.
-- 5. Business mutation guard protects immutable id and created_at.
-- 6. Profile mutation guard blocks modifying worker role once provisioned.
-- 7. Device tokens UPDATE RLS policy prevents altering business_id tenancy.
-- =============================================================================

BEGIN;
SELECT plan(10);

-- Fixtures Setup
INSERT INTO auth.users (id, email) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
    ('a2222222-2222-2222-2222-222222222222', 'worker-a@test.com'),
    ('b1111111-1111-1111-1111-111111111111', 'owner-b@test.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.businesses (id, name, phone, address) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Business Alpha', '555-0101', '100 Alpha St'),
    ('22222222-2222-2222-2222-222222222222', 'Business Beta', '555-0202', '200 Beta St')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active) VALUES
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Owner Alpha', 'owner-a@test.com', '555-0101', 'owner', true),
    ('a2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Worker Alpha', 'worker-a@test.com', '555-0102', 'worker', true),
    ('b1111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Owner Beta', 'owner-b@test.com', '555-0201', 'owner', true)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Test 1: Legacy get_customer_tracking_job(UUID) is completely dropped
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$SELECT public.get_customer_tracking_job('99999999-9999-9999-9999-999999999999'::UUID)$$,
    '42883', -- Undefined function error code
    NULL,
    'Calling dropped legacy get_customer_tracking_job(UUID) raises undefined function exception'
);

-- -----------------------------------------------------------------------------
-- Test 2: Authenticated user cannot execute claim_notification_delivery RPC
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT throws_ok(
    $$SELECT public.claim_notification_delivery(
        '11111111-1111-1111-1111-111111111111'::UUID,
        'a1111111-1111-1111-1111-111111111111'::UUID,
        '11111111-1111-1111-1111-111111111111'::UUID,
        'job_assigned',
        'test-idempotency-key'
    )$$,
    '42501', -- Permission denied error code
    NULL,
    'Authenticated client execution of claim_notification_delivery is rejected with permission denied'
);

-- -----------------------------------------------------------------------------
-- Test 3: Anonymous caller cannot execute verify_worker_invitation RPC
-- -----------------------------------------------------------------------------
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" = '{"role": "anon"}';

SELECT throws_ok(
    $$SELECT public.verify_worker_invitation('DISP-TEST-JOIN')$$,
    '42501', -- Permission denied error code
    NULL,
    'Anonymous execution of verify_worker_invitation is rejected with permission denied'
);

-- -----------------------------------------------------------------------------
-- Test 4: Authenticated user CAN execute verify_worker_invitation RPC
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT is(
    (SELECT (public.verify_worker_invitation('DISP-NONEXISTENT') ->> 'valid')::boolean),
    false,
    'Authenticated client can verify worker invitation code safely'
);

-- -----------------------------------------------------------------------------
-- Test 5: Functional index idx_worker_invitations_upper_code exists
-- -----------------------------------------------------------------------------
SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'worker_invitations'
          AND indexname = 'idx_worker_invitations_upper_code'
    ),
    'Functional index idx_worker_invitations_upper_code exists on worker_invitations'
);

-- -----------------------------------------------------------------------------
-- Test 6: Business table mutation guard prevents altering business ID
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT throws_ok(
    $$UPDATE public.businesses
      SET id = '99999999-9999-9999-9999-999999999999'
      WHERE id = '11111111-1111-1111-1111-111111111111'$$,
    '42501',
    'Business ID cannot be altered',
    'Trigger blocks changing primary key id on public.businesses'
);

-- -----------------------------------------------------------------------------
-- Test 7: Business table mutation guard prevents altering created_at
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.businesses
      SET created_at = '2020-01-01 00:00:00+00'
      WHERE id = '11111111-1111-1111-1111-111111111111'$$,
    '42501',
    'Business created_at cannot be altered',
    'Trigger blocks changing created_at on public.businesses'
);

-- -----------------------------------------------------------------------------
-- Test 8: Profile mutation guard blocks owner from altering worker role once provisioned
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$UPDATE public.profiles
      SET role = 'owner'
      WHERE id = 'a2222222-2222-2222-2222-222222222222'$$,
    '42501',
    NULL,
    'Trigger blocks altering worker role once provisioned'
);

-- -----------------------------------------------------------------------------
-- Test 9: Device tokens UPDATE RLS policy prevents cross-tenant reassignment
-- -----------------------------------------------------------------------------
-- First insert a token for worker A in Business Alpha
INSERT INTO public.device_tokens (
    id, user_id, business_id, expo_push_token, device_platform, is_active
) VALUES (
    'dddddddd-1111-dddd-dddd-dddddddddddd',
    'a2222222-2222-2222-2222-222222222222',
    '11111111-1111-1111-1111-111111111111',
    'ExponentPushToken[worker-a-token-111]',
    'android',
    true
) ON CONFLICT (expo_push_token) DO NOTHING;

-- Worker A attempts to reassign their device token to Business Beta
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT throws_ok(
    $$UPDATE public.device_tokens
      SET business_id = '22222222-2222-2222-2222-222222222222'
      WHERE id = 'dddddddd-1111-dddd-dddd-dddddddddddd'$$,
    '42501', -- RLS WITH CHECK violation
    NULL,
    'RLS policy blocks altering device token business_id to another business tenant'
);

-- -----------------------------------------------------------------------------
-- Test 10: Worker A CAN update their own device token metadata within own business
-- -----------------------------------------------------------------------------
UPDATE public.device_tokens
SET device_name = 'Updated Device Name'
WHERE id = 'dddddddd-1111-dddd-dddd-dddddddddddd';

SELECT is(
    (SELECT device_name FROM public.device_tokens WHERE id = 'dddddddd-1111-dddd-dddd-dddddddddddd'),
    'Updated Device Name',
    'Worker successfully updates device metadata for own token within same business'
);

SELECT * FROM finish();
ROLLBACK;

