-- =============================================================================
-- Dispatcher Test Suite: 07_audit_history_and_subscriptions.sql
-- Verifies append-only audit ledger protection and subscription billing security
-- =============================================================================

BEGIN;
SELECT plan(6);

-- Fixtures Setup
INSERT INTO auth.users (id, email) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
    ('a2222222-2222-2222-2222-222222222222', 'worker-a1@test.com'),
    ('b1111111-1111-1111-1111-111111111111', 'owner-b@test.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.businesses (id, name, phone, address) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Business Alpha', '555-0101', '100 Alpha St'),
    ('22222222-2222-2222-2222-222222222222', 'Business Beta', '555-0202', '200 Beta St')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active) VALUES
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Owner Alpha', 'owner-a@test.com', '555-0101', 'owner', true),
    ('a2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Worker Alpha', 'worker-a1@test.com', '555-0102', 'worker', true),
    ('b1111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Owner Beta', 'owner-b@test.com', '555-0201', 'owner', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.jobs (id, business_id, worker_id, customer_name, customer_phone, service, address, status, tracking_token) VALUES
    ('aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Alpha Job', '555-1001', 'Repair', '100 St', 'assigned', '00000000-0000-0000-0000-000000000001'),
    ('bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', NULL, 'Beta Job', '555-2001', 'Install', '200 St', 'unassigned', '00000000-0000-0000-0000-000000000002')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.subscriptions (business_id, status, stripe_customer_id) VALUES
    ('11111111-1111-1111-1111-111111111111', 'active', 'cus_alpha123'),
    ('22222222-2222-2222-2222-222222222222', 'trialing', 'cus_beta456')
ON CONFLICT (business_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Test 1: Direct client INSERT into job_events is rejected
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT throws_ok(
    $$INSERT INTO public.job_events (job_id, business_id, actor_id, actor_role, event_type)
      VALUES ('aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'system', 'forged_event')$$,
    '42501', -- Revoked SQL INSERT privilege
    NULL,
    'Client cannot directly INSERT into job_events'
);

-- -----------------------------------------------------------------------------
-- Test 2: Users cannot read audit events for unauthorized jobs
-- -----------------------------------------------------------------------------
-- Switch to Worker A1
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.job_events WHERE job_id = 'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb'),
    0,
    'Worker A1 cannot view audit events for Business B jobs'
);

-- -----------------------------------------------------------------------------
-- Test 3: Owner A can read their own business subscription
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT is(
    (SELECT status FROM public.subscriptions WHERE business_id = '11111111-1111-1111-1111-111111111111'),
    'active',
    'Owner A can read Business A subscription status'
);

-- -----------------------------------------------------------------------------
-- Test 4: Worker A CANNOT read business subscription records
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222", "role": "authenticated"}';

SELECT is(
    (SELECT count(*)::int FROM public.subscriptions WHERE business_id = '11111111-1111-1111-1111-111111111111'),
    0,
    'Field worker cannot read business subscription records'
);

-- -----------------------------------------------------------------------------
-- Test 5: Client-side subscription UPDATE is rejected
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT throws_ok(
    $$UPDATE public.subscriptions SET status = 'active' WHERE business_id = '11111111-1111-1111-1111-111111111111'$$,
    '42501', -- Revoked SQL UPDATE privilege
    NULL,
    'Client cannot directly modify subscription status'
);

-- -----------------------------------------------------------------------------
-- Test 6: Client-side subscription INSERT is rejected
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.subscriptions (business_id, status) VALUES ('11111111-1111-1111-1111-111111111111', 'active')$$,
    '42501', -- Revoked SQL INSERT privilege
    NULL,
    'Client cannot directly INSERT into subscriptions'
);

SELECT * FROM finish();
ROLLBACK;
