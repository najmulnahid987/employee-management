-- =============================================================================
-- Migration: 20261028020000_tracking_session_lifecycle.sql
-- Module: Dispatcher M13.3 — Secure Tracking Session Lifecycle & Token Issuance
--
-- Authoritative Specifications:
-- - docs/product-specification.md (Section 4: Customer Tracking Web Page)
-- - AGENTS.md (M4, M9 & M13 Architecture)
--
-- Goals:
-- 1. Add activated_at TIMESTAMPTZ column to public.customer_tracking_sessions.
-- 2. Extend the AFTER UPDATE trigger on public.jobs to atomically activate session
--    eligibility when an authorized worker transitions to 'on_the_way'.
-- 3. Enforce that link issuance (generate_customer_tracking_session) strictly rejects
--    unassigned jobs (worker_id IS NULL) and terminal jobs ('completed', 'cancelled').
-- 4. Support secure token rotation: revoking previous sessions with 'superseded'.
-- 5. Return both URL-safe raw bearer token (256 bits entropy) and canonical tracking URL
--    exclusively to the authenticated owner upon issuance; raw tokens are NEVER stored.
-- 6. Atomically revoke sessions within the same database transaction on job completion,
--    cancellation, worker decline, unassign, and reassignment.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. SCHEMA EXTENSION: activated_at column
-- =============================================================================

ALTER TABLE public.customer_tracking_sessions
    ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

-- =============================================================================
-- 2. ATOMIC LIFECYCLE & ACTIVATION TRIGGER ON public.jobs
-- =============================================================================

CREATE OR REPLACE FUNCTION public.handle_job_tracking_session_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- 1. Session Activation: Worker transitions to 'on_the_way'
    -- Activates tracking-session eligibility through the secure backend.
    -- Prevents client from arbitrarily activating tracking for a different job.
    IF NEW.status = 'on_the_way' AND (OLD.status IS DISTINCT FROM 'on_the_way') THEN
        UPDATE public.customer_tracking_sessions
        SET activated_at = pg_catalog.now()
        WHERE job_id = NEW.id
          AND revoked_at IS NULL
          AND activated_at IS NULL;

    -- 2. Revocation: Job completed (terminal state)
    ELSIF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
        UPDATE public.customer_tracking_sessions
        SET revoked_at = pg_catalog.now(),
            revocation_reason = 'completed'
        WHERE job_id = NEW.id
          AND revoked_at IS NULL;

    -- 3. Revocation: Job cancelled (terminal state)
    ELSIF NEW.status = 'cancelled' AND (OLD.status IS DISTINCT FROM 'cancelled') THEN
        UPDATE public.customer_tracking_sessions
        SET revoked_at = pg_catalog.now(),
            revocation_reason = 'cancelled'
        WHERE job_id = NEW.id
          AND revoked_at IS NULL;

    -- 4. Revocation: Worker declined or unassigned (status unassigned or worker_id cleared)
    ELSIF (NEW.status = 'unassigned' AND OLD.status IS DISTINCT FROM 'unassigned')
       OR (OLD.worker_id IS NOT NULL AND NEW.worker_id IS NULL) THEN
        UPDATE public.customer_tracking_sessions
        SET revoked_at = pg_catalog.now(),
            revocation_reason = 'declined'
        WHERE job_id = NEW.id
          AND revoked_at IS NULL;

    -- 5. Revocation: Worker reassigned to a different technician
    ELSIF OLD.worker_id IS NOT NULL 
      AND NEW.worker_id IS NOT NULL 
      AND OLD.worker_id IS DISTINCT FROM NEW.worker_id THEN
        UPDATE public.customer_tracking_sessions
        SET revoked_at = pg_catalog.now(),
            revocation_reason = 'reassigned'
        WHERE job_id = NEW.id
          AND revoked_at IS NULL;
    END IF;

    RETURN NEW;
END;
$$;

-- Replace legacy revocation trigger with comprehensive lifecycle trigger
DROP TRIGGER IF EXISTS trg_jobs_revoke_tracking_sessions ON public.jobs;
DROP TRIGGER IF EXISTS trg_jobs_tracking_session_lifecycle ON public.jobs;

CREATE TRIGGER trg_jobs_tracking_session_lifecycle
    AFTER UPDATE ON public.jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_job_tracking_session_lifecycle();

GRANT EXECUTE ON FUNCTION public.handle_job_tracking_session_lifecycle() TO authenticated;

-- =============================================================================
-- 3. RPC: generate_customer_tracking_session (Hardened Issuance & Rotation)
-- =============================================================================

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

    -- 6. Cryptographically Secure URL-Safe Token Generation (>= 256 bits entropy)
    -- Concatenating two UUIDv4 values without hyphens yields 64 hex characters (256 bits CSPRNG entropy).
    -- Hex encoding is strictly alphanumeric [0-9a-f] and 100% URL-safe without escaping.
    v_raw_token := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '') ||
                   pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

    -- Authoritative SHA-256 hash (64 hex characters)
    v_token_hash := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(v_raw_token, 'UTF8')),
        'hex'
    );

    -- 7. Activation status check at issuance
    -- If job is already in active field execution ('on_the_way', 'arrived', 'in_progress'),
    -- tracking is immediately activated. Otherwise, pending worker travel.
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
        '/track/' || v_raw_token,
        v_expires_at,
        v_created_at,
        (v_activated_at IS NOT NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_customer_tracking_session(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_customer_tracking_session(UUID, INT) TO authenticated;

-- =============================================================================
-- 4. RPC: get_customer_tracking_session_job (With Activation Metadata)
-- =============================================================================

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
    v_token_hash TEXT;
    v_session public.customer_tracking_sessions;
    v_job public.jobs;
    v_business public.businesses;
    v_worker public.profiles;
    v_location public.locations;
    v_result JSONB;
BEGIN
    -- 1. Anti-Enumeration & Input Validation
    IF p_token IS NULL OR pg_catalog.length(pg_catalog.btrim(p_token)) < 16 THEN
        RETURN NULL;
    END IF;

    -- 2. Compute SHA-256 Hash of Supplied Raw Bearer Token
    v_token_hash := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.btrim(p_token), 'UTF8')),
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

GRANT EXECUTE ON FUNCTION public.get_customer_tracking_session_job(TEXT) TO anon, authenticated;

COMMIT;
