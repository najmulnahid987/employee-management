-- =============================================================================
-- Migration: 20261028010000_customer_tracking_sessions.sql
-- Module: Dispatcher M13.2 — Customer Tracking Session Storage & Migration
--
-- Authoritative Specifications:
-- - docs/product-specification.md (Section 4: Customer Tracking Web Page)
-- - AGENTS.md (M4 & M13 Security Architecture)
--
-- Goals:
-- 1. Create public.customer_tracking_sessions table to manage secure, token-hashed tracking links.
-- 2. Store only 64-character SHA-256 cryptographic hashes of raw bearer tokens, never plaintext tokens.
-- 3. Enforce global token hash uniqueness and single active session per job constraint.
-- 4. Automatically revoke active sessions on worker decline, unassign, reassignment, completion, or cancellation.
-- 5. Provide owner-authorized RPCs to generate and revoke tracking sessions with server-controlled timestamps.
-- 6. Provide public unauthenticated RPC to validate tokens, enforce 24h/lifecycle expiry, and return allowlisted fields.
-- 7. Strictly revoke direct table access (SELECT, INSERT, UPDATE, DELETE) from anonymous role.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. TABLE: customer_tracking_sessions
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.customer_tracking_sessions (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    worker_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    token_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,

    -- Global uniqueness: no two sessions can ever share the same token hash
    CONSTRAINT uq_tracking_sessions_token_hash UNIQUE (token_hash),

    -- Exact 64-character hex length check for SHA-256 digest
    CONSTRAINT chk_tracking_sessions_token_hash_len CHECK (pg_catalog.length(token_hash) = 64),

    -- Expiry timestamp must strictly be in the future of creation
    CONSTRAINT chk_tracking_sessions_expiry CHECK (expires_at > created_at),

    -- Revocation timestamp cannot precede creation
    CONSTRAINT chk_tracking_sessions_revocation CHECK (revoked_at IS NULL OR revoked_at >= created_at),

    -- Permitted revocation reasons
    CONSTRAINT chk_tracking_sessions_revocation_reason CHECK (
        revocation_reason IS NULL OR revocation_reason IN (
            'completed',
            'cancelled',
            'declined',
            'reassigned',
            'owner_revoked',
            'expired',
            'superseded'
        )
    ),

    -- Composite foreign key enforcing worker belongs to the exact same business
    CONSTRAINT fk_tracking_sessions_worker_business FOREIGN KEY (worker_id, business_id)
        REFERENCES public.profiles(id, business_id)
        ON DELETE SET NULL
);

-- =============================================================================
-- 2. INDEXES
-- =============================================================================

-- Partial unique index: at most one active (unrevoked) session per job
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_sessions_active_job 
    ON public.customer_tracking_sessions (job_id) 
    WHERE revoked_at IS NULL;

-- Fast index for token verification lookups on active sessions
CREATE INDEX IF NOT EXISTS idx_tracking_sessions_token_hash_active 
    ON public.customer_tracking_sessions (token_hash) 
    WHERE revoked_at IS NULL;

-- Business isolation index
CREATE INDEX IF NOT EXISTS idx_tracking_sessions_business 
    ON public.customer_tracking_sessions (business_id);

-- Job relational index
CREATE INDEX IF NOT EXISTS idx_tracking_sessions_job 
    ON public.customer_tracking_sessions (job_id);

-- =============================================================================
-- 3. ROW LEVEL SECURITY (RLS) & ACCESS CONTROL
-- =============================================================================

ALTER TABLE public.customer_tracking_sessions ENABLE ROW LEVEL SECURITY;

-- 3.1 Revoke ALL direct table operations from anonymous role
REVOKE ALL ON public.customer_tracking_sessions FROM anon;

-- 3.2 Revoke default mutations from authenticated role
REVOKE INSERT, UPDATE, DELETE ON public.customer_tracking_sessions FROM authenticated;

-- 3.3 Grant SELECT only to authenticated role, filtered by RLS
GRANT SELECT ON public.customer_tracking_sessions TO authenticated;

-- 3.4 Owner SELECT Policy: Owners can only read sessions belonging to their business
DROP POLICY IF EXISTS "tracking_sessions_owner_select" ON public.customer_tracking_sessions;
CREATE POLICY "tracking_sessions_owner_select"
    ON public.customer_tracking_sessions
    FOR SELECT
    TO authenticated
    USING (
        business_id = app_auth.current_business_id()
        AND app_auth.is_business_owner()
    );

-- =============================================================================
-- 4. AUTOMATIC LIFECYCLE REVOCATION TRIGGER ON public.jobs
-- =============================================================================

CREATE OR REPLACE FUNCTION public.handle_job_tracking_session_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- 1. Job Terminal: Completed
    IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
        UPDATE public.customer_tracking_sessions
        SET revoked_at = pg_catalog.now(),
            revocation_reason = 'completed'
        WHERE job_id = NEW.id
          AND revoked_at IS NULL;

    -- 2. Job Terminal: Cancelled
    ELSIF NEW.status = 'cancelled' AND (OLD.status IS DISTINCT FROM 'cancelled') THEN
        UPDATE public.customer_tracking_sessions
        SET revoked_at = pg_catalog.now(),
            revocation_reason = 'cancelled'
        WHERE job_id = NEW.id
          AND revoked_at IS NULL;

    -- 3. Job Unassigned or Assignment Cleared (Worker decline or Owner unassign)
    ELSIF (NEW.status = 'unassigned' AND OLD.status IS DISTINCT FROM 'unassigned')
       OR (OLD.worker_id IS NOT NULL AND NEW.worker_id IS NULL) THEN
        UPDATE public.customer_tracking_sessions
        SET revoked_at = pg_catalog.now(),
            revocation_reason = 'declined'
        WHERE job_id = NEW.id
          AND revoked_at IS NULL;

    -- 4. Worker Reassignment (Assigned to a different technician)
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

