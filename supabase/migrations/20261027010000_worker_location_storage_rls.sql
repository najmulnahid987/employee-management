-- =============================================================================
-- Migration: 20261027010000_worker_location_storage_rls.sql
-- Module: Dispatcher M11.2 — Location Storage and RLS
--
-- Authoritative Specifications:
-- - docs/product-specification.md
-- - AGENTS.md (M4 & M11 Architecture)
--
-- Goals:
-- 1. Transition public.locations from append-only audit trail to latest-location-only model.
-- 2. Enforce one current location row per (worker_id, job_id) via UNIQUE constraint.
-- 3. Restrict worker writes strictly to authenticated worker, active assigned jobs,
--    and approved tracking statuses ('on_the_way', 'arrived', 'in_progress').
-- 4. Forbid ambient tracking (job_id IS NULL) and forbid writing for unassigned/terminal jobs.
-- 5. Prevent worker identity / job tampering during updates via trigger validation.
-- 6. Enforce authoritative server timestamps (now()) on all inserts and updates.
-- 7. Add atomic record_worker_location() and get_owner_active_locations() RPCs.
-- 8. Add public.locations to supabase_realtime publication for live dispatch updates.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. DROP OBSOLETE IMMUTABILITY TRIGGER PREVENTING UPDATES
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_prevent_locations_mutation ON public.locations;
DROP FUNCTION IF EXISTS public.prevent_locations_mutation();

-- -----------------------------------------------------------------------------
-- 2. DEDUPLICATE EXISTING TELEMETRY & ADD UNIQUE CONSTRAINT
-- -----------------------------------------------------------------------------
-- Deduplicate any existing historical samples: retain only the newest sample per (worker_id, job_id)
DELETE FROM public.locations l1
USING public.locations l2
WHERE l1.worker_id = l2.worker_id
  AND l1.job_id = l2.job_id
  AND l1.job_id IS NOT NULL
  AND (
      l1.created_at < l2.created_at
      OR (l1.created_at = l2.created_at AND l1.id < l2.id)
  );

-- For any legacy ambient rows where job_id is null, retain at most one newest row per worker
DELETE FROM public.locations l1
USING public.locations l2
WHERE l1.worker_id = l2.worker_id
  AND l1.job_id IS NULL
  AND l2.job_id IS NULL
  AND (
      l1.created_at < l2.created_at
      OR (l1.created_at = l2.created_at AND l1.id < l2.id)
  );

-- Add unique constraint ensuring exactly one current location row per (worker_id, job_id)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_locations_worker_job'
          AND conrelid = 'public.locations'::regclass
    ) THEN
        ALTER TABLE public.locations
            ADD CONSTRAINT uq_locations_worker_job UNIQUE (worker_id, job_id);
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. TRIGGER: ENFORCE IDENTITY IMMUTABILITY & AUTHORITATIVE TIMESTAMPS
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.locations_enforce_identity_and_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- 1. Forbid client-initiated DELETION of location records
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'locations table records cannot be deleted by client applications.'
            USING ERRCODE = '42501';
    END IF;

    -- 2. On UPDATE, prevent identity tampering and authoritatively stamp created_at
    IF TG_OP = 'UPDATE' THEN
        IF NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
            RAISE EXCEPTION 'Cannot modify worker_id of an existing location record.'
                USING ERRCODE = '42501';
        END IF;

        IF NEW.job_id IS DISTINCT FROM OLD.job_id THEN
            RAISE EXCEPTION 'Cannot modify job_id of an existing location record.'
                USING ERRCODE = '42501';
        END IF;

        IF NEW.id IS DISTINCT FROM OLD.id THEN
            RAISE EXCEPTION 'Cannot modify primary key id of a location record.'
                USING ERRCODE = '42501';
        END IF;

        -- Authoritative server timestamp (disregards any client-supplied timestamp)
        NEW.created_at := now();
    END IF;

    -- 3. On INSERT, authoritatively set created_at
    IF TG_OP = 'INSERT' THEN
        NEW.created_at := now();
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_locations_enforce_identity_and_timestamp ON public.locations;
CREATE TRIGGER trg_locations_enforce_identity_and_timestamp
    BEFORE INSERT OR UPDATE OR DELETE ON public.locations
    FOR EACH ROW
    EXECUTE FUNCTION public.locations_enforce_identity_and_timestamp();

