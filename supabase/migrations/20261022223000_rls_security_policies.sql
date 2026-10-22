-- Dispatcher MVP M4.3: RLS Security & Lifecycle Policies Migration
-- Authoritative Spec: docs/product-specification.md
-- Target Tables: businesses, profiles, jobs, job_events, locations, subscriptions
-- Private Schema: app_auth (Non-recursive identity & role resolution)

-- =============================================================================
-- 1. UTILITY FUNCTION HARDENING (search_path = '')
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = pg_catalog.now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_job_lifecycle_timestamps()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'assigned' AND NEW.assigned_at IS NULL THEN
            NEW.assigned_at := pg_catalog.now();
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            CASE NEW.status
                WHEN 'assigned' THEN
                    IF NEW.assigned_at IS NULL THEN NEW.assigned_at := pg_catalog.now(); END IF;
                WHEN 'accepted' THEN
                    IF NEW.accepted_at IS NULL THEN NEW.accepted_at := pg_catalog.now(); END IF;
                WHEN 'on_the_way' THEN
                    IF NEW.travelling_at IS NULL THEN NEW.travelling_at := pg_catalog.now(); END IF;
                WHEN 'arrived' THEN
                    IF NEW.arrived_at IS NULL THEN NEW.arrived_at := pg_catalog.now(); END IF;
                WHEN 'in_progress' THEN
                    IF NEW.started_at IS NULL THEN NEW.started_at := pg_catalog.now(); END IF;
                WHEN 'completed' THEN
                    IF NEW.completed_at IS NULL THEN NEW.completed_at := pg_catalog.now(); END IF;
                WHEN 'cancelled' THEN
                    IF NEW.cancelled_at IS NULL THEN NEW.cancelled_at := pg_catalog.now(); END IF;
                ELSE
                    NULL;
            END CASE;
        END IF;

        IF NEW.worker_id IS NOT NULL AND OLD.worker_id IS NULL AND NEW.assigned_at IS NULL THEN
            NEW.assigned_at := pg_catalog.now();
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_job_events_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'job_events is an immutable append-only ledger. Updates and deletions are forbidden.';
END;
$$;

-- =============================================================================
-- 2. INTERNAL SECURITY SCHEMA & NON-RECURSIVE RLS HELPERS (app_auth)
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS app_auth;

REVOKE ALL ON SCHEMA app_auth FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA app_auth TO authenticated;

-- Resolves the current user's profile row without triggering RLS recursion
CREATE OR REPLACE FUNCTION app_auth.current_user_profile()
RETURNS TABLE (
    id UUID,
    business_id UUID,
    role TEXT,
    is_active BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p.id, p.business_id, p.role, p.is_active
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid());
$$;

-- Helper: Current Business ID
CREATE OR REPLACE FUNCTION app_auth.current_business_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p.business_id
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid());
$$;

-- Helper: Current User Role ('owner' | 'worker')
CREATE OR REPLACE FUNCTION app_auth.current_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p.role
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid());
$$;

-- Helper: Is Active Business Owner
CREATE OR REPLACE FUNCTION app_auth.is_business_owner()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.role = 'owner'
          AND p.is_active = true
    );
$$;

-- Helper: Is Active Field Worker
CREATE OR REPLACE FUNCTION app_auth.is_active_worker()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.role = 'worker'
          AND p.is_active = true
    );
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app_auth FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_auth.current_user_profile() TO authenticated;
GRANT EXECUTE ON FUNCTION app_auth.current_business_id() TO authenticated;
GRANT EXECUTE ON FUNCTION app_auth.current_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION app_auth.is_business_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION app_auth.is_active_worker() TO authenticated;

-- =============================================================================
-- 3. STATE MACHINE VALIDATION TRIGGER (public.jobs)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.validate_job_lifecycle_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID;
    v_caller_role TEXT;
    v_caller_business_id UUID;
    v_worker_business_id UUID;
    v_worker_is_active BOOLEAN;
    v_worker_role TEXT;
