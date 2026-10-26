-- =============================================================================
-- Migration: 20261026020000_idempotency_race_condition_protection.sql
-- Description: Idempotency, Race-Condition Protection, and Conditional Transitions.
--
-- Guarantees:
-- 1. Row-Level Locking (SELECT ... FOR UPDATE): Prevents concurrent race conditions
--    and invalid state jumps across all four lifecycle RPCs.
-- 2. Conditional Transitions (p_expected_current_status): Ensures transitions only
--    succeed if the job is in the expected status, preventing old screens from
--    overwriting newer states.
-- 3. Idempotent Execution: If a retry arrives for a transition that has already
--    succeeded (v_job.status = p_target_status), returns the existing job
--    without executing an UPDATE, preventing duplicate job_events or timestamp shifts.
-- 4. Terminal State Immutability: Terminal statuses ('completed', 'cancelled')
--    cannot be transitioned, reassigned, or cancelled.
-- 5. Preserves decline (assigned -> unassigned), unassign, and cancellation semantics.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Sequential Status Advancement (Field Worker)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.advance_job_status(
    p_job_id UUID,
    p_target_status TEXT,
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
BEGIN
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF NOT app_auth.is_active_worker() THEN
        RAISE EXCEPTION 'Only active field workers can advance job execution status';
    END IF;

    -- Row-level exclusive lock serializes concurrent transactions on this job
    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
      AND business_id = app_auth.current_business_id()
      AND worker_id = v_caller_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found or not assigned to you';
    END IF;

    -- Idempotency Check: If already at target status, return existing record
    -- without executing UPDATE, preventing duplicate job_events or timestamp shifts.
    IF v_job.status = p_target_status THEN
        RETURN v_job;
    END IF;

    -- Terminal check: Completed jobs cannot be moved to any other status
    IF v_job.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Job is in terminal status (%) and cannot be modified', v_job.status;
    END IF;

    -- Stale screen protection: conditional on expected current status
    IF p_expected_current_status IS NOT NULL AND v_job.status != p_expected_current_status THEN
        RAISE EXCEPTION 'Job status has changed (expected %, currently %). Please refresh to view the latest status', p_expected_current_status, v_job.status;
    END IF;

    -- Validate sequential field progression
    IF (v_job.status = 'assigned' AND p_target_status = 'accepted')
       OR (v_job.status = 'accepted' AND p_target_status = 'on_the_way')
       OR (v_job.status = 'on_the_way' AND p_target_status = 'arrived')
       OR (v_job.status = 'arrived' AND p_target_status = 'in_progress')
       OR (v_job.status = 'in_progress' AND p_target_status = 'completed') THEN

        UPDATE public.jobs
        SET status = p_target_status
        WHERE id = p_job_id
        RETURNING * INTO v_job;

        RETURN v_job;
    ELSE
        RAISE EXCEPTION 'Invalid sequential status transition from % to %', v_job.status, p_target_status;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.advance_job_status(UUID, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Worker Assignment / Reassignment / Unassignment (Business Owner)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_job_worker(
    p_job_id UUID,
    p_worker_id UUID DEFAULT NULL,
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
    v_worker_business_id UUID;
    v_worker_is_active BOOLEAN;
BEGIN
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF NOT app_auth.is_business_owner() THEN
        RAISE EXCEPTION 'Only business owners can assign or reassign workers';
    END IF;

    -- Row-level exclusive lock serializes concurrent transactions on this job
    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
      AND business_id = app_auth.current_business_id()
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found in your business';
    END IF;

    -- Terminal check: Completed or cancelled jobs cannot be assigned or unassigned
    IF v_job.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Cannot modify worker assignment for job in terminal status (%)', v_job.status;
    END IF;

    -- Field execution lock: Cannot assign, reassign, or unassign during active field work
    IF v_job.status IN ('accepted', 'on_the_way', 'arrived', 'in_progress') THEN
        RAISE EXCEPTION 'Worker assignment is locked while job is in active field execution (%)', v_job.status;
    END IF;

    -- Idempotency Checks:
    IF p_worker_id IS NULL THEN
        -- Unassign idempotency: already unassigned with no worker
        IF v_job.status = 'unassigned' AND v_job.worker_id IS NULL THEN
            RETURN v_job;
        END IF;
    ELSE
        -- Assign/reassign idempotency: already assigned to this worker
        IF v_job.status = 'assigned' AND v_job.worker_id = p_worker_id THEN
            RETURN v_job;
        END IF;
    END IF;

    -- Stale screen protection: conditional on expected current status
    IF p_expected_current_status IS NOT NULL AND v_job.status != p_expected_current_status THEN
        RAISE EXCEPTION 'Job status has changed (expected %, currently %). Please refresh to view the latest status', p_expected_current_status, v_job.status;
    END IF;

    IF p_worker_id IS NULL THEN
        -- Unassign technician
        IF v_job.status != 'assigned' THEN
            RAISE EXCEPTION 'Can only unassign a job currently in assigned status';
        END IF;

        UPDATE public.jobs
        SET worker_id = NULL, status = 'unassigned'
        WHERE id = p_job_id
        RETURNING * INTO v_job;
    ELSE
        -- Assign or Reassign technician
        IF v_job.status NOT IN ('unassigned', 'assigned') THEN
            RAISE EXCEPTION 'Jobs can only be assigned or reassigned while in unassigned or assigned status';
        END IF;

        -- Validate worker belongs to same business and is active
        SELECT business_id, is_active
        INTO v_worker_business_id, v_worker_is_active
        FROM public.profiles
        WHERE id = p_worker_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Worker profile not found';
        END IF;

        IF v_worker_business_id != app_auth.current_business_id() THEN
            RAISE EXCEPTION 'Worker does not belong to your business';
        END IF;

        IF NOT v_worker_is_active THEN
            RAISE EXCEPTION 'Cannot assign an inactive worker';
        END IF;

        UPDATE public.jobs
        SET worker_id = p_worker_id, status = 'assigned'
        WHERE id = p_job_id
        RETURNING * INTO v_job;
    END IF;

    RETURN v_job;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_job_worker(UUID, UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Decline Assignment (Field Worker)
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
BEGIN
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF NOT app_auth.is_active_worker() THEN
        RAISE EXCEPTION 'Only active field workers can decline assignments';
    END IF;

    -- Row-level exclusive lock serializes concurrent transactions on this job
    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
      AND business_id = app_auth.current_business_id()
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found in your business';
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
        RAISE EXCEPTION 'Job is not assigned to you';
    END IF;

    -- Terminal check
    IF v_job.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Job is in terminal status (%) and cannot be declined', v_job.status;
    END IF;

    -- Stale screen protection: conditional on expected current status
    IF p_expected_current_status IS NOT NULL AND v_job.status != p_expected_current_status THEN
        RAISE EXCEPTION 'Job status has changed (expected %, currently %). Please refresh to view the latest status', p_expected_current_status, v_job.status;
    END IF;

    IF v_job.status != 'assigned' THEN
        RAISE EXCEPTION 'Can only decline jobs in assigned status (currently %)', v_job.status;
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
-- 4. Job Cancellation (Business Owner)
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
BEGIN
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF NOT app_auth.is_business_owner() THEN
        RAISE EXCEPTION 'Only business owners can cancel jobs';
    END IF;

    IF p_cancellation_reason IS NULL OR length(pg_catalog.trim(p_cancellation_reason)) = 0 THEN
        RAISE EXCEPTION 'Mandatory cancellation reason required';
    END IF;

    -- Row-level exclusive lock serializes concurrent transactions on this job
    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
      AND business_id = app_auth.current_business_id()
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found in your business';
    END IF;

    -- Idempotency check: If already cancelled, return existing job cleanly
    IF v_job.status = 'cancelled' THEN
        RETURN v_job;
    END IF;

    -- Completed jobs cannot be cancelled
    IF v_job.status = 'completed' THEN
        RAISE EXCEPTION 'Cannot cancel a completed job';
    END IF;

    -- Stale screen protection: conditional on expected current status
    IF p_expected_current_status IS NOT NULL AND v_job.status != p_expected_current_status THEN
        RAISE EXCEPTION 'Job status has changed (expected %, currently %). Please refresh to view the latest status', p_expected_current_status, v_job.status;
    END IF;

    UPDATE public.jobs
    SET status = 'cancelled',
        cancellation_reason = pg_catalog.trim(p_cancellation_reason)
    WHERE id = p_job_id
    RETURNING * INTO v_job;

    RETURN v_job;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_job(UUID, TEXT, TEXT) TO authenticated;
