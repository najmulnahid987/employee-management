-- =============================================================================
-- Migration: 20261104010000_worker_ambient_location_sharing.sql
-- Module: Worker Standby / Ambient Live Location Sharing
--
-- Authoritative Specifications:
-- - docs/product-specification.md
-- - AGENTS.md (M4 Security: "worker: INSERT own locations for assigned active jobs (or ambient with job_id IS NULL)")
--
-- Goals:
-- 1. Support ambient/standby live location tracking where job_id is NULL.
-- 2. Add partial unique index on public.locations (worker_id) WHERE job_id IS NULL.
-- 3. Relax RLS policies (locations_worker_insert, locations_worker_update) to permit
--    active workers to record their own location with job_id IS NULL.
-- 4. Update record_worker_location RPC to accept p_job_id DEFAULT NULL and handle
--    ambient location upserts for authenticated active workers.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. DEDUPLICATE AMBIENT LOCATIONS & ADD UNIQUE PARTIAL INDEX
-- -----------------------------------------------------------------------------
-- Deduplicate any existing ambient rows (job_id IS NULL): retain newest sample per worker
DELETE FROM public.locations l1
USING public.locations l2
WHERE l1.worker_id = l2.worker_id
  AND l1.job_id IS NULL
  AND l2.job_id IS NULL
  AND (
      l1.created_at < l2.created_at
      OR (l1.created_at = l2.created_at AND l1.id < l2.id)
  );

-- Partial unique index ensuring exactly one ambient location row per worker
CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_worker_ambient
    ON public.locations (worker_id)
    WHERE job_id IS NULL;

-- -----------------------------------------------------------------------------
-- 2. RELAX RLS POLICIES FOR AMBIENT WORKER LOCATION WRITES
-- -----------------------------------------------------------------------------

-- 2.1 Worker INSERT:
-- Active workers can insert their own location:
-- - Ambiently (job_id IS NULL)
-- - Or for an active assigned field visit (job_id in 'on_the_way', 'arrived', 'in_progress')
DROP POLICY IF EXISTS "locations_worker_insert" ON public.locations;
CREATE POLICY "locations_worker_insert"
    ON public.locations
    FOR INSERT
    TO authenticated
    WITH CHECK (
        worker_id = (SELECT auth.uid())
        AND app_auth.is_active_worker()
        AND (
            job_id IS NULL
            OR EXISTS (
                SELECT 1 FROM public.jobs j
                WHERE j.id = locations.job_id
                  AND j.worker_id = (SELECT auth.uid())
                  AND j.business_id = app_auth.current_business_id()
                  AND j.status IN ('on_the_way', 'arrived', 'in_progress')
            )
        )
    );

-- 2.2 Worker UPDATE:
-- Same permission check for updating existing location record
DROP POLICY IF EXISTS "locations_worker_update" ON public.locations;
CREATE POLICY "locations_worker_update"
    ON public.locations
    FOR UPDATE
    TO authenticated
    USING (
        worker_id = (SELECT auth.uid())
        AND app_auth.is_active_worker()
        AND (
            job_id IS NULL
            OR EXISTS (
                SELECT 1 FROM public.jobs j
                WHERE j.id = locations.job_id
                  AND j.worker_id = (SELECT auth.uid())
                  AND j.business_id = app_auth.current_business_id()
                  AND j.status IN ('on_the_way', 'arrived', 'in_progress')
            )
        )
    )
    WITH CHECK (
        worker_id = (SELECT auth.uid())
        AND app_auth.is_active_worker()
        AND (
            job_id IS NULL
            OR EXISTS (
                SELECT 1 FROM public.jobs j
                WHERE j.id = locations.job_id
                  AND j.worker_id = (SELECT auth.uid())
                  AND j.business_id = app_auth.current_business_id()
                  AND j.status IN ('on_the_way', 'arrived', 'in_progress')
            )
        )
    );

-- -----------------------------------------------------------------------------
-- 3. UPDATED TRANSACTIONAL RPC: record_worker_location
-- -----------------------------------------------------------------------------
-- Drop previous function overload to cleanly update signature with default parameter
DROP FUNCTION IF EXISTS public.record_worker_location(UUID, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION);

CREATE OR REPLACE FUNCTION public.record_worker_location(
    p_job_id UUID DEFAULT NULL,
    p_latitude DOUBLE PRECISION DEFAULT 0.0,
    p_longitude DOUBLE PRECISION DEFAULT 0.0,
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

    -- 4. Branch: Ambient Location (p_job_id IS NULL) vs Field Job Location
    IF p_job_id IS NULL THEN
        -- Atomic Upsert into ambient location record for this worker
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
            NULL,
            p_latitude,
            p_longitude,
            p_accuracy,
            now()
        )
        ON CONFLICT (worker_id) WHERE job_id IS NULL
        DO UPDATE SET
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            accuracy = EXCLUDED.accuracy,
            created_at = now()
        RETURNING * INTO v_record;

        RETURN v_record;
    ELSE
        -- Validate assigned job status in caller's business
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

        -- Atomic Upsert into active job location record
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
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_worker_location(UUID, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;

COMMIT;

