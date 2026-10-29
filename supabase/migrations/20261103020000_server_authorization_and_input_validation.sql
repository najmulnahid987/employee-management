-- =============================================================================
-- Migration: 20261103020000_server_authorization_and_input_validation.sql
-- Module: Dispatcher M18.2B — Server Authorization & Input Validation Hardening
--
-- Authoritative Specifications:
-- - docs/product-specification.md (Frozen Core Specification)
-- - AGENTS.md (M4, M7, M8, M9, M18 Security Architecture)
-- - docs/database-schema.md
--
-- Goals:
-- 1. Harden public.create_job() RPC with strict payload length bounds,
--    mandatory scheduled_at validation, and paired coordinate validation.
-- 2. Harden public.cancel_job() RPC with cancellation reason length bounds (1..1000).
-- 3. Harden public.decline_job_assignment() RPC with decline reason length bounds (<= 1000).
-- 4. Harden public.provision_business() RPC with business name, phone, address,
--    and owner full name length bounds.
-- 5. Harden public.join_business_team() RPC with invite code, full name, and phone bounds.
-- 6. Harden public.register_device_token() RPC with token, device name, and app version bounds.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. HARDEN create_job RPC (BOUNDS & COORDINATE INTEGRITY)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_job(
    p_customer_name TEXT,
    p_customer_phone TEXT,
    p_service TEXT,
    p_address TEXT,
    p_scheduled_at TIMESTAMPTZ,
    p_notes TEXT DEFAULT NULL,
    p_worker_id UUID DEFAULT NULL,
    p_latitude DOUBLE PRECISION DEFAULT NULL,
    p_longitude DOUBLE PRECISION DEFAULT NULL
)
RETURNS public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID;
    v_business_id UUID;
    v_worker_business_id UUID;
    v_worker_is_active BOOLEAN;
    v_worker_role TEXT;
    v_status TEXT;
    v_job public.jobs;
    v_trimmed_name TEXT;
    v_trimmed_phone TEXT;
    v_trimmed_service TEXT;
    v_trimmed_address TEXT;
    v_trimmed_notes TEXT;