BEGIN
    -- Prevent altering immutable primary key, tenancy, creation timestamp, or tracking token
    IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'Job ID cannot be altered';
    END IF;
    IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
        RAISE EXCEPTION 'Job business_id cannot be altered';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Job created_at cannot be altered';
    END IF;
    IF NEW.tracking_token IS DISTINCT FROM OLD.tracking_token THEN
        RAISE EXCEPTION 'Job tracking_token cannot be altered';
    END IF;

    -- Prevent modifying terminal jobs
    IF OLD.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Cannot modify job in terminal status: %', OLD.status;
    END IF;

    -- Resolve caller identity
    v_caller_id := auth.uid();

    -- If updated by an authenticated client, enforce strict role and state machine rules
    IF v_caller_id IS NOT NULL THEN
        SELECT p.role, p.business_id
        INTO v_caller_role, v_caller_business_id
        FROM public.profiles p
        WHERE p.id = v_caller_id;

        IF v_caller_business_id IS DISTINCT FROM OLD.business_id THEN
            RAISE EXCEPTION 'Cross-tenant job modification forbidden';
        END IF;

        IF v_caller_role = 'worker' THEN
            -- Workers cannot alter customer details, address, scope, notes, or schedule
            IF NEW.customer_name IS DISTINCT FROM OLD.customer_name
               OR NEW.customer_phone IS DISTINCT FROM OLD.customer_phone
               OR NEW.service IS DISTINCT FROM OLD.service
               OR NEW.address IS DISTINCT FROM OLD.address
               OR NEW.notes IS DISTINCT FROM OLD.notes
               OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
               OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason THEN
                RAISE EXCEPTION 'Field workers are not permitted to modify job customer or schedule details';
            END IF;

            -- Workers can only update jobs assigned to their own identity
            IF OLD.worker_id IS DISTINCT FROM v_caller_id THEN
                RAISE EXCEPTION 'Workers can only update jobs assigned to them';
            END IF;

            -- Enforce frozen 8-status sequential transitions for workers
            IF NEW.status IS DISTINCT FROM OLD.status THEN
                IF OLD.status = 'assigned' AND NEW.status = 'accepted' THEN
                    IF NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
                        RAISE EXCEPTION 'Cannot alter worker during assignment acceptance';
                    END IF;
                ELSIF OLD.status = 'assigned' AND NEW.status = 'unassigned' THEN
                    -- Worker declined assignment: clear worker_id
                    NEW.worker_id := NULL;
                ELSIF OLD.status = 'accepted' AND NEW.status = 'on_the_way' THEN
                    IF NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
                        RAISE EXCEPTION 'Cannot alter worker during status transition';
                    END IF;
                ELSIF OLD.status = 'on_the_way' AND NEW.status = 'arrived' THEN
                    IF NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
                        RAISE EXCEPTION 'Cannot alter worker during status transition';
                    END IF;
                ELSIF OLD.status = 'arrived' AND NEW.status = 'in_progress' THEN
                    IF NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
                        RAISE EXCEPTION 'Cannot alter worker during status transition';
                    END IF;
                ELSIF OLD.status = 'in_progress' AND NEW.status = 'completed' THEN
                    IF NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
                        RAISE EXCEPTION 'Cannot alter worker during status transition';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'Illegal worker status transition from % to %', OLD.status, NEW.status;
                END IF;
            ELSE
                -- Status unchanged: worker cannot alter assignment
                IF NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
                    RAISE EXCEPTION 'Workers cannot alter worker_id';
                END IF;
            END IF;

        ELSIF v_caller_role = 'owner' THEN
            -- Enforce owner transition constraints
            IF NEW.status IS DISTINCT FROM OLD.status THEN
                IF NEW.status = 'cancelled' THEN
                    IF NEW.cancellation_reason IS NULL OR length(pg_catalog.trim(NEW.cancellation_reason)) = 0 THEN
                        RAISE EXCEPTION 'Mandatory cancellation reason required to cancel a job';
                    END IF;
                ELSIF OLD.status = 'unassigned' AND NEW.status = 'assigned' THEN
                    IF NEW.worker_id IS NULL THEN
                        RAISE EXCEPTION 'Cannot transition to assigned without assigning a worker';
                    END IF;
                ELSIF OLD.status = 'assigned' AND NEW.status = 'unassigned' THEN
                    NEW.worker_id := NULL;
                ELSIF OLD.status = 'assigned' AND NEW.status = 'assigned' THEN
                    -- Reassignment
                    IF NEW.worker_id IS NULL THEN
                        RAISE EXCEPTION 'Reassignment requires a valid worker_id';
                    END IF;
                ELSE
                    -- Owner cannot execute field execution transitions
                    IF NEW.status IN ('accepted', 'on_the_way', 'arrived', 'in_progress', 'completed') THEN
                        RAISE EXCEPTION 'Field execution transitions (% -> %) must be performed by the assigned worker', OLD.status, NEW.status;
                    ELSE
                        RAISE EXCEPTION 'Invalid owner status transition from % to %', OLD.status, NEW.status;
                    END IF;
                END IF;
            END IF;

            -- Validate worker assignment validity if worker changed
            IF NEW.worker_id IS DISTINCT FROM OLD.worker_id AND NEW.worker_id IS NOT NULL THEN
                SELECT p.business_id, p.is_active, p.role
                INTO v_worker_business_id, v_worker_is_active, v_worker_role
                FROM public.profiles p
                WHERE p.id = NEW.worker_id;

                IF v_worker_business_id IS DISTINCT FROM NEW.business_id THEN
                    RAISE EXCEPTION 'Assigned worker must belong to the same business';
                END IF;
                IF NOT v_worker_is_active THEN
                    RAISE EXCEPTION 'Cannot assign an inactive worker';
                END IF;
                IF v_worker_role != 'worker' THEN
                    RAISE EXCEPTION 'Assigned profile must have worker role';
                END IF;
            END IF;
        ELSE
            RAISE EXCEPTION 'Unauthorized profile role: %', v_caller_role;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_validate_lifecycle_transition ON public.jobs;