-- -----------------------------------------------------------------------------
-- 4. TABLE PERMISSIONS & PRIVILEGES
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.locations FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.locations TO authenticated;
REVOKE DELETE ON public.locations FROM authenticated;
GRANT EXECUTE ON FUNCTION public.locations_enforce_identity_and_timestamp() TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY (RLS) POLICIES
-- -----------------------------------------------------------------------------
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

-- 5.1 Owner SELECT: Owners can read locations of workers in their business
DROP POLICY IF EXISTS "locations_owner_select" ON public.locations;
CREATE POLICY "locations_owner_select"
    ON public.locations
    FOR SELECT
    TO authenticated
    USING (
        app_auth.is_business_owner()
        AND EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = locations.worker_id
              AND p.business_id = app_auth.current_business_id()
        )
    );

-- 5.2 Worker SELECT: Workers can read their own location record
DROP POLICY IF EXISTS "locations_worker_select" ON public.locations;
CREATE POLICY "locations_worker_select"
    ON public.locations
    FOR SELECT
    TO authenticated
    USING (
        worker_id = (SELECT auth.uid())
    );

-- 5.3 Worker INSERT:
-- - Restricted to authenticated worker
-- - Must be an active worker
-- - job_id must NOT be null (no ambient tracking)
-- - Job must be currently assigned to the worker
-- - Job must be in the worker's business
-- - Job must be in an approved active status ('on_the_way', 'arrived', 'in_progress')
DROP POLICY IF EXISTS "locations_worker_insert" ON public.locations;
CREATE POLICY "locations_worker_insert"
    ON public.locations
    FOR INSERT
    TO authenticated
    WITH CHECK (
        worker_id = (SELECT auth.uid())
        AND app_auth.is_active_worker()
        AND job_id IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM public.jobs j
            WHERE j.id = locations.job_id
              AND j.worker_id = (SELECT auth.uid())
              AND j.business_id = app_auth.current_business_id()
              AND j.status IN ('on_the_way', 'arrived', 'in_progress')
        )
    );

-- 5.4 Worker UPDATE:
-- - Same strict checks as INSERT applied to existing and modified rows
DROP POLICY IF EXISTS "locations_worker_update" ON public.locations;
CREATE POLICY "locations_worker_update"
    ON public.locations
    FOR UPDATE
    TO authenticated
    USING (
        worker_id = (SELECT auth.uid())
        AND app_auth.is_active_worker()
        AND job_id IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM public.jobs j
            WHERE j.id = locations.job_id
              AND j.worker_id = (SELECT auth.uid())
              AND j.business_id = app_auth.current_business_id()
              AND j.status IN ('on_the_way', 'arrived', 'in_progress')
        )
    )
    WITH CHECK (
        worker_id = (SELECT auth.uid())
        AND app_auth.is_active_worker()
        AND job_id IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM public.jobs j
            WHERE j.id = locations.job_id
              AND j.worker_id = (SELECT auth.uid())
              AND j.business_id = app_auth.current_business_id()
              AND j.status IN ('on_the_way', 'arrived', 'in_progress')
        )
    );

-- -----------------------------------------------------------------------------
-- 6. TRANSACTIONAL RPC: record_worker_location
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_worker_location(
    p_job_id UUID,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_accuracy DOUBLE PRECISION DEFAULT NULL
)
RETURNS public.locations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_worker_id UUID;
    v_business_id UUID;
    v_job_status TEXT;
    v_record public.locations;