BEGIN
    -- 1. Identity & Authorization Verification
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT app_auth.is_business_owner() THEN
        RAISE EXCEPTION 'Only business owners can create and dispatch jobs'
            USING ERRCODE = '42501';
    END IF;

    v_business_id := app_auth.current_business_id();
    IF v_business_id IS NULL THEN
        RAISE EXCEPTION 'Active business association not found for owner'
            USING ERRCODE = '42501';
    END IF;

    -- 2. Input Validation & Bounds
    v_trimmed_name := pg_catalog.btrim(COALESCE(p_customer_name, ''));
    IF pg_catalog.length(v_trimmed_name) = 0 OR pg_catalog.length(v_trimmed_name) > 200 THEN
        RAISE EXCEPTION 'Customer name must be between 1 and 200 characters'
            USING ERRCODE = '22023';
    END IF;

    v_trimmed_phone := pg_catalog.btrim(COALESCE(p_customer_phone, ''));
    IF pg_catalog.length(v_trimmed_phone) = 0 OR pg_catalog.length(v_trimmed_phone) > 50 THEN
        RAISE EXCEPTION 'Customer phone must be between 1 and 50 characters'
            USING ERRCODE = '22023';
    END IF;

    v_trimmed_service := pg_catalog.btrim(COALESCE(p_service, ''));
    IF pg_catalog.length(v_trimmed_service) = 0 OR pg_catalog.length(v_trimmed_service) > 200 THEN
        RAISE EXCEPTION 'Service description must be between 1 and 200 characters'
            USING ERRCODE = '22023';
    END IF;

    v_trimmed_address := pg_catalog.btrim(COALESCE(p_address, ''));
    IF pg_catalog.length(v_trimmed_address) = 0 OR pg_catalog.length(v_trimmed_address) > 500 THEN
        RAISE EXCEPTION 'Service site address must be between 1 and 500 characters'
            USING ERRCODE = '22023';
    END IF;

    IF p_scheduled_at IS NULL THEN
        RAISE EXCEPTION 'Scheduled arrival time is required'
            USING ERRCODE = '22023';
    END IF;

    v_trimmed_notes := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_notes, '')), '');
    IF v_trimmed_notes IS NOT NULL AND pg_catalog.length(v_trimmed_notes) > 4000 THEN
        RAISE EXCEPTION 'Notes cannot exceed 4000 characters'
            USING ERRCODE = '22023';
    END IF;

    -- Paired Coordinate Validation & Bounds
    IF (p_latitude IS NULL AND p_longitude IS NOT NULL) OR (p_latitude IS NOT NULL AND p_longitude IS NULL) THEN
        RAISE EXCEPTION 'Both latitude and longitude must be provided together'
            USING ERRCODE = '22023';
    END IF;

    IF p_latitude IS NOT NULL AND (p_latitude < -90.0 OR p_latitude > 90.0) THEN
        RAISE EXCEPTION 'Latitude must be between -90 and 90 degrees'
            USING ERRCODE = '22003';
    END IF;

    IF p_longitude IS NOT NULL AND (p_longitude < -180.0 OR p_longitude > 180.0) THEN
        RAISE EXCEPTION 'Longitude must be between -180 and 180 degrees'
            USING ERRCODE = '22003';
    END IF;

    -- 3. Worker Eligibility & Same-Business Invariant Check
    IF p_worker_id IS NOT NULL THEN
        SELECT p.business_id, p.is_active, p.role
        INTO v_worker_business_id, v_worker_is_active, v_worker_role
        FROM public.profiles p
        WHERE p.id = p_worker_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Selected worker profile not found'
                USING ERRCODE = 'P0002';
        END IF;

        IF v_worker_business_id IS DISTINCT FROM v_business_id THEN
            RAISE EXCEPTION 'Assigned worker must belong to the same business'
                USING ERRCODE = '42501';
        END IF;

        IF NOT v_worker_is_active THEN
            RAISE EXCEPTION 'Cannot assign an inactive worker'
                USING ERRCODE = 'P0001';
        END IF;

        IF v_worker_role != 'worker' THEN
            RAISE EXCEPTION 'Assigned profile must have worker role'
                USING ERRCODE = '42501';
        END IF;

        v_status := 'assigned';
    ELSE
        v_status := 'unassigned';
    END IF;

    -- 4. Atomic Job Insertion
    INSERT INTO public.jobs (
        business_id,
        customer_name,
        customer_phone,
        service,
        address,
        scheduled_at,
        notes,
        status,
        worker_id,
        latitude,
        longitude
    ) VALUES (
        v_business_id,
        v_trimmed_name,
        v_trimmed_phone,
        v_trimmed_service,
        v_trimmed_address,
        p_scheduled_at,
        v_trimmed_notes,
        v_status,
        p_worker_id,
        p_latitude,
        p_longitude
    )
    RETURNING * INTO v_job;

    RETURN v_job;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_job(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. HARDEN cancel_job RPC (REASON LENGTH BOUNDS)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_job(
    p_job_id UUID,
    p_cancellation_reason TEXT,
    p_expected_current_status TEXT DEFAULT NULL
)
RETURNS public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID;
    v_job public.jobs;
    v_trimmed_reason TEXT;
BEGIN
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT app_auth.is_business_owner() THEN
        RAISE EXCEPTION 'Only business owners can cancel jobs'
            USING ERRCODE = '42501';
    END IF;

    IF p_job_id IS NULL THEN
        RAISE EXCEPTION 'Job ID is required'
            USING ERRCODE = '22023';
    END IF;

    v_trimmed_reason := pg_catalog.btrim(COALESCE(p_cancellation_reason, ''));
    IF pg_catalog.length(v_trimmed_reason) = 0 OR pg_catalog.length(v_trimmed_reason) > 1000 THEN
        RAISE EXCEPTION 'Mandatory cancellation reason required (1 to 1000 characters)'
            USING ERRCODE = '22023';
    END IF;

    -- Row-level exclusive lock serializes concurrent transactions on this job
    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
      AND business_id = app_auth.current_business_id()
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found in your business'
            USING ERRCODE = 'P0002';
    END IF;

    -- Idempotency check: If already cancelled, return existing job cleanly
    IF v_job.status = 'cancelled' THEN
        RETURN v_job;
    END IF;

    -- Completed jobs cannot be cancelled
    IF v_job.status = 'completed' THEN
        RAISE EXCEPTION 'Cannot cancel a completed job'
            USING ERRCODE = 'P0001';
    END IF;

    -- Stale screen protection: conditional on expected current status
    IF p_expected_current_status IS NOT NULL AND v_job.status != p_expected_current_status THEN
        RAISE EXCEPTION 'Job status has changed (expected %, currently %). Please refresh to view the latest status', p_expected_current_status, v_job.status
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.jobs
    SET status = 'cancelled',
        cancellation_reason = v_trimmed_reason
    WHERE id = p_job_id
    RETURNING * INTO v_job;

    RETURN v_job;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_job(UUID, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. HARDEN decline_job_assignment RPC (REASON LENGTH BOUNDS)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decline_job_assignment(
    p_job_id UUID,
    p_decline_reason TEXT DEFAULT NULL,
    p_expected_current_status TEXT DEFAULT NULL
)
RETURNS public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID;
    v_job public.jobs;
    v_trimmed_reason TEXT;
BEGIN
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT app_auth.is_active_worker() THEN
        RAISE EXCEPTION 'Only active field workers can decline assignments'
            USING ERRCODE = '42501';
    END IF;

    IF p_job_id IS NULL THEN
        RAISE EXCEPTION 'Job ID is required'
            USING ERRCODE = '22023';
    END IF;

    v_trimmed_reason := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_decline_reason, '')), '');
    IF v_trimmed_reason IS NOT NULL AND pg_catalog.length(v_trimmed_reason) > 1000 THEN
        RAISE EXCEPTION 'Decline reason cannot exceed 1000 characters'
            USING ERRCODE = '22023';
    END IF;

    -- Row-level exclusive lock serializes concurrent transactions on this job
    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
      AND business_id = app_auth.current_business_id()
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found in your business'
            USING ERRCODE = 'P0002';
    END IF;

    -- Idempotency check: If already unassigned and this caller was the declining worker, return cleanly
    IF v_job.status = 'unassigned' AND v_job.worker_id IS NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.job_events
            WHERE job_id = p_job_id
              AND actor_id = v_caller_id
              AND event_type = 'declined'
        ) THEN
            RETURN v_job;
        END IF;
    END IF;

    -- Worker assignment check
    IF v_job.worker_id != v_caller_id THEN
        RAISE EXCEPTION 'Job is not assigned to you'
            USING ERRCODE = '42501';
    END IF;

    -- Terminal check
    IF v_job.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Job is in terminal status (%) and cannot be declined', v_job.status
            USING ERRCODE = 'P0001';
    END IF;

    -- Stale screen protection: conditional on expected current status
    IF p_expected_current_status IS NOT NULL AND v_job.status != p_expected_current_status THEN
        RAISE EXCEPTION 'Job status has changed (expected %, currently %). Please refresh to view the latest status', p_expected_current_status, v_job.status
            USING ERRCODE = 'P0001';
    END IF;

    IF v_job.status != 'assigned' THEN
        RAISE EXCEPTION 'Can only decline jobs in assigned status (currently %)', v_job.status
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.jobs
    SET worker_id = NULL, status = 'unassigned'
    WHERE id = p_job_id
    RETURNING * INTO v_job;

    RETURN v_job;
