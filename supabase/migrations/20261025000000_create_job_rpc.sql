-- Dispatcher MVP M7.2: Create Job & Atomic Assignment RPC Migration
-- Authoritative Spec: docs/product-specification.md
-- Enables business owners to atomically create a service job and optionally assign an active worker.
-- Strictly preserves business isolation, RLS, and trigger-driven append-only event logging.

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
BEGIN
    -- 1. Identity & Authorization Verification
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF NOT app_auth.is_business_owner() THEN
        RAISE EXCEPTION 'Only business owners can create and dispatch jobs';
    END IF;

    v_business_id := app_auth.current_business_id();
    IF v_business_id IS NULL THEN
        RAISE EXCEPTION 'Active business association not found for owner';
    END IF;

    -- 2. Input Validation
    IF p_customer_name IS NULL OR length(pg_catalog.btrim(p_customer_name)) = 0 THEN
        RAISE EXCEPTION 'Customer name is required';
    END IF;

    IF p_customer_phone IS NULL OR length(pg_catalog.btrim(p_customer_phone)) = 0 THEN
        RAISE EXCEPTION 'Customer phone is required';
    END IF;

    IF p_service IS NULL OR length(pg_catalog.btrim(p_service)) = 0 THEN
        RAISE EXCEPTION 'Service description is required';
    END IF;

    IF p_address IS NULL OR length(pg_catalog.btrim(p_address)) = 0 THEN
        RAISE EXCEPTION 'Service site address is required';
    END IF;

    -- Coordinate bounds validation if supplied
    IF p_latitude IS NOT NULL AND (p_latitude < -90.0 OR p_latitude > 90.0) THEN
        RAISE EXCEPTION 'Latitude must be between -90 and 90 degrees';
    END IF;

    IF p_longitude IS NOT NULL AND (p_longitude < -180.0 OR p_longitude > 180.0) THEN
        RAISE EXCEPTION 'Longitude must be between -180 and 180 degrees';
    END IF;

    -- 3. Worker Eligibility & Same-Business Invariant Check
    IF p_worker_id IS NOT NULL THEN
        SELECT p.business_id, p.is_active, p.role
        INTO v_worker_business_id, v_worker_is_active, v_worker_role
        FROM public.profiles p
        WHERE p.id = p_worker_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Selected worker profile not found';
        END IF;

        IF v_worker_business_id IS DISTINCT FROM v_business_id THEN
            RAISE EXCEPTION 'Assigned worker must belong to the same business';
        END IF;

        IF NOT v_worker_is_active THEN
            RAISE EXCEPTION 'Cannot assign an inactive worker';
        END IF;

        IF v_worker_role != 'worker' THEN
            RAISE EXCEPTION 'Assigned profile must have worker role';
        END IF;

        v_status := 'assigned';
    ELSE
        v_status := 'unassigned';
    END IF;

    -- 4. Atomic Job Insertion
    -- Fires BEFORE INSERT trigger: sync_job_lifecycle_timestamps (sets assigned_at if assigned)
    -- Fires AFTER INSERT trigger: handle_job_event_logging (creates job_created + worker_assigned events)
    INSERT INTO public.jobs (
        business_id,
        worker_id,
        customer_name,
        customer_phone,
        service,
        address,
        latitude,
        longitude,
        notes,
        scheduled_at,
        status
    ) VALUES (
        v_business_id,
        p_worker_id,
        pg_catalog.btrim(p_customer_name),
        pg_catalog.btrim(p_customer_phone),
        pg_catalog.btrim(p_service),
        pg_catalog.btrim(p_address),
        p_latitude,
        p_longitude,
        NULLIF(pg_catalog.btrim(p_notes), ''),
        p_scheduled_at,
        v_status
    )
    RETURNING * INTO v_job;

    RETURN v_job;
END;
$$;

-- Security: Restrict execution to authenticated callers only
REVOKE ALL ON FUNCTION public.create_job(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_job(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