CREATE TRIGGER trg_jobs_validate_lifecycle_transition
    BEFORE UPDATE ON public.jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_job_lifecycle_transition();

-- =============================================================================
-- 4. TELEMETRY IMMUTABILITY TRIGGER (public.locations)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.prevent_locations_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'locations table is an immutable audit log. Updates and deletions are forbidden.';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_locations_mutation ON public.locations;
CREATE TRIGGER trg_prevent_locations_mutation
    BEFORE UPDATE OR DELETE ON public.locations
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_locations_mutation();

-- =============================================================================
-- 5. ROW LEVEL SECURITY (RLS) POLICIES
-- =============================================================================

-- Ensure RLS is active on all 6 tables
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 5.1 TABLE: businesses
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "businesses_member_select" ON public.businesses;
CREATE POLICY "businesses_member_select"
    ON public.businesses
    FOR SELECT
    TO authenticated
    USING (id = app_auth.current_business_id());

DROP POLICY IF EXISTS "businesses_owner_update" ON public.businesses;
CREATE POLICY "businesses_owner_update"
    ON public.businesses
    FOR UPDATE
    TO authenticated
    USING (id = app_auth.current_business_id() AND app_auth.is_business_owner())
    WITH CHECK (id = app_auth.current_business_id() AND app_auth.is_business_owner());

-- -----------------------------------------------------------------------------
-- 5.2 TABLE: profiles
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select"
    ON public.profiles
    FOR SELECT
    TO authenticated
    USING (
        id = (SELECT auth.uid())
        OR (
            business_id = app_auth.current_business_id()
            AND (app_auth.is_business_owner() OR role = 'owner')
        )
    );

DROP POLICY IF EXISTS "profiles_self_update" ON public.profiles;
CREATE POLICY "profiles_self_update"
    ON public.profiles
    FOR UPDATE
    TO authenticated
    USING (id = (SELECT auth.uid()))
    WITH CHECK (
        id = (SELECT auth.uid())
        AND role = app_auth.current_user_role()
        AND business_id = app_auth.current_business_id()
    );

DROP POLICY IF EXISTS "profiles_owner_worker_update" ON public.profiles;
CREATE POLICY "profiles_owner_worker_update"
    ON public.profiles
    FOR UPDATE
    TO authenticated
    USING (
        business_id = app_auth.current_business_id()
        AND app_auth.is_business_owner()
        AND role = 'worker'
    )
    WITH CHECK (
        business_id = app_auth.current_business_id()
        AND app_auth.is_business_owner()
        AND role = 'worker'
        AND business_id = (SELECT p.business_id FROM public.profiles p WHERE p.id = profiles.id)
    );

-- -----------------------------------------------------------------------------
-- 5.3 TABLE: jobs
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "jobs_select" ON public.jobs;
CREATE POLICY "jobs_select"
    ON public.jobs
    FOR SELECT
    TO authenticated
    USING (
        business_id = app_auth.current_business_id()
        AND (
            app_auth.is_business_owner()
            OR (worker_id = (SELECT auth.uid()) AND app_auth.is_active_worker())
        )
    );

DROP POLICY IF EXISTS "jobs_owner_insert" ON public.jobs;
CREATE POLICY "jobs_owner_insert"
    ON public.jobs
    FOR INSERT
    TO authenticated
    WITH CHECK (
        business_id = app_auth.current_business_id()
        AND app_auth.is_business_owner()
        AND status = 'unassigned'
        AND worker_id IS NULL
    );

DROP POLICY IF EXISTS "jobs_owner_update" ON public.jobs;
CREATE POLICY "jobs_owner_update"
    ON public.jobs
    FOR UPDATE
    TO authenticated
    USING (
        business_id = app_auth.current_business_id()
        AND app_auth.is_business_owner()
        AND status NOT IN ('completed', 'cancelled')
    )
    WITH CHECK (
        business_id = app_auth.current_business_id()
        AND app_auth.is_business_owner()
    );

