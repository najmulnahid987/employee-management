-- Dispatcher MVP Initial Schema Migration
-- Authoritative Spec: docs/product-specification.md
-- Target Tables: businesses, profiles, jobs, job_events, locations, subscriptions

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- 1. UTILITY FUNCTIONS & TIMESTAMP TRIGGERS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- =============================================================================
-- 2. TABLE: businesses
-- =============================================================================

CREATE TABLE public.businesses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    phone TEXT NOT NULL CHECK (length(trim(phone)) > 0),
    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_businesses_created_at ON public.businesses (created_at DESC);

CREATE TRIGGER trg_businesses_updated_at
    BEFORE UPDATE ON public.businesses
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 3. TABLE: profiles
-- =============================================================================

CREATE TABLE public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
    full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
    email TEXT NOT NULL CHECK (length(trim(email)) > 0),
    phone TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'worker')),
    avatar_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- Composite unique constraint required for cross-table same-business foreign key
    CONSTRAINT uq_profiles_id_business UNIQUE (id, business_id)
);

CREATE INDEX idx_profiles_business_id ON public.profiles (business_id);
CREATE INDEX idx_profiles_business_role ON public.profiles (business_id, role);

CREATE TRIGGER trg_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 4. TABLE: jobs
-- =============================================================================

CREATE TABLE public.jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
    worker_id UUID,
    customer_name TEXT NOT NULL CHECK (length(trim(customer_name)) > 0),
    customer_phone TEXT NOT NULL CHECK (length(trim(customer_phone)) > 0),
    service TEXT NOT NULL CHECK (length(trim(service)) > 0),
    address TEXT NOT NULL CHECK (length(trim(address)) > 0),
    latitude DOUBLE PRECISION CHECK (latitude IS NULL OR (latitude >= -90.0 AND latitude <= 90.0)),
    longitude DOUBLE PRECISION CHECK (longitude IS NULL OR (longitude >= -180.0 AND longitude <= 180.0)),
    notes TEXT,
    scheduled_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'unassigned' CHECK (
        status IN (
            'unassigned',
            'assigned',
            'accepted',
            'on_the_way',
            'arrived',
            'in_progress',
            'completed',
            'cancelled'
        )
    ),
    tracking_token UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    cancellation_reason TEXT,
    assigned_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    travelling_at TIMESTAMPTZ,
    arrived_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Composite foreign key enforcing same-business worker assignment
    CONSTRAINT fk_jobs_worker_business FOREIGN KEY (worker_id, business_id)
        REFERENCES public.profiles(id, business_id)
        ON DELETE RESTRICT,

    -- Unassigned jobs cannot have an assigned worker
    CONSTRAINT chk_jobs_unassigned_worker CHECK (
        status != 'unassigned' OR worker_id IS NULL
    ),

    -- Mandatory cancellation reason when cancelled
    CONSTRAINT chk_jobs_cancellation_reason CHECK (
        status != 'cancelled' OR (cancellation_reason IS NOT NULL AND length(trim(cancellation_reason)) > 0)
    )
);

CREATE INDEX idx_jobs_business_status ON public.jobs (business_id, status);
CREATE INDEX idx_jobs_worker_status ON public.jobs (worker_id, status) WHERE worker_id IS NOT NULL;
CREATE INDEX idx_jobs_business_scheduled ON public.jobs (business_id, scheduled_at DESC);
CREATE INDEX idx_jobs_business_created ON public.jobs (business_id, created_at DESC);

CREATE TRIGGER trg_jobs_updated_at
    BEFORE UPDATE ON public.jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- Lifecycle timestamp synchronizer
