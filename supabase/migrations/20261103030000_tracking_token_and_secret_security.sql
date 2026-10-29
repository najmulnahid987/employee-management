-- =============================================================================
-- Migration: 20261103030000_tracking_token_and_secret_security.sql
-- Module: Dispatcher M18.2C — Tracking Token & Secret Security Hardening
--
-- Authoritative Specifications:
-- - docs/product-specification.md (Frozen Core Specification)
-- - AGENTS.md (M4, M13, M18 Security Architecture)
-- - docs/database-schema.md
--
-- Goals:
-- 1. Install hardened public.generate_customer_tracking_session(UUID, INT) RPC
--    using pg_catalog.gen_random_bytes(32) for 256 bits of pure CSPRNG entropy.
-- 2. Harden public.get_customer_tracking_session_job(TEXT) RPC with strict regex
--    format validation, length bounds (16..128), and worker active state verification.
-- 3. Preserve complete backwards compatibility with existing active customer sessions.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. HARDEN generate_customer_tracking_session RPC (256-BIT CSPRNG ENTROPY)
-- -----------------------------------------------------------------------------
-- Drops and recreates generate_customer_tracking_session with gen_random_bytes(32)
DROP FUNCTION IF EXISTS public.generate_customer_tracking_session(UUID, INT);

