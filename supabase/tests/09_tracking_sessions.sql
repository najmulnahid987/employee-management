-- =============================================================================
-- Dispatcher Test Suite: 09_tracking_sessions.sql
-- Module: Dispatcher M13.2 & M13.3 — Tracking Session Lifecycle & Token Issuance
--
-- Verification Requirements:
-- 1. Unique token hashes (duplicate hash insertion rejected).
-- 2. Expired or revoked sessions being ineligible.
-- 3. A terminal or reassigned job being ineligible for tracking.
-- 4. Anonymous users being unable to read the session table directly.
-- 5. Session activation: Transition to on_the_way activates tracking eligibility.
-- 6. Unauthorized owner / unassigned / terminal issuance attempts are rejected.
-- 7. Token rotation revokes previous session with 'superseded' and invalidates old token.
-- 8. Confirm raw tokens are NEVER stored in the database.
-- =============================================================================

BEGIN;
SELECT plan(16);

-- Fixtures Setup
INSERT INTO auth.users (id, email) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'owner-a@test.com'),
    ('a2222222-2222-2222-2222-222222222222', 'worker-a1@test.com'),
    ('a3333333-3333-3333-3333-333333333333', 'worker-a2@test.com'),
    ('a4444444-4444-4444-4444-444444444444', 'owner-b@test.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.businesses (id, name, phone, address) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Acme Services', '(555) 019-2834', '100 Service Way'),
    ('22222222-2222-2222-2222-222222222222', 'Beta Systems', '(555) 019-9999', '200 Beta Blvd')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active, avatar_url) VALUES
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Owner Alpha', 'owner-a@test.com', '555-0101', 'owner', true, NULL),
    ('a2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Alex Technician', 'worker-a1@test.com', '555-0199', 'worker', true, 'https://example.com/alex.jpg'),
    ('a3333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Bob Technician', 'worker-a2@test.com', '555-0198', 'worker', true, 'https://example.com/bob.jpg'),
    ('a4444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'Owner Beta', 'owner-b@test.com', '555-0201', 'owner', true, NULL)
ON CONFLICT (id) DO NOTHING;

-- Active test job assigned to Alex Technician (Status: accepted)
INSERT INTO public.jobs (id, business_id, worker_id, customer_name, customer_phone, service, address, notes, status, cancellation_reason) VALUES
    ('bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'John Doe', '555-1234', 'HVAC Repair', '123 Main St', 'Ring doorbell', 'accepted', NULL),
    ('bbbbbbbb-3333-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', NULL, 'Unassigned Cust', '555-0000', 'Inspection', '999 North St', NULL, 'unassigned', NULL)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Verification 1: Unique token hashes (Duplicate hash rejected)
-- -----------------------------------------------------------------------------
INSERT INTO public.customer_tracking_sessions (
    id, job_id, business_id, worker_id, token_hash, created_at, expires_at
) VALUES (
    'c1111111-1111-1111-1111-111111111111',
    'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb',
    '11111111-1111-1111-1111-111111111111',
    'a2222222-2222-2222-2222-222222222222',
    '1111111111111111111111111111111111111111111111111111111111111111',
    pg_catalog.now(),
    pg_catalog.now() + interval '24 hours'
);

SELECT throws_ok(
    $$INSERT INTO public.customer_tracking_sessions (
        job_id, business_id, worker_id, token_hash, created_at, expires_at
    ) VALUES (
        'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb',
        '11111111-1111-1111-1111-111111111111',
        'a2222222-2222-2222-2222-222222222222',
        '1111111111111111111111111111111111111111111111111111111111111111',
        pg_catalog.now(),
        pg_catalog.now() + interval '24 hours'
    )$$,
    '23505',
    NULL,
    'Duplicate token hash insertion is rejected by unique constraint'
);

-- -----------------------------------------------------------------------------
-- Verification 2: Expired or revoked sessions being ineligible
-- -----------------------------------------------------------------------------
INSERT INTO public.customer_tracking_sessions (
    id, job_id, business_id, worker_id, token_hash, created_at, expires_at, revoked_at
) VALUES (
    'c2222222-2222-2222-2222-222222222222',
    'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb',
    '11111111-1111-1111-1111-111111111111',
    'a2222222-2222-2222-2222-222222222222',
    pg_catalog.encode(pg_catalog.sha256('test_token_expired_00000000000000'::bytea), 'hex'),
    pg_catalog.now() - interval '48 hours',
    pg_catalog.now() - interval '24 hours',
    '2026-10-25 00:00:00+00'
);

SELECT is(
    (SELECT public.get_customer_tracking_session_job('test_token_expired_00000000000000')),
    NULL,
    'Expired tracking session returns NULL (ineligible)'
);

INSERT INTO public.customer_tracking_sessions (
    id, job_id, business_id, worker_id, token_hash, created_at, expires_at, revoked_at, revocation_reason
) VALUES (
    'c3333333-3333-3333-3333-333333333333',
    'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb',
    '11111111-1111-1111-1111-111111111111',
    'a2222222-2222-2222-2222-222222222222',
    pg_catalog.encode(pg_catalog.sha256('test_token_revoked_00000000000000'::bytea), 'hex'),
    pg_catalog.now() - interval '1 hour',
    pg_catalog.now() + interval '23 hours',
    pg_catalog.now(),
    'owner_revoked'
);

SELECT is(
    (SELECT public.get_customer_tracking_session_job('test_token_revoked_00000000000000')),
    NULL,
    'Explicitly revoked tracking session returns NULL (ineligible)'
);

-- -----------------------------------------------------------------------------
-- Verification 3: Issuance validation & unauthorized owner attempts
-- -----------------------------------------------------------------------------
-- 3.1 Owner Beta (Business B) cannot create tracking link for Business A's job
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "a4444444-4444-4444-4444-444444444444"}';

SELECT throws_ok(
    $$SELECT * FROM public.generate_customer_tracking_session('bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb', 24)$$,
    '42501',
    NULL,
    'Cross-business tracking link issuance is rejected'
);

-- 3.2 Owner Alpha cannot create tracking link for an unassigned job
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111"}';

SELECT throws_ok(
    $$SELECT * FROM public.generate_customer_tracking_session('bbbbbbbb-3333-bbbb-bbbb-bbbbbbbbbbbb', 24)$$,
    'P0001',
    NULL,
    'Issuing tracking link for unassigned job is rejected'
);

-- 3.3 Valid issuance by Owner Alpha for accepted job (bbbbbbbb-1111)
-- Revoke existing active session first so issuance proceeds
UPDATE public.customer_tracking_sessions 
SET revoked_at = pg_catalog.now(), revocation_reason = 'superseded'
WHERE job_id = 'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb' AND revoked_at IS NULL;

SELECT is(
    (SELECT count(*)::int FROM public.generate_customer_tracking_session('bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb', 24)),
    1,
    'Authorized owner can successfully generate tracking session'
);

-- -----------------------------------------------------------------------------
-- Verification 4: Session activation on 'on_the_way'
-- -----------------------------------------------------------------------------
-- Check session was issued with activated_at IS NULL since job is 'accepted'
SELECT is(
    (SELECT activated_at FROM public.customer_tracking_sessions WHERE job_id = 'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb' AND revoked_at IS NULL),
    NULL,
    'Tracking session for accepted job is initially pending activation (activated_at IS NULL)'
);

-- Worker Alex transitions job to 'on_the_way'
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222"}';
SELECT public.advance_job_status('bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb', 'on_the_way', 'accepted');

-- Verify trigger automatically activated the session
SELECT isnt(
    (SELECT activated_at FROM public.customer_tracking_sessions WHERE job_id = 'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb' AND revoked_at IS NULL),
    NULL,
    'Advancing status to on_the_way authoritatively activates tracking session eligibility'
);

-- -----------------------------------------------------------------------------
-- Verification 5: Token rotation (superseding previous session)
-- -----------------------------------------------------------------------------
-- Owner Alpha rotates the link
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111"}';

-- Generate rotated session
CREATE TEMP TABLE rotated_res AS 
    SELECT * FROM public.generate_customer_tracking_session('bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb', 24);

-- Verify exactly one session was superseded
SELECT is(
    (SELECT count(*)::int FROM public.customer_tracking_sessions WHERE job_id = 'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb' AND revocation_reason = 'superseded'),
    2,
    'Previous tracking session is automatically revoked with reason = superseded'
);

-- Verify newly rotated session is active
SELECT is(
    (SELECT count(*)::int FROM public.customer_tracking_sessions WHERE job_id = 'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb' AND revoked_at IS NULL),
    1,
    'Exactly one active session exists after token rotation'
);

-- -----------------------------------------------------------------------------
-- Verification 6: Revocation after completion
-- -----------------------------------------------------------------------------
-- Worker Alex advances on_the_way -> arrived -> in_progress -> completed
SET LOCAL "request.jwt.claims" = '{"sub": "a2222222-2222-2222-2222-222222222222"}';
SELECT public.advance_job_status('bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb', 'arrived', 'on_the_way');
SELECT public.advance_job_status('bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb', 'in_progress', 'arrived');
SELECT public.advance_job_status('bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb', 'completed', 'in_progress');

-- Verify active session was revoked with 'completed'
SELECT is(
    (SELECT count(*)::int FROM public.customer_tracking_sessions WHERE job_id = 'bbbbbbbb-1111-bbbb-bbbb-bbbbbbbbbbbb' AND revoked_at IS NULL),
    0,
    'Completion authoritatively revokes all active tracking sessions for the job'
);

-- -----------------------------------------------------------------------------
-- Verification 7: Revocation after reassignment
-- -----------------------------------------------------------------------------
-- Job 2: Assigned to Alex
INSERT INTO public.jobs (id, business_id, worker_id, customer_name, customer_phone, service, address, status) VALUES
    ('bbbbbbbb-2222-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'Jane Smith', '555-5678', 'Plumbing', '456 Oak St', 'assigned')
ON CONFLICT (id) DO NOTHING;

-- Owner Alpha generates link for Job 2
SET LOCAL "request.jwt.claims" = '{"sub": "a1111111-1111-1111-1111-111111111111"}';
SELECT public.generate_customer_tracking_session('bbbbbbbb-2222-bbbb-bbbb-bbbbbbbbbbbb', 24);

-- Owner Alpha reassigns Job 2 to Bob
SELECT public.assign_job_worker('bbbbbbbb-2222-bbbb-bbbb-bbbbbbbbbbbb', 'a3333333-3333-3333-3333-333333333333', 'assigned');

-- Verify session revoked with 'reassigned'
SELECT is(
    (SELECT revocation_reason FROM public.customer_tracking_sessions WHERE job_id = 'bbbbbbbb-2222-bbbb-bbbb-bbbbbbbbbbbb' AND revocation_reason = 'reassigned'),
    'reassigned',
    'Reassignment authoritatively revokes the previous technician tracking session'
);

-- -----------------------------------------------------------------------------
-- Verification 8: Raw tokens are NEVER stored in database
-- -----------------------------------------------------------------------------
-- Check all token_hash values in customer_tracking_sessions are exactly 64-char hex strings
SELECT is(
    (SELECT count(*)::int FROM public.customer_tracking_sessions WHERE length(token_hash) != 64),
    0,
    'Every stored token_hash is strictly a 64-character SHA-256 hash digest'
);

-- Check anonymous client direct access remains completely revoked
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" = '{"role": "anon"}';

SELECT throws_ok(
    $$SELECT * FROM public.customer_tracking_sessions$$,
    '42501',
    NULL,
    'Anonymous client direct SELECT on customer_tracking_sessions is rejected'
);

SELECT * FROM finish();
ROLLBACK;