CREATE OR REPLACE FUNCTION public.sync_job_lifecycle_timestamps()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'assigned' AND NEW.assigned_at IS NULL THEN
            NEW.assigned_at := now();
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            CASE NEW.status
                WHEN 'assigned' THEN
                    IF NEW.assigned_at IS NULL THEN NEW.assigned_at := now(); END IF;
                WHEN 'accepted' THEN
                    IF NEW.accepted_at IS NULL THEN NEW.accepted_at := now(); END IF;
                WHEN 'on_the_way' THEN
                    IF NEW.travelling_at IS NULL THEN NEW.travelling_at := now(); END IF;
                WHEN 'arrived' THEN
                    IF NEW.arrived_at IS NULL THEN NEW.arrived_at := now(); END IF;
                WHEN 'in_progress' THEN
                    IF NEW.started_at IS NULL THEN NEW.started_at := now(); END IF;
                WHEN 'completed' THEN
                    IF NEW.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
                WHEN 'cancelled' THEN
                    IF NEW.cancelled_at IS NULL THEN NEW.cancelled_at := now(); END IF;
                ELSE
                    NULL;
            END CASE;
        END IF;

        IF NEW.worker_id IS NOT NULL AND OLD.worker_id IS NULL AND NEW.assigned_at IS NULL THEN
            NEW.assigned_at := now();
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_jobs_sync_lifecycle_timestamps
    BEFORE INSERT OR UPDATE ON public.jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_job_lifecycle_timestamps();

-- =============================================================================
-- 5. TABLE: job_events (Append-Only Ledger)
-- =============================================================================

CREATE TABLE public.job_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
    business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'worker', 'system')),
    event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
    previous_status TEXT CHECK (
        previous_status IS NULL OR previous_status IN (
            'unassigned',
            'assigned',
            'accepted',
            'on_the_way',
            'arrived',
            'in_progress',
            'completed',
            'cancelled'
        )
    ),
    new_status TEXT CHECK (
        new_status IS NULL OR new_status IN (
            'unassigned',
            'assigned',
            'accepted',
            'on_the_way',
            'arrived',
            'in_progress',
            'completed',
            'cancelled'
        )
    ),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_events_job_created ON public.job_events (job_id, created_at ASC);
CREATE INDEX idx_job_events_business_created ON public.job_events (business_id, created_at DESC);

-- Immutable Append-Only Ledger Enforcement
CREATE OR REPLACE FUNCTION public.prevent_job_events_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'job_events is an immutable append-only ledger. Updates and deletions are forbidden.';
END;
$$;

CREATE TRIGGER trg_prevent_job_events_mutation
    BEFORE UPDATE OR DELETE ON public.job_events
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_job_events_mutation();

-- Database-Side Job Event Logging Function
-- SECURITY DEFINER with fixed empty search_path to prevent untrusted schema resolution
CREATE OR REPLACE FUNCTION public.handle_job_event_logging()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor_id UUID;
    v_actor_role TEXT := 'system';