CREATE OR REPLACE FUNCTION public.generate_customer_tracking_session(
    p_job_id UUID,
    p_duration_hours INT DEFAULT 24
)
RETURNS TABLE (
    session_id UUID,
    job_id UUID,
    raw_token TEXT,
    tracking_url TEXT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    is_activated BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID;
    v_business_id UUID;
    v_job public.jobs;
    v_duration INT;
    v_expires_at TIMESTAMPTZ;
    v_raw_token TEXT;
    v_token_hash TEXT;
    v_session_id UUID;
    v_created_at TIMESTAMPTZ;
    v_activated_at TIMESTAMPTZ;
BEGIN
    -- 1. Caller Identity & Role Verification
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required to generate customer tracking session.'
            USING ERRCODE = '42501';
    END IF;

    IF NOT app_auth.is_business_owner() THEN
        RAISE EXCEPTION 'Only business owners can issue customer tracking sessions.'
            USING ERRCODE = '42501';
    END IF;

    v_business_id := app_auth.current_business_id();
    IF v_business_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated owner is not linked to an active business tenant.'
            USING ERRCODE = '42501';
    END IF;

    -- 2. Verify Job Ownership & Business Isolation
    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
      AND business_id = v_business_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job % not found in your business.', p_job_id
            USING ERRCODE = '42501';
    END IF;

    -- 3. Strict Lifecycle & Assignment Eligibility
    -- Cannot issue link for unassigned jobs without a designated field worker
    IF v_job.status = 'unassigned' OR v_job.worker_id IS NULL THEN
        RAISE EXCEPTION 'Cannot create tracking link for unassigned job. Assign an active technician first.'
            USING ERRCODE = 'P0001';
    END IF;

    -- Cannot issue link for completed or cancelled jobs
    IF v_job.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Cannot create tracking link for job in terminal status "%".', v_job.status
            USING ERRCODE = 'P0001';
    END IF;

    -- 4. Expiry Policy Bounds (Default: 24h, Min: 1h, Max: 72h)
    v_duration := COALESCE(p_duration_hours, 24);
    IF v_duration < 1 OR v_duration > 72 THEN
        RAISE EXCEPTION 'Tracking session duration must be between 1 and 72 hours.'
            USING ERRCODE = '22023';
    END IF;

    v_expires_at := pg_catalog.now() + (v_duration || ' hours')::interval;

    -- 5. Secure Token Rotation: Atomically revoke previous active session for this job
    UPDATE public.customer_tracking_sessions
    SET revoked_at = pg_catalog.now(),
        revocation_reason = 'superseded'
    WHERE customer_tracking_sessions.job_id = p_job_id
      AND customer_tracking_sessions.revoked_at IS NULL;

    -- 6. Cryptographically Secure 256-Bit CSPRNG Token Generation
    -- Uses 32 random bytes from OS CSPRNG encoded as 64 hex characters (256 bits entropy)
    v_raw_token := pg_catalog.encode(pg_catalog.gen_random_bytes(32), 'hex');

    -- Authoritative SHA-256 hash (64 hex characters)
    v_token_hash := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(v_raw_token, 'UTF8')),
        'hex'
    );

    -- 7. Activation status check at issuance
    IF v_job.status IN ('on_the_way', 'arrived', 'in_progress') THEN
        v_activated_at := pg_catalog.now();
    ELSE
        v_activated_at := NULL;
    END IF;

    -- 8. Insert Session Record (Storing Hash ONLY, NEVER raw token)
    INSERT INTO public.customer_tracking_sessions (
        job_id,
        business_id,
        worker_id,
        token_hash,
        created_at,
        activated_at,
        expires_at
    ) VALUES (
        v_job.id,
        v_business_id,
        v_job.worker_id,
        v_token_hash,
        pg_catalog.now(),
        v_activated_at,
        v_expires_at
    )
    RETURNING customer_tracking_sessions.id, customer_tracking_sessions.created_at
    INTO v_session_id, v_created_at;

    -- 9. Return One-Time Bearer Credentials
    RETURN QUERY
    SELECT
        v_session_id,
        v_job.id,
        v_raw_token,
        ('/track#' || v_raw_token) AS tracking_url,
        v_expires_at,
        v_created_at,
        (v_activated_at IS NOT NULL) AS is_activated;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_customer_tracking_session(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_customer_tracking_session(UUID, INT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. HARDEN get_customer_tracking_session_job RPC (INPUT SANITIZATION & ACTIVE WORKER CHECK)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_customer_tracking_session_job(
    p_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_clean_token TEXT;
    v_token_hash TEXT;
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

    -- Enforce strictly hexadecimal token format [0-9a-fA-F]
    IF v_clean_token !~* '^[0-9a-f]{16,128}$' THEN
        RETURN NULL;
    END IF;

    -- 2. Compute SHA-256 Hash of Supplied Raw Bearer Token
    v_token_hash := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(v_clean_token, 'UTF8')),
        'hex'
    );

    -- 3. Match Active, Unexpired, Unrevoked Session
    SELECT * INTO v_session
    FROM public.customer_tracking_sessions
    WHERE token_hash = v_token_hash
      AND revoked_at IS NULL
      AND expires_at > pg_catalog.now();

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- 4. Verify Linked Job Tenancy & Lifecycle Status
    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = v_session.job_id
      AND business_id = v_session.business_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Ineligible if job has returned to unassigned or has entered terminal status
    IF v_job.status IN ('completed', 'cancelled', 'unassigned') THEN
        RETURN NULL;
    END IF;

    -- Ineligible if job has been reassigned to a different technician
    IF v_session.worker_id IS NOT NULL AND v_job.worker_id IS DISTINCT FROM v_session.worker_id THEN
        RETURN NULL;
    END IF;

    -- 5. Business Identity
    SELECT * INTO v_business
    FROM public.businesses
    WHERE id = v_job.business_id;

    -- 6. Assigned Technician Details (First Name & Avatar Only)
    IF v_job.worker_id IS NOT NULL THEN
        SELECT * INTO v_worker
        FROM public.profiles
        WHERE id = v_job.worker_id;

        -- Ineligible if assigned technician account is deactivated
        IF v_worker.is_active IS FALSE THEN
            RETURN NULL;
        END IF;
    END IF;

    -- 7. Live Location Join (Only for Approved Active Tracking Stages AND Activated Session)
    IF v_job.status IN ('on_the_way', 'arrived', 'in_progress') 
       AND v_job.worker_id IS NOT NULL 
       AND v_session.activated_at IS NOT NULL THEN
        SELECT * INTO v_location
        FROM public.locations
        WHERE worker_id = v_job.worker_id
          AND job_id = v_job.id;
    END IF;

    -- 8. Construct Allowlisted JSON Output (Masking all internal IDs and customer PII)
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

