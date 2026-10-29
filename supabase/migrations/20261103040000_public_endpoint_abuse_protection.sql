-- =============================================================================
-- Migration: 20261103040000_public_endpoint_abuse_protection.sql
-- Module: Dispatcher M18.3 — Public Endpoint Abuse Protection & Shared Rate Limiting
--
-- Authoritative Specifications:
-- - docs/product-specification.md (Frozen Core Specification)
-- - AGENTS.md (M4, M13, M18 Security Architecture)
-- - docs/database-schema.md
--
-- Goals:
-- 1. Create public.rate_limit_buckets table for shared, atomic rate-limiting across
--    server instances, protected by strict RLS and revoked from direct client mutation.
-- 2. Implement public.check_rate_limit(TEXT, INT, INT) transactional RPC using
--    row-level exclusive locking (SELECT ... FOR UPDATE) and automatic window resets.
-- 3. Harden public.get_customer_tracking_session_job(TEXT) to enforce atomic
--    per-token and per-IP rate limiting, raising exception 'P0004' upon abuse.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. SHARED RATE LIMIT STORAGE
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
    bucket_key TEXT PRIMARY KEY,
    request_count INT NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Index for opportunistic pruning of expired rate-limit windows
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expires_at
    ON public.rate_limit_buckets (expires_at);

-- Row Level Security: Revoke all direct client access
ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.rate_limit_buckets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rate_limit_buckets TO service_role;