DROP POLICY IF EXISTS "jobs_worker_update" ON public.jobs;
CREATE POLICY "jobs_worker_update"
    ON public.jobs
    FOR UPDATE
    TO authenticated
    USING (
        business_id = app_auth.current_business_id()
        AND worker_id = (SELECT auth.uid())
        AND app_auth.is_active_worker()
        AND status NOT IN ('completed', 'cancelled')
    )
    WITH CHECK (
        business_id = app_auth.current_business_id()
    );

-- -----------------------------------------------------------------------------
-- 5.4 TABLE: job_events
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "job_events_select" ON public.job_events;
CREATE POLICY "job_events_select"
    ON public.job_events
    FOR SELECT
    TO authenticated
    USING (
        business_id = app_auth.current_business_id()
        AND (
            app_auth.is_business_owner()
            OR (
                app_auth.is_active_worker()
                AND EXISTS (
                    SELECT 1 FROM public.jobs j
                    WHERE j.id = job_events.job_id
                      AND j.worker_id = (SELECT auth.uid())
                )
            )
        )
    );

-- -----------------------------------------------------------------------------
-- 5.5 TABLE: locations
-- -----------------------------------------------------------------------------
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

DROP POLICY IF EXISTS "locations_worker_select" ON public.locations;
CREATE POLICY "locations_worker_select"
    ON public.locations
    FOR SELECT
    TO authenticated
    USING (
        worker_id = (SELECT auth.uid())
    );

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
            )
        )
    );

-- -----------------------------------------------------------------------------
-- 5.6 TABLE: subscriptions
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "subscriptions_owner_select" ON public.subscriptions;
CREATE POLICY "subscriptions_owner_select"
    ON public.subscriptions
    FOR SELECT
    TO authenticated
    USING (
        business_id = app_auth.current_business_id()
        AND app_auth.is_business_owner()
    );

-- =============================================================================
-- 6. SQL PRIVILEGE GRANTS & REVOCATIONS
-- =============================================================================

-- Deny all direct table operations to unauthenticated anonymous role
REVOKE ALL ON public.businesses FROM anon;
REVOKE ALL ON public.profiles FROM anon;
REVOKE ALL ON public.jobs FROM anon;
REVOKE ALL ON public.job_events FROM anon;
REVOKE ALL ON public.locations FROM anon;
REVOKE ALL ON public.subscriptions FROM anon;

-- Explicit table grants for authenticated client role
GRANT SELECT, UPDATE ON public.businesses TO authenticated;
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.jobs TO authenticated;
GRANT SELECT ON public.job_events TO authenticated;
GRANT SELECT, INSERT ON public.locations TO authenticated;
GRANT SELECT ON public.subscriptions TO authenticated;

-- Explicitly revoke forbidden mutations from authenticated client role
REVOKE INSERT, DELETE ON public.businesses FROM authenticated;
REVOKE INSERT, DELETE ON public.profiles FROM authenticated;
REVOKE DELETE ON public.jobs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.job_events FROM authenticated;
REVOKE UPDATE, DELETE ON public.locations FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.subscriptions FROM authenticated;

-- Revoke default public execute on all functions in public schema
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- Re-grant execute on specific triggers and public RPCs
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_job_lifecycle_timestamps() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_job_events_mutation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.handle_job_event_logging() TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_job_lifecycle_transition() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_locations_mutation() TO authenticated;