END;
$$;

GRANT EXECUTE ON FUNCTION public.decline_job_assignment(UUID, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. HARDEN provision_business RPC (FIELD LENGTH BOUNDS)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_business(
    p_name TEXT,
    p_phone TEXT,
    p_address TEXT DEFAULT NULL,
    p_owner_full_name TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID;
    v_caller_email TEXT;
    v_business_id UUID;
    v_full_name TEXT;
    v_trimmed_name TEXT;
    v_trimmed_phone TEXT;
    v_trimmed_address TEXT;
BEGIN
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    -- Verify that the caller does not already belong to any business
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_caller_id) THEN
        RAISE EXCEPTION 'User profile already exists and cannot provision a new business'
            USING ERRCODE = '42501';
    END IF;

    v_trimmed_name := pg_catalog.btrim(COALESCE(p_name, ''));
    IF pg_catalog.length(v_trimmed_name) = 0 OR pg_catalog.length(v_trimmed_name) > 200 THEN
        RAISE EXCEPTION 'Business name must be between 1 and 200 characters'
            USING ERRCODE = '22023';
    END IF;

    v_trimmed_phone := pg_catalog.btrim(COALESCE(p_phone, ''));
    IF pg_catalog.length(v_trimmed_phone) = 0 OR pg_catalog.length(v_trimmed_phone) > 50 THEN
        RAISE EXCEPTION 'Business phone must be between 1 and 50 characters'
            USING ERRCODE = '22023';
    END IF;

    v_trimmed_address := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_address, '')), '');
    IF v_trimmed_address IS NOT NULL AND pg_catalog.length(v_trimmed_address) > 500 THEN
        RAISE EXCEPTION 'Business address cannot exceed 500 characters'
            USING ERRCODE = '22023';
    END IF;

    v_full_name := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_owner_full_name, '')), '');
    IF v_full_name IS NOT NULL AND pg_catalog.length(v_full_name) > 200 THEN
        RAISE EXCEPTION 'Owner name cannot exceed 200 characters'
            USING ERRCODE = '22023';
    END IF;
    v_full_name := COALESCE(v_full_name, 'Business Owner');

    -- Resolve email from auth.users store
    SELECT email INTO v_caller_email
    FROM auth.users
    WHERE id = v_caller_id;

    IF v_caller_email IS NULL THEN
        RAISE EXCEPTION 'User email not found in authentication store'
            USING ERRCODE = 'P0002';
    END IF;

    -- 1. Create Business
    INSERT INTO public.businesses (name, phone, address)
    VALUES (v_trimmed_name, v_trimmed_phone, v_trimmed_address)
    RETURNING id INTO v_business_id;

    -- 2. Create Owner Profile
    INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active)
    VALUES (v_caller_id, v_business_id, v_full_name, v_caller_email, v_trimmed_phone, 'owner', true);

    -- 3. Create Trial Subscription
    INSERT INTO public.subscriptions (business_id, status, trial_start, trial_end)
    VALUES (
        v_business_id,
        'trialing',
        pg_catalog.now(),
        pg_catalog.now() + interval '14 days'
    );

    RETURN v_business_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.provision_business(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. HARDEN join_business_team RPC (INPUT BOUNDS)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.join_business_team(
    p_invite_code TEXT,
    p_full_name TEXT,
    p_phone TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID;
    v_caller_email TEXT;
    v_inv RECORD;
    v_trimmed_code TEXT;
    v_trimmed_name TEXT;
    v_trimmed_phone TEXT;
BEGIN
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    -- Verify caller does not already have an active profile
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_caller_id) THEN
        RAISE EXCEPTION 'User profile already exists and cannot join a new business'
            USING ERRCODE = '42501';
    END IF;

    v_trimmed_code := pg_catalog.btrim(COALESCE(p_invite_code, ''));
    IF pg_catalog.length(v_trimmed_code) = 0 OR pg_catalog.length(v_trimmed_code) > 50 THEN
        RAISE EXCEPTION 'Invalid invitation code format'
            USING ERRCODE = '22023';
    END IF;

    v_trimmed_name := pg_catalog.btrim(COALESCE(p_full_name, ''));
    IF pg_catalog.length(v_trimmed_name) = 0 OR pg_catalog.length(v_trimmed_name) > 200 THEN
        RAISE EXCEPTION 'Full name must be between 1 and 200 characters'
            USING ERRCODE = '22023';
    END IF;

    v_trimmed_phone := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_phone, '')), '');
    IF v_trimmed_phone IS NOT NULL AND pg_catalog.length(v_trimmed_phone) > 50 THEN
        RAISE EXCEPTION 'Phone number cannot exceed 50 characters'
            USING ERRCODE = '22023';
    END IF;

    -- Lock and validate invitation
    SELECT id, business_id, is_used, expires_at
    INTO v_inv
    FROM public.worker_invitations
    WHERE upper(invite_code) = upper(v_trimmed_code)
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid invitation code'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_inv.is_used THEN
        RAISE EXCEPTION 'This invitation code has already been used'
            USING ERRCODE = '22023';
    END IF;

    IF v_inv.expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'This invitation code has expired'
            USING ERRCODE = '22023';
    END IF;

    -- Fetch user email from auth.users
    SELECT email INTO v_caller_email
    FROM auth.users
    WHERE id = v_caller_id;

    IF v_caller_email IS NULL THEN
        RAISE EXCEPTION 'User email not found in authentication store'
            USING ERRCODE = 'P0002';
    END IF;

    -- Atomically insert profile with role 'worker'
    INSERT INTO public.profiles (
        id,
        business_id,
        full_name,
        email,
        phone,
        role,
        is_active
    ) VALUES (
        v_caller_id,
        v_inv.business_id,
        v_trimmed_name,
        v_caller_email,
        v_trimmed_phone,
        'worker',
        true
    );

    -- Burn the invitation
    UPDATE public.worker_invitations
    SET
        is_used = true,
        used_by = v_caller_id,
        updated_at = clock_timestamp()
    WHERE id = v_inv.id;

    RETURN v_inv.business_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_business_team(TEXT, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. HARDEN register_device_token RPC (INPUT BOUNDS)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_device_token(
    p_expo_push_token TEXT,
    p_device_platform TEXT DEFAULT 'unknown',
    p_device_name TEXT DEFAULT NULL,
    p_app_version TEXT DEFAULT NULL
)
RETURNS public.device_tokens
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID;
    v_business_id UUID;
    v_is_active BOOLEAN;
    v_token_record public.device_tokens;
    v_clean_token TEXT;
    v_clean_platform TEXT;
    v_clean_name TEXT;
    v_clean_version TEXT;
BEGIN
    -- 1. Validate authenticated identity
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required to register device token'
            USING ERRCODE = '42501';
    END IF;

    -- 2. Validate token format and bounds
    v_clean_token := pg_catalog.btrim(COALESCE(p_expo_push_token, ''));
    IF pg_catalog.length(v_clean_token) < 10 OR pg_catalog.length(v_clean_token) > 500 THEN
        RAISE EXCEPTION 'Invalid push token format: token must be between 10 and 500 characters'
            USING ERRCODE = '22023';
    END IF;

    -- 3. Normalize platform
    v_clean_platform := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_device_platform, 'unknown')));
    IF v_clean_platform NOT IN ('ios', 'android', 'web', 'unknown') THEN
        v_clean_platform := 'unknown';
    END IF;

    v_clean_name := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_device_name, '')), '');
    IF v_clean_name IS NOT NULL AND pg_catalog.length(v_clean_name) > 200 THEN
        RAISE EXCEPTION 'Device name cannot exceed 200 characters'
            USING ERRCODE = '22023';
    END IF;

    v_clean_version := pg_catalog.nullif(pg_catalog.btrim(COALESCE(p_app_version, '')), '');
    IF v_clean_version IS NOT NULL AND pg_catalog.length(v_clean_version) > 50 THEN
        RAISE EXCEPTION 'App version cannot exceed 50 characters'
            USING ERRCODE = '22023';
    END IF;

    -- 4. Retrieve caller profile and business
    SELECT p.business_id, p.is_active
    INTO v_business_id, v_is_active
    FROM public.profiles p
    WHERE p.id = v_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User profile not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_is_active IS FALSE THEN
        RAISE EXCEPTION 'User account is deactivated'
            USING ERRCODE = '42501';
    END IF;

    IF v_business_id IS NULL THEN
        RAISE EXCEPTION 'User is not associated with an active business'
            USING ERRCODE = '42501';
    END IF;

    -- 5. Atomic Upsert on expo_push_token
    INSERT INTO public.device_tokens (
        user_id,
        business_id,
        expo_push_token,
        device_platform,
        device_name,
        app_version,
        is_active,
        created_at,
        updated_at,
        last_used_at
    ) VALUES (
        v_user_id,
        v_business_id,
        v_clean_token,
        v_clean_platform,
        v_clean_name,
        v_clean_version,
        true,
        pg_catalog.now(),
        pg_catalog.now(),
        pg_catalog.now()
    )
    ON CONFLICT (expo_push_token) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        business_id = EXCLUDED.business_id,
        device_platform = EXCLUDED.device_platform,
        device_name = COALESCE(EXCLUDED.device_name, device_tokens.device_name),
        app_version = COALESCE(EXCLUDED.app_version, device_tokens.app_version),
        is_active = true,
        updated_at = pg_catalog.now(),
        last_used_at = pg_catalog.now()
    RETURNING * INTO v_token_record;

    RETURN v_token_record;
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_device_token(TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMIT;