BEGIN
    -- 1. Identify caller
    v_worker_id := auth.uid();
    IF v_worker_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required to record worker location.'
            USING ERRCODE = '42501';
    END IF;

    -- 2. Verify worker active status and business tenancy
    IF NOT app_auth.is_active_worker() THEN
        RAISE EXCEPTION 'Worker account is inactive or not authorized to record location.'
            USING ERRCODE = '42501';
    END IF;

    v_business_id := app_auth.current_business_id();
    IF v_business_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated user is not linked to an active business tenant.'
            USING ERRCODE = '42501';
    END IF;

    -- 3. Validate coordinate bounds
    IF p_latitude IS NULL OR p_latitude < -90.0 OR p_latitude > 90.0 THEN
        RAISE EXCEPTION 'Invalid latitude: must be between -90.0 and 90.0.'
            USING ERRCODE = '22003';
    END IF;

    IF p_longitude IS NULL OR p_longitude < -180.0 OR p_longitude > 180.0 THEN
        RAISE EXCEPTION 'Invalid longitude: must be between -180.0 and 180.0.'
            USING ERRCODE = '22003';
    END IF;

    IF p_accuracy IS NOT NULL AND p_accuracy < 0.0 THEN
        RAISE EXCEPTION 'Invalid accuracy: must be non-negative.'
            USING ERRCODE = '22003';
    END IF;

    -- 4. Validate job assignment and eligible tracking status
    IF p_job_id IS NULL THEN
        RAISE EXCEPTION 'A valid job_id is required to record worker location.'
            USING ERRCODE = '23502';
    END IF;

    SELECT j.status INTO v_job_status
    FROM public.jobs j
    WHERE j.id = p_job_id
      AND j.worker_id = v_worker_id
      AND j.business_id = v_business_id;

    IF v_job_status IS NULL THEN
        RAISE EXCEPTION 'Job % is not assigned to the authenticated worker in this business.', p_job_id
            USING ERRCODE = '42501';
    END IF;

    IF v_job_status NOT IN ('on_the_way', 'arrived', 'in_progress') THEN
        RAISE EXCEPTION 'Job % is in status "%", which is not eligible for location tracking.', p_job_id, v_job_status
            USING ERRCODE = 'P0001';
    END IF;

    -- 5. Atomic Upsert: overwrite previous position for this (worker_id, job_id)
    INSERT INTO public.locations (
        worker_id,
        job_id,
        latitude,
        longitude,
        accuracy,
        created_at
    )
    VALUES (
        v_worker_id,
        p_job_id,
        p_latitude,
        p_longitude,
        p_accuracy,
        now()
    )
    ON CONFLICT (worker_id, job_id)
    DO UPDATE SET
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        accuracy = EXCLUDED.accuracy,
        created_at = now()
    RETURNING * INTO v_record;

    RETURN v_record;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_worker_location(UUID, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;

-- -----------------------------------------------------------------------------
-- 7. TRANSACTIONAL RPC: get_owner_active_locations
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_owner_active_locations()
RETURNS TABLE (
    location_id UUID,
    worker_id UUID,
    worker_name TEXT,
    worker_avatar_url TEXT,
    job_id UUID,
    job_service TEXT,
    job_address TEXT,
    job_status TEXT,
    destination_latitude DOUBLE PRECISION,
    destination_longitude DOUBLE PRECISION,
    worker_latitude DOUBLE PRECISION,
    worker_longitude DOUBLE PRECISION,
    accuracy DOUBLE PRECISION,
    recorded_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_business_id UUID;
BEGIN
    IF NOT app_auth.is_business_owner() THEN
        RAISE EXCEPTION 'Only business owners can access active territory locations.'
            USING ERRCODE = '42501';
    END IF;

    v_business_id := app_auth.current_business_id();
    IF v_business_id IS NULL THEN
        RAISE EXCEPTION 'Owner is not associated with an active business.'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        l.id AS location_id,
        l.worker_id,
        p.full_name AS worker_name,
        p.avatar_url AS worker_avatar_url,
        j.id AS job_id,
        j.service AS job_service,
        j.address AS job_address,
        j.status AS job_status,
        j.latitude AS destination_latitude,
        j.longitude AS destination_longitude,
        l.latitude AS worker_latitude,
        l.longitude AS worker_longitude,
        l.accuracy,
        l.created_at AS recorded_at
    FROM public.locations l
    INNER JOIN public.jobs j ON j.id = l.job_id
    INNER JOIN public.profiles p ON p.id = l.worker_id
    WHERE j.business_id = v_business_id
      AND p.business_id = v_business_id
      AND j.status IN ('on_the_way', 'arrived', 'in_progress')
    ORDER BY l.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_owner_active_locations() TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. SUPABASE REALTIME CDC PUBLICATION
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'locations'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.locations;
    END IF;
END $$;

COMMIT;