-- =============================================================================
-- 7. PROTECTED SERVER-SIDE OPERATIONS (RPCs)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 7.1 Business Onboarding & Provisioning
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
BEGIN
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- Verify that the caller does not already belong to any business
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_caller_id) THEN
        RAISE EXCEPTION 'User profile already exists and cannot provision a new business';
    END IF;

    IF p_name IS NULL OR length(pg_catalog.trim(p_name)) = 0 THEN
        RAISE EXCEPTION 'Business name is required';
    END IF;
    IF p_phone IS NULL OR length(pg_catalog.trim(p_phone)) = 0 THEN
        RAISE EXCEPTION 'Business phone is required';
    END IF;

    -- Resolve email from auth.users store
    SELECT email INTO v_caller_email
    FROM auth.users
    WHERE id = v_caller_id;

    IF v_caller_email IS NULL THEN
        RAISE EXCEPTION 'User email not found in authentication store';
    END IF;

    v_full_name := COALESCE(pg_catalog.nullif(pg_catalog.trim(p_owner_full_name), ''), 'Business Owner');

    -- 1. Create Business
    INSERT INTO public.businesses (name, phone, address)
    VALUES (pg_catalog.trim(p_name), pg_catalog.trim(p_phone), pg_catalog.nullif(pg_catalog.trim(p_address), ''))
    RETURNING id INTO v_business_id;

    -- 2. Create Owner Profile
    INSERT INTO public.profiles (id, business_id, full_name, email, phone, role, is_active)
    VALUES (v_caller_id, v_business_id, v_full_name, v_caller_email, pg_catalog.trim(p_phone), 'owner', true);

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
-- 7.2 Job Assignment & Reassignment (Owner Dispatch)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_job_worker(
    p_job_id UUID,
    p_worker_id UUID DEFAULT NULL
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
        RAISE EXCEPTION 'Only business owners can assign or unassign jobs';
    END IF;

    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id AND business_id = app_auth.current_business_id();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found in your business';
    END IF;

    IF v_job.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Cannot assign or modify terminal job';
    END IF;

    IF p_worker_id IS NULL THEN
        -- Unassign worker
        IF v_job.status != 'assigned' THEN
            RAISE EXCEPTION 'Can only unassign a job currently in assigned status';
        END IF;
        UPDATE public.jobs
        SET worker_id = NULL, status = 'unassigned'
        WHERE id = p_job_id
        RETURNING * INTO v_job;
    ELSE
        -- Assign or Reassign worker
        IF v_job.status NOT IN ('unassigned', 'assigned') THEN
            RAISE EXCEPTION 'Jobs can only be assigned or reassigned while in unassigned or assigned status';
        END IF;
        UPDATE public.jobs
        SET worker_id = p_worker_id, status = 'assigned'
        WHERE id = p_job_id
        RETURNING * INTO v_job;
    END IF;

    RETURN v_job;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_job_worker(UUID, UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- 7.3 Job Cancellation (Owner)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_job(
    p_job_id UUID,
    p_cancellation_reason TEXT
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

    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id AND business_id = app_auth.current_business_id();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found in your business';
    END IF;

    IF v_job.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Job is already in a terminal status (%)', v_job.status;
    END IF;

    UPDATE public.jobs
    SET status = 'cancelled', cancellation_reason = pg_catalog.trim(p_cancellation_reason)
    WHERE id = p_job_id
    RETURNING * INTO v_job;

    RETURN v_job;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_job(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 7.4 Sequential Status Advancement (Field Worker)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.advance_job_status(
    p_job_id UUID,
    p_target_status TEXT
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

    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
      AND business_id = app_auth.current_business_id()
      AND worker_id = v_caller_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found or not assigned to you';
    END IF;

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

GRANT EXECUTE ON FUNCTION public.advance_job_status(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 7.5 Decline Assignment (Field Worker)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decline_job_assignment(
    p_job_id UUID,
    p_decline_reason TEXT DEFAULT NULL
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

    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
      AND business_id = app_auth.current_business_id()
      AND worker_id = v_caller_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found or not assigned to you';
    END IF;

    IF v_job.status != 'assigned' THEN
        RAISE EXCEPTION 'Can only decline jobs in assigned status';
    END IF;

    UPDATE public.jobs
    SET worker_id = NULL, status = 'unassigned'
    WHERE id = p_job_id
    RETURNING * INTO v_job;

    RETURN v_job;
END;
$$;

GRANT EXECUTE ON FUNCTION public.decline_job_assignment(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 7.6 Customer Web Tracking Endpoint (Public / Sanitized)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_customer_tracking_job(
    p_tracking_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_result JSONB;
BEGIN
    IF p_tracking_token IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT pg_catalog.jsonb_build_object(
        'service', j.service,
        'status', j.status,
        'status_label', CASE j.status
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
        'scheduled_at', j.scheduled_at,
        'business_name', b.name,
        'business_phone', b.phone,
        'worker_first_name', CASE 
            WHEN w.full_name IS NOT NULL THEN split_part(pg_catalog.trim(w.full_name), ' ', 1)
            ELSE NULL
        END,
        'worker_avatar_url', w.avatar_url,
        'updated_at', j.updated_at
    ) INTO v_result
    FROM public.jobs j
    JOIN public.businesses b ON b.id = j.business_id
    LEFT JOIN public.profiles w ON w.id = j.worker_id
    WHERE j.tracking_token = p_tracking_token;

    RETURN v_result;
END;
$$;

-- Allow anonymous and authenticated access strictly to customer tracking function
GRANT EXECUTE ON FUNCTION public.get_customer_tracking_job(UUID) TO anon, authenticated;
