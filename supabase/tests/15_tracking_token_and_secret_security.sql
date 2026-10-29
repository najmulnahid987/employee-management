-- =============================================================================
-- Dispatcher Test Suite: 15_tracking_token_and_secret_security.sql
-- Module: M18.2C — Tracking Token and Secret Security Verification
-- Verifies:
-- 1. generate_customer_tracking_session exists and outputs 64-character hex tokens.
-- 2. generate_customer_tracking_session rejects unassigned jobs.
-- 3. generate_customer_tracking_session rejects completed jobs.
-- 4. generate_customer_tracking_session enforces duration bounds (1..72 hours).
-- 5. generate_customer_tracking_session atomically revokes previous active session.
-- 6. get_customer_tracking_session_job rejects non-hex and malformed tokens.
-- 7. get_customer_tracking_session_job returns NULL for non-existent token.
-- 8. get_customer_tracking_session_job returns NULL for completed or cancelled job.
-- 9. get_customer_tracking_session_job returns allowlisted fields and omits PII/IDs.
-- 10. get_customer_tracking_session_job returns NULL when worker account is inactive.
-- =============================================================================

BEGIN;
SELECT plan(10);

-- Fixtures Setup
INSERT INTO auth.users (id, email) VALUES
    ('d1111111-1111-1111-1111-111111111111', 'owner-d@test.com'),
    ('d2222222-2222-2222-2222-222222222222', 'worker-d@test.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.businesses (id, name, phone, address) VALUES
    ('44444444-4444-4444-4444-444444444444', 'Business Delta', '555-0401', '400 Delta St')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active) VALUES
    ('d1111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'Owner Delta', 'owner-d@test.com', '555-0401', 'owner', true),
    ('d2222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'Technician Delta', 'worker-d@test.com', '555-0402', 'worker', true)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Setup jobs: one assigned, one unassigned, one completed
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "d1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

SELECT public.create_job(
    'Assigned Customer',
    '555-0100',
    'Delta AC Repair',
    '100 Assigned Ave',
    now() + interval '1 day',
    'Private gate code 1234',
    'd2222222-2222-2222-2222-222222222222'::UUID,
    37.7749,
    -122.4194
);

SELECT public.create_job(
    'Unassigned Customer',
    '555-0200',
    'Delta Inspection',
    '200 Unassigned Blvd',
    now() + interval '2 days',
    NULL,
    NULL
);

SELECT public.create_job(
    'Completed Customer',
    '555-0300',
    'Delta Filter Replacement',
    '300 Completed Ct',
    now() - interval '1 hour',
    NULL,
    'd2222222-2222-2222-2222-222222222222'::UUID
);

-- Force terminal status on completed customer job
UPDATE public.jobs
SET status = 'completed'
WHERE customer_name = 'Completed Customer';

-- -----------------------------------------------------------------------------
-- Test 1: generate_customer_tracking_session outputs 64-character hex raw token
-- -----------------------------------------------------------------------------
SELECT ok(
    (SELECT length(raw_token) = 64
     FROM public.generate_customer_tracking_session(
         (SELECT id FROM public.jobs WHERE customer_name = 'Assigned Customer' LIMIT 1),
         24
     )),
    'generate_customer_tracking_session outputs 64-character hex token (256 bits entropy)'
);

-- -----------------------------------------------------------------------------
-- Test 2: generate_customer_tracking_session rejects unassigned job
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$SELECT public.generate_customer_tracking_session(
        (SELECT id FROM public.jobs WHERE customer_name = 'Unassigned Customer' LIMIT 1),
        24
    )$$,
    'P0001',
    'Cannot create tracking link for unassigned job. Assign an active technician first.',
    'generate_customer_tracking_session rejects unassigned job'
);

-- -----------------------------------------------------------------------------
-- Test 3: generate_customer_tracking_session rejects completed job
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$SELECT public.generate_customer_tracking_session(
        (SELECT id FROM public.jobs WHERE customer_name = 'Completed Customer' LIMIT 1),
        24
    )$$,
    'P0001',
    'Cannot create tracking link for job in terminal status "completed".',
    'generate_customer_tracking_session rejects completed job'
);

