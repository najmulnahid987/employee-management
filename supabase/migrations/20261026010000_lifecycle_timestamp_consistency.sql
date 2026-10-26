-- =============================================================================
-- Migration: 20261026010000_lifecycle_timestamp_consistency.sql
-- Description: Standardize database lifecycle transition timestamp consistency.
--
-- Guarantees:
-- 1. Database server clock (pg_catalog.now()) is the single trusted source of timestamps.
-- 2. Sets the transition timestamp only when its corresponding transition succeeds.
-- 3. Preserves earlier lifecycle timestamps as immutable historical facts.
-- 4. Rejects / discards any arbitrary client-supplied transition timestamps.
-- 5. Atomic: Executes in the same BEFORE INSERT/UPDATE transaction as the status
--    transition, immediately before AFTER trigger logs to public.job_events.
-- 6. Unassignment & Decline: Clears assigned_at to NULL so future re-assignment
--    gets a fresh, accurate timestamp (prior history preserved in job_events).
-- 7. Reassignment: Refreshes assigned_at to pg_catalog.now() on worker reassignment.
-- 8. Cancellation: Sets cancelled_at and preserves all earlier reached stage timestamps.
-- 9. Does NOT modify unrelated created_at, updated_at, or scheduled_at columns.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_job_lifecycle_timestamps()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Discard / neutralize any client-supplied transition timestamps on creation
        NEW.accepted_at   := NULL;
        NEW.travelling_at := NULL;
        NEW.arrived_at    := NULL;
        NEW.started_at    := NULL;
        NEW.completed_at  := NULL;
        NEW.cancelled_at  := NULL;

        -- Authoritatively stamp assigned_at only if created in 'assigned' status
        IF NEW.status = 'assigned' THEN
            NEW.assigned_at := pg_catalog.now();
        ELSE
            NEW.assigned_at := NULL;
        END IF;

    ELSIF TG_OP = 'UPDATE' THEN
        -- 1. Anti-tampering & History Preservation:
        -- By default, pin all transition timestamps to their previous values.
        -- This discards any arbitrary client-supplied timestamps and preserves history.
        NEW.assigned_at   := OLD.assigned_at;
        NEW.accepted_at   := OLD.accepted_at;
        NEW.travelling_at := OLD.travelling_at;
        NEW.arrived_at    := OLD.arrived_at;
        NEW.started_at    := OLD.started_at;
        NEW.completed_at  := OLD.completed_at;
        NEW.cancelled_at  := OLD.cancelled_at;

        -- 2. Status Transition Handling:
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            CASE NEW.status
                WHEN 'unassigned' THEN
                    -- Worker decline or Owner unassign:
                    -- Reset assigned_at so subsequent assignment receives a fresh timestamp.
                    -- Full assignment and decline history remain preserved in public.job_events.
                    NEW.assigned_at := NULL;
                WHEN 'assigned' THEN
                    NEW.assigned_at := pg_catalog.now();
                WHEN 'accepted' THEN
                    NEW.accepted_at := pg_catalog.now();
                WHEN 'on_the_way' THEN
                    NEW.travelling_at := pg_catalog.now();
                WHEN 'arrived' THEN
                    NEW.arrived_at := pg_catalog.now();
                WHEN 'in_progress' THEN
                    NEW.started_at := pg_catalog.now();
                WHEN 'completed' THEN
                    NEW.completed_at := pg_catalog.now();
                WHEN 'cancelled' THEN
                    NEW.cancelled_at := pg_catalog.now();
                ELSE
                    NULL;
            END CASE;
        ELSIF NEW.status = 'assigned' 
          AND NEW.worker_id IS DISTINCT FROM OLD.worker_id 
          AND NEW.worker_id IS NOT NULL THEN
            -- Reassignment to a different worker within 'assigned' status refreshes assigned_at
            NEW.assigned_at := pg_catalog.now();
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_job_lifecycle_timestamps() TO authenticated;

-- Ensure trigger is registered BEFORE INSERT OR UPDATE
DROP TRIGGER IF EXISTS trg_jobs_sync_lifecycle_timestamps ON public.jobs;
CREATE TRIGGER trg_jobs_sync_lifecycle_timestamps
    BEFORE INSERT OR UPDATE ON public.jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_job_lifecycle_timestamps();
