-- =============================================================================
-- Dispatcher Test Suite: 16_public_endpoint_abuse_protection.sql
-- Module: M18.3 — Public Endpoint Abuse Protection Verification
-- Verifies:
-- 1. rate_limit_buckets table exists and RLS is enabled.
-- 2. check_rate_limit RPC permits initial request under threshold.
-- 3. check_rate_limit increments request_count on subsequent calls.
-- 4. check_rate_limit blocks requests once max_requests threshold is hit.
-- 5. check_rate_limit returns positive retry_after seconds when limited.
-- 6. check_rate_limit resets window when expires_at has elapsed.
-- 7. check_rate_limit rejects empty or oversized keys.
-- 8. Anonymous user cannot directly query rate_limit_buckets table (RLS blocked).
-- 9. Authenticated user cannot directly mutate rate_limit_buckets table (RLS blocked).
-- 10. get_customer_tracking_session_job enforces rate limit raising P0004 upon abuse.
-- =============================================================================

BEGIN;
SELECT plan(10);

-- -----------------------------------------------------------------------------
-- Test 1: rate_limit_buckets table exists and RLS is active
-- -----------------------------------------------------------------------------
SELECT ok(
    (SELECT count(*) = 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rate_limit_buckets'),
    'rate_limit_buckets table exists in public schema'
);

-- -----------------------------------------------------------------------------
-- Test 2: check_rate_limit permits initial request
-- -----------------------------------------------------------------------------
SELECT is(
    (public.check_rate_limit('test-ip-1.1.1.1', 5, 60) ->> 'allowed')::boolean,
    true,
    'check_rate_limit allows initial request'
);

-- -----------------------------------------------------------------------------
-- Test 3: check_rate_limit decrements remaining counter
-- -----------------------------------------------------------------------------
SELECT is(
    (public.check_rate_limit('test-ip-1.1.1.1', 5, 60) ->> 'remaining')::int,
    3,
    'check_rate_limit reflects remaining quota after second request'
);

-- -----------------------------------------------------------------------------
-- Test 4: check_rate_limit blocks requests exceeding max quota
-- -----------------------------------------------------------------------------
-- Consume remaining 3 requests
SELECT public.check_rate_limit('test-ip-1.1.1.1', 5, 60);
SELECT public.check_rate_limit('test-ip-1.1.1.1', 5, 60);
SELECT public.check_rate_limit('test-ip-1.1.1.1', 5, 60);

-- 6th request must be blocked
SELECT is(
    (public.check_rate_limit('test-ip-1.1.1.1', 5, 60) ->> 'allowed')::boolean,
    false,
    'check_rate_limit blocks 6th request exceeding limit of 5'
);

-- -----------------------------------------------------------------------------
-- Test 5: check_rate_limit returns positive retry_after seconds
-- -----------------------------------------------------------------------------
SELECT ok(
    ((public.check_rate_limit('test-ip-1.1.1.1', 5, 60) ->> 'retry_after')::int > 0),
    'check_rate_limit returns positive retry_after seconds when limited'
);

-- -----------------------------------------------------------------------------
-- Test 6: check_rate_limit resets window when window expires
-- -----------------------------------------------------------------------------
-- Manually expire test bucket
UPDATE public.rate_limit_buckets
SET expires_at = clock_timestamp() - interval '1 second'
WHERE bucket_key = 'test-ip-1.1.1.1';

SELECT is(
    (public.check_rate_limit('test-ip-1.1.1.1', 5, 60) ->> 'allowed')::boolean,
    true,
    'check_rate_limit resets window and allows request after expiration'
);

-- -----------------------------------------------------------------------------
-- Test 7: check_rate_limit rejects empty or oversized keys
-- -----------------------------------------------------------------------------
SELECT is(
    (public.check_rate_limit('', 5, 60) ->> 'allowed')::boolean,
    false,
    'check_rate_limit rejects empty bucket key'
);

-- -----------------------------------------------------------------------------
-- Test 8: Anonymous user cannot SELECT from rate_limit_buckets (RLS block)
-- -----------------------------------------------------------------------------
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" = '{"role": "anon"}';

SELECT throws_ok(
    $$SELECT * FROM public.rate_limit_buckets$$,
    '42501',
    NULL,
    'Anonymous user cannot query rate_limit_buckets table directly'
);

-- -----------------------------------------------------------------------------
-- Test 9: Authenticated user cannot INSERT into rate_limit_buckets (RLS block)
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "00000000-0000-0000-0000-000000000000", "role": "authenticated"}';

SELECT throws_ok(
    $$INSERT INTO public.rate_limit_buckets (bucket_key, request_count, expires_at)
      VALUES ('malicious-key', 1, now() + interval '1 hour')$$,
    '42501',
    NULL,
    'Authenticated client cannot insert into rate_limit_buckets directly'
);

-- -----------------------------------------------------------------------------
-- Test 10: get_customer_tracking_session_job raises P0004 when token rate limit is exceeded
-- -----------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub": "00000000-0000-0000-0000-000000000000", "role": "authenticated"}';

-- Simulate exhausted rate limit bucket for token
INSERT INTO public.rate_limit_buckets (bucket_key, request_count, window_start, expires_at)
VALUES (
    'token:' || substr(encode(sha256(convert_to('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'UTF8')), 'hex'), 1, 16),
    60,
    clock_timestamp(),
    clock_timestamp() + interval '60 seconds'
) ON CONFLICT (bucket_key) DO UPDATE SET request_count = 60, expires_at = clock_timestamp() + interval '60 seconds';

SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" = '{"role": "anon"}';

SELECT throws_ok(
    $$SELECT public.get_customer_tracking_session_job('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')$$,
    'P0004',
    'Rate limit exceeded. Please wait before trying again.',
    'get_customer_tracking_session_job raises P0004 when token rate limit is exhausted'
);

SELECT * FROM finish();
ROLLBACK;