-- -----------------------------------------------------------------------------
-- 2. ATOMIC RATE LIMIT CHECK RPC
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_rate_limit(
    p_bucket_key TEXT,
    p_max_requests INT DEFAULT 60,
    p_window_seconds INT DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_clean_key TEXT;
    v_max INT;
    v_window INT;
    v_window_interval INTERVAL;
    v_row public.rate_limit_buckets%ROWTYPE;
    v_allowed BOOLEAN;
    v_remaining INT;
    v_retry_after INT := 0;
BEGIN
    -- 1. Input Validation
    v_clean_key := pg_catalog.btrim(COALESCE(p_bucket_key, ''));
    IF pg_catalog.length(v_clean_key) = 0 OR pg_catalog.length(v_clean_key) > 200 THEN
        RETURN pg_catalog.jsonb_build_object(
            'allowed', false,
            'remaining', 0,
            'retry_after', 60,
            'error', 'Invalid rate limit key'
        );
    END IF;

    v_max := COALESCE(p_max_requests, 60);
    IF v_max < 1 OR v_max > 1000 THEN
        v_max := 60;
    END IF;

    v_window := COALESCE(p_window_seconds, 60);
    IF v_window < 1 OR v_window > 3600 THEN
        v_window := 60;
    END IF;

    v_window_interval := (v_window || ' seconds')::INTERVAL;

    -- 2. Opportunistic Lightweight Garbage Collection (5% probability)
    IF (pg_catalog.random() < 0.05) THEN
        DELETE FROM public.rate_limit_buckets
        WHERE expires_at < v_now;
    END IF;

    -- 3. Atomic Bucket Lock & Evaluation
    SELECT * INTO v_row
    FROM public.rate_limit_buckets
    WHERE bucket_key = v_clean_key
    FOR UPDATE;

    IF NOT FOUND OR v_now >= v_row.expires_at THEN
        -- New or expired bucket: initialize fresh window
        INSERT INTO public.rate_limit_buckets (
            bucket_key,
            request_count,
            window_start,
            expires_at
        ) VALUES (
            v_clean_key,
            1,
            v_now,
            v_now + v_window_interval
        )
        ON CONFLICT (bucket_key) DO UPDATE
        SET request_count = 1,
            window_start = v_now,
            expires_at = v_now + v_window_interval;

        v_allowed := true;
        v_remaining := v_max - 1;
        v_retry_after := 0;
    ELSE
        -- Active window evaluation
        IF v_row.request_count >= v_max THEN
            -- Exceeded threshold
            v_allowed := false;
            v_remaining := 0;
            v_retry_after := GREATEST(1, pg_catalog.ceil(EXTRACT(EPOCH FROM (v_row.expires_at - v_now)))::INT);
        ELSE
            -- Increment counter
            UPDATE public.rate_limit_buckets
            SET request_count = v_row.request_count + 1
            WHERE bucket_key = v_clean_key;

            v_allowed := true;
            v_remaining := v_max - (v_row.request_count + 1);
            v_retry_after := 0;
        END IF;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'allowed', v_allowed,
        'remaining', GREATEST(0, v_remaining),
        'retry_after', v_retry_after
    );
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit(TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(TEXT, INT, INT) TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. HARDEN get_customer_tracking_session_job WITH SHARED RATE LIMITING
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_customer_tracking_session_job(
    p_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_clean_token TEXT;
    v_token_hash TEXT;
    v_rate_check JSONB;
    v_client_ip TEXT;
    v_session public.customer_tracking_sessions;
    v_job public.jobs;
    v_business public.businesses;
    v_worker public.profiles;
    v_location public.locations;
    v_result JSONB;
BEGIN
    -- 1. Anti-Enumeration & Input Validation
    v_clean_token := pg_catalog.btrim(COALESCE(p_token, ''));
    IF pg_catalog.length(v_clean_token) < 16 OR pg_catalog.length(v_clean_token) > 128 THEN
        RETURN NULL;
    END IF;

    IF v_clean_token !~* '^[0-9a-f]{16,128}$' THEN
        RETURN NULL;
    END IF;

    -- 2. Compute SHA-256 Hash of Supplied Raw Bearer Token
    v_token_hash := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(v_clean_token, 'UTF8')),
        'hex'
    );

    -- 3. Shared Atomic Rate Limiting (Per-Token Protection)
    -- Limits repeated queries on the same token across all clients (max 60 req/min)
    v_rate_check := public.check_rate_limit('token:' || pg_catalog.substr(v_token_hash, 1, 16), 60, 60);
    IF NOT (v_rate_check ->> 'allowed')::boolean THEN
        RAISE EXCEPTION 'Rate limit exceeded. Please wait before trying again.'
            USING ERRCODE = 'P0004';
    END IF;

    -- 4. Shared Atomic Rate Limiting (Per-IP Protection if PostgREST request headers present)
    BEGIN
        v_client_ip := current_setting('request.headers', true)::json->>'cf-connecting-ip';
        IF v_client_ip IS NULL OR pg_catalog.length(v_client_ip) = 0 THEN
            v_client_ip := split_part(current_setting('request.headers', true)::json->>'x-forwarded-for', ',', 1);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_client_ip := NULL;
    END;

    IF v_client_ip IS NOT NULL AND pg_catalog.length(pg_catalog.btrim(v_client_ip)) > 0 THEN
        v_rate_check := public.check_rate_limit('ip:' || pg_catalog.btrim(v_client_ip), 60, 60);
        IF NOT (v_rate_check ->> 'allowed')::boolean THEN
            RAISE EXCEPTION 'Rate limit exceeded. Please wait before trying again.'
                USING ERRCODE = 'P0004';
        END IF;
    END IF;

    -- 5. Match Active, Unexpired, Unrevoked Session
    SELECT * INTO v_session
    FROM public.customer_tracking_sessions
    WHERE token_hash = v_token_hash
      AND revoked_at IS NULL
      AND expires_at > pg_catalog.now();

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- 6. Verify Linked Job Tenancy & Lifecycle Status
    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = v_session.job_id
      AND business_id = v_session.business_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF v_job.status IN ('completed', 'cancelled', 'unassigned') THEN
        RETURN NULL;
    END IF;

    IF v_session.worker_id IS NOT NULL AND v_job.worker_id IS DISTINCT FROM v_session.worker_id THEN
        RETURN NULL;
    END IF;

    -- 7. Business Identity
    SELECT * INTO v_business
    FROM public.businesses
    WHERE id = v_job.business_id;

    -- 8. Assigned Technician Details
    IF v_job.worker_id IS NOT NULL THEN
        SELECT * INTO v_worker
        FROM public.profiles
        WHERE id = v_job.worker_id;

        IF v_worker.is_active IS FALSE THEN
            RETURN NULL;
        END IF;
    END IF;

    -- 9. Live Location Join
    IF v_job.status IN ('on_the_way', 'arrived', 'in_progress') 
       AND v_job.worker_id IS NOT NULL 
       AND v_session.activated_at IS NOT NULL THEN
        SELECT * INTO v_location
        FROM public.locations
        WHERE worker_id = v_job.worker_id
          AND job_id = v_job.id;
    END IF;

    -- 10. Construct Allowlisted JSON Output
    SELECT pg_catalog.jsonb_build_object(
        'service', v_job.service,
        'status', v_job.status,
        'status_label', CASE v_job.status
            WHEN 'unassigned' THEN 'Scheduled'
            WHEN 'assigned' THEN 'Scheduled'
            WHEN 'accepted' THEN 'Confirmed — Preparing for your visit'
            WHEN 'on_the_way' THEN 'Technician is on the way'
            WHEN 'arrived' THEN 'Technician has arrived on-site'
            WHEN 'in_progress' THEN 'Work is currently in progress'
            WHEN 'completed' THEN 'Service completed'
            WHEN 'cancelled' THEN 'Service cancelled'
            ELSE 'Status pending'
        END,
        'scheduled_at', v_job.scheduled_at,
        'business_name', v_business.name,
        'business_phone', v_business.phone,
        'worker_first_name', CASE 
            WHEN v_worker.full_name IS NOT NULL THEN split_part(pg_catalog.btrim(v_worker.full_name), ' ', 1)
            ELSE NULL
        END,
        'worker_avatar_url', v_worker.avatar_url,
        'destination', CASE
            WHEN v_job.latitude IS NOT NULL AND v_job.longitude IS NOT NULL THEN
                pg_catalog.jsonb_build_object(
                    'latitude', v_job.latitude,
                    'longitude', v_job.longitude
                )
            ELSE NULL
        END,
        'worker_location', CASE
            WHEN v_location.latitude IS NOT NULL THEN
                pg_catalog.jsonb_build_object(
                    'latitude', v_location.latitude,
                    'longitude', v_location.longitude,
                    'accuracy', v_location.accuracy,
                    'recorded_at', v_location.created_at,
                    'is_stale', (pg_catalog.now() - v_location.created_at > interval '10 minutes')
                )
            ELSE NULL
        END,
        'is_tracking_active', (v_session.activated_at IS NOT NULL),
        'activated_at', v_session.activated_at,
        'tracking_message', CASE
            WHEN v_session.activated_at IS NULL THEN 'Technician has not started travel yet.'
            WHEN v_job.status = 'on_the_way' AND v_location.latitude IS NULL THEN 'Technician is on the way. Waiting for live location...'
            WHEN v_job.status = 'on_the_way' AND (pg_catalog.now() - v_location.created_at > interval '10 minutes') THEN 'Technician is on the way. Location update is delayed.'
            WHEN v_job.status = 'on_the_way' THEN 'Technician is on the way.'
            WHEN v_job.status = 'arrived' THEN 'Technician has arrived on-site.'
            WHEN v_job.status = 'in_progress' THEN 'Work is currently in progress.'
            WHEN v_job.status = 'completed' THEN 'Service completed.'
            WHEN v_job.status = 'cancelled' THEN 'Service cancelled.'
            ELSE 'Status pending'
        END,
        'last_location_updated_at', v_location.created_at,
        'estimated_arrival', NULL,
        'session_expires_at', v_session.expires_at,
        'updated_at', v_job.updated_at
    ) INTO v_result;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_customer_tracking_session_job(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_tracking_session_job(TEXT) TO anon, authenticated;

COMMIT;