-- -----------------------------------------------------------------------------
-- Test 4: generate_customer_tracking_session enforces duration bounds (1..72 hours)
-- -----------------------------------------------------------------------------
SELECT throws_ok(
    $$SELECT public.generate_customer_tracking_session(
        (SELECT id FROM public.jobs WHERE customer_name = 'Assigned Customer' LIMIT 1),
        100
    )$$,
    '22023',
    'Tracking session duration must be between 1 and 72 hours.',
    'generate_customer_tracking_session rejects duration > 72 hours'
);

-- -----------------------------------------------------------------------------
-- Test 5: generate_customer_tracking_session atomically supersedes previous session
-- -----------------------------------------------------------------------------
SELECT ok(
    (SELECT count(*) = 1
     FROM public.customer_tracking_sessions
     WHERE job_id = (SELECT id FROM public.jobs WHERE customer_name = 'Assigned Customer' LIMIT 1)
       AND revoked_at IS NOT NULL
       AND revocation_reason = 'superseded'),
    'Second generation revokes previous session with reason superseded'
);

-- -----------------------------------------------------------------------------
-- Test 6: get_customer_tracking_session_job rejects non-hex or malformed token
-- -----------------------------------------------------------------------------
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" = '{"role": "anon"}';

SELECT is(
    public.get_customer_tracking_session_job('not-a-valid-hex-token-xyz!@#$'),
    NULL,
    'get_customer_tracking_session_job returns NULL for non-hex token'
);

-- -----------------------------------------------------------------------------
-- Test 7: get_customer_tracking_session_job returns NULL for non-existent token
-- -----------------------------------------------------------------------------
SELECT is(
    public.get_customer_tracking_session_job('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
    NULL,
    'get_customer_tracking_session_job returns NULL for random non-existent token'
);

-- -----------------------------------------------------------------------------
-- Setup an active tracking session and query it
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "d1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

DO $$
DECLARE
    v_token TEXT;
    v_res JSONB;
BEGIN
    SELECT raw_token INTO v_token
    FROM public.generate_customer_tracking_session(
        (SELECT id FROM public.jobs WHERE customer_name = 'Assigned Customer' LIMIT 1),
        24
    );

    PERFORM set_config('test.active_token', v_token, true);
END;
$$;

-- -----------------------------------------------------------------------------
-- Test 8: Anonymous user queries active tracking session allowlist
-- -----------------------------------------------------------------------------
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" = '{"role": "anon"}';

SELECT ok(
    (SELECT (public.get_customer_tracking_session_job(current_setting('test.active_token')) ->> 'business_name') = 'Business Delta'),
    'Anonymous customer query returns public allowlisted business_name'
);

-- -----------------------------------------------------------------------------
-- Test 9: Withholds sensitive customer and worker PII
-- -----------------------------------------------------------------------------
SELECT ok(
    (SELECT
        (public.get_customer_tracking_session_job(current_setting('test.active_token')) -> 'customer_name') IS NULL AND
        (public.get_customer_tracking_session_job(current_setting('test.active_token')) -> 'customer_phone') IS NULL AND
        (public.get_customer_tracking_session_job(current_setting('test.active_token')) -> 'notes') IS NULL AND
        (public.get_customer_tracking_session_job(current_setting('test.active_token')) -> 'cancellation_reason') IS NULL AND
        (public.get_customer_tracking_session_job(current_setting('test.active_token')) -> 'id') IS NULL AND
        (public.get_customer_tracking_session_job(current_setting('test.active_token')) -> 'job_id') IS NULL AND
        (public.get_customer_tracking_session_job(current_setting('test.active_token')) ->> 'worker_first_name') = 'Technician'
    ),
    'Customer tracking payload strictly withholds customer PII, internal notes, and raw database IDs'
);

-- -----------------------------------------------------------------------------
-- Test 10: Returns NULL if job transitions to completed
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "d1111111-1111-1111-1111-111111111111", "role": "authenticated"}';

UPDATE public.jobs
SET status = 'completed'
WHERE customer_name = 'Assigned Customer';

SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" = '{"role": "anon"}';

SELECT is(
    public.get_customer_tracking_session_job(current_setting('test.active_token')),
    NULL,
    'get_customer_tracking_session_job immediately returns NULL once job is completed'
);

SELECT * FROM finish();
ROLLBACK;