BEGIN
    v_actor_id := auth.uid();

    IF v_actor_id IS NOT NULL THEN
        SELECT p.role INTO v_actor_role
        FROM public.profiles p
        WHERE p.id = v_actor_id;

        IF v_actor_role IS NULL THEN
            v_actor_role := 'system';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.job_events (
            job_id,
            business_id,
            actor_id,
            actor_role,
            event_type,
            previous_status,
            new_status,
            metadata,
            created_at
        ) VALUES (
            NEW.id,
            NEW.business_id,
            v_actor_id,
            v_actor_role,
            'job_created',
            NULL,
            NEW.status,
            pg_catalog.jsonb_build_object(
                'service', NEW.service,
                'customer_name', NEW.customer_name,
                'initial_worker_id', NEW.worker_id
            ),
            pg_catalog.now()
        );

        IF NEW.worker_id IS NOT NULL THEN
            INSERT INTO public.job_events (
                job_id,
                business_id,
                actor_id,
                actor_role,
                event_type,
                previous_status,
                new_status,
                metadata,
                created_at
            ) VALUES (
                NEW.id,
                NEW.business_id,
                v_actor_id,
                v_actor_role,
                'worker_assigned',
                NEW.status,
                NEW.status,
                pg_catalog.jsonb_build_object('worker_id', NEW.worker_id),
                pg_catalog.now()
            );
        END IF;

    ELSIF TG_OP = 'UPDATE' THEN
        -- Worker assignment changes
        IF NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
            IF OLD.worker_id IS NULL AND NEW.worker_id IS NOT NULL THEN
                INSERT INTO public.job_events (
                    job_id,
                    business_id,
                    actor_id,
                    actor_role,
                    event_type,
                    previous_status,
                    new_status,
                    metadata,
                    created_at
                ) VALUES (
                    NEW.id,
                    NEW.business_id,
                    v_actor_id,
                    v_actor_role,
                    'worker_assigned',
                    OLD.status,
                    NEW.status,
                    pg_catalog.jsonb_build_object('worker_id', NEW.worker_id),
                    pg_catalog.now()
                );
            ELSIF OLD.worker_id IS NOT NULL AND NEW.worker_id IS NULL THEN
                INSERT INTO public.job_events (
                    job_id,
                    business_id,
                    actor_id,
                    actor_role,
                    event_type,
                    previous_status,
                    new_status,
                    metadata,
                    created_at
                ) VALUES (
                    NEW.id,
                    NEW.business_id,
                    v_actor_id,
                    v_actor_role,
                    'worker_unassigned',
                    OLD.status,
                    NEW.status,
                    pg_catalog.jsonb_build_object('previous_worker_id', OLD.worker_id),
                    pg_catalog.now()
                );
            ELSE
                INSERT INTO public.job_events (
                    job_id,
                    business_id,
                    actor_id,
                    actor_role,
                    event_type,
                    previous_status,
                    new_status,
                    metadata,
                    created_at
                ) VALUES (
                    NEW.id,
                    NEW.business_id,
                    v_actor_id,
                    v_actor_role,
                    'worker_reassigned',
                    OLD.status,
                    NEW.status,
                    pg_catalog.jsonb_build_object(
                        'previous_worker_id', OLD.worker_id,
                        'new_worker_id', NEW.worker_id
                    ),
                    pg_catalog.now()
                );
            END IF;
        END IF;

        -- Status changes
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            INSERT INTO public.job_events (
                job_id,
                business_id,
                actor_id,
                actor_role,
                event_type,
                previous_status,
                new_status,
                metadata,
                created_at
            ) VALUES (
                NEW.id,
                NEW.business_id,
                v_actor_id,
                v_actor_role,
                CASE WHEN NEW.status = 'cancelled' THEN 'job_cancelled' ELSE 'status_changed' END,
                OLD.status,
                NEW.status,
                CASE 
                    WHEN NEW.status = 'cancelled' THEN pg_catalog.jsonb_build_object('cancellation_reason', NEW.cancellation_reason)
                    ELSE '{}'::jsonb
                END,
                pg_catalog.now()
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_jobs_handle_event_logging
    AFTER INSERT OR UPDATE ON public.jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_job_event_logging();

-- =============================================================================
-- 6. TABLE: locations
-- =============================================================================

CREATE TABLE public.locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude >= -90.0 AND latitude <= 90.0),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude >= -180.0 AND longitude <= 180.0),
    accuracy DOUBLE PRECISION CHECK (accuracy IS NULL OR accuracy >= 0.0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_locations_worker_created ON public.locations (worker_id, created_at DESC);
CREATE INDEX idx_locations_job_created ON public.locations (job_id, created_at DESC) WHERE job_id IS NOT NULL;

-- =============================================================================
-- 7. TABLE: subscriptions
-- =============================================================================

CREATE TABLE public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'trialing' CHECK (
        status IN ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete')
    ),
    trial_start TIMESTAMPTZ,
    trial_end TIMESTAMPTZ,
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscriptions_status ON public.subscriptions (status);

CREATE TRIGGER trg_subscriptions_updated_at
    BEFORE UPDATE ON public.subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 8. ROW LEVEL SECURITY (RLS) LOCKOUT BASELINE
-- =============================================================================
-- In M3, RLS is enabled across all application tables with zero permissive policies.
-- Normal client requests (anon / authenticated) will be denied by default until M4
-- defines and tests granular tenant-isolation and role-based policies.

ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