DROP TRIGGER IF EXISTS trg_jobs_revoke_tracking_sessions ON public.jobs;
CREATE TRIGGER trg_jobs_revoke_tracking_sessions
    AFTER UPDATE ON public.jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_job_tracking_session_revocation();

GRANT EXECUTE ON FUNCTION public.handle_job_tracking_session_revocation() TO authenticated;

-- =============================================================================
-- 5. RPC: generate_customer_tracking_session (Business Owner)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.generate_customer_tracking_session(
    p_job_id UUID,
    p_duration_hours INT DEFAULT 24
)
RETURNS TABLE (
    session_id UUID,
    job_id UUID,
    raw_token TEXT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
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
BEGIN
    -- 1. Identity & Role Verification
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

    -- 2. Verify Job Ownership & Lifecycle Eligibility
    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
      AND business_id = v_business_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job % not found in your business.', p_job_id
            USING ERRCODE = '42501';
    END IF;

    IF v_job.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Cannot generate tracking session for job in terminal status "%".', v_job.status
            USING ERRCODE = 'P0001';
    END IF;

    -- 3. Duration Policy & Validation (Default: 24h, Min: 1h, Max: 72h)
    v_duration := COALESCE(p_duration_hours, 24);
    IF v_duration < 1 OR v_duration > 72 THEN
        RAISE EXCEPTION 'Tracking session duration must be between 1 and 72 hours.'
            USING ERRCODE = '22023';
    END IF;

    v_expires_at := pg_catalog.now() + (v_duration || ' hours')::interval;

    -- 4. Atomically Revoke Any Existing Active Session for This Job (Supersede)
    UPDATE public.customer_tracking_sessions
    SET revoked_at = pg_catalog.now(),
        revocation_reason = 'superseded'
    WHERE customer_tracking_sessions.job_id = p_job_id
      AND customer_tracking_sessions.revoked_at IS NULL;

    -- 5. Cryptographically Secure Token Generation
    -- Generate 256 bits of CSPRNG randomness via two concatenated UUIDv4s without hyphens
    v_raw_token := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '') ||
                   pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

    -- Authoritative SHA-256 hash (64 hex characters)
    v_token_hash := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(v_raw_token, 'UTF8')),
        'hex'
    );

    -- 6. Insert New Session Record (Storing Hash ONLY)
    INSERT INTO public.customer_tracking_sessions (
        job_id,
        business_id,
        worker_id,
        token_hash,
        created_at,
        expires_at
    ) VALUES (
        v_job.id,
        v_business_id,
        v_job.worker_id,
        v_token_hash,
        pg_catalog.now(),
        v_expires_at
    )
    RETURNING customer_tracking_sessions.id, customer_tracking_sessions.created_at
    INTO v_session_id, v_created_at;

    -- 7. Return One-Time Bearer Credentials
    RETURN QUERY
    SELECT
        v_session_id,
        v_job.id,
        v_raw_token,
        v_expires_at,
        v_created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_customer_tracking_session(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_customer_tracking_session(UUID, INT) TO authenticated;

-- =============================================================================
-- 6. RPC: revoke_customer_tracking_session (Business Owner)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.revoke_customer_tracking_session(
    p_job_id UUID,
    p_reason TEXT DEFAULT 'owner_revoked'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID;
    v_business_id UUID;
    v_revoked_count INT;
BEGIN
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required to revoke tracking session.'
            USING ERRCODE = '42501';
    END IF;

    IF NOT app_auth.is_business_owner() THEN
        RAISE EXCEPTION 'Only business owners can revoke customer tracking sessions.'
            USING ERRCODE = '42501';
    END IF;

    v_business_id := app_auth.current_business_id();
    IF v_business_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated owner is not linked to an active business tenant.'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.customer_tracking_sessions
    SET revoked_at = pg_catalog.now(),
        revocation_reason = COALESCE(p_reason, 'owner_revoked')
    WHERE job_id = p_job_id
      AND business_id = v_business_id
      AND revoked_at IS NULL;

    GET DIAGNOSTICS v_revoked_count = ROW_COUNT;
    RETURN v_revoked_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_customer_tracking_session(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_customer_tracking_session(UUID, TEXT) TO authenticated;

-- =============================================================================
-- 7. RPC: get_customer_tracking_session_job (Public / Unauthenticated)
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

    -- 2. Compute SHA-256 Hash of Supplied Raw Token
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

    -- 7. Live Location Join (Only for Approved Active Tracking Stages)
    IF v_job.status IN ('on_the_way', 'arrived', 'in_progress') AND v_job.worker_id IS NOT NULL THEN
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
                    'recorded_at', v_location.created_at
                )
            ELSE NULL
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
