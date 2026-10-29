-- =============================================================================
-- Migration: 20261102010000_security_patches_and_worker_onboarding.sql
-- Description:
--   1. Drop legacy 2-arg signature of generate_customer_tracking_session.
--   2. Strengthen profiles_self_update RLS and add handle_profile_mutation_guard
--      trigger to prevent non-owners from modifying role, business tenancy, or
--      account active status (is_active).
--   3. Create worker_invitations schema and RLS policies for owner team invites.
--   4. Implement trusted transactional RPCs:
--      - create_worker_invitation(p_email TEXT)
--      - verify_worker_invitation(p_invite_code TEXT)
--      - join_business_team(p_invite_code TEXT, p_full_name TEXT, p_phone TEXT)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. DROP LEGACY FUNCTION SIGNATURE
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.generate_customer_tracking_session(UUID, INT);

-- -----------------------------------------------------------------------------
-- 2. PROFILE MUTATION DEFENSE & RLS PATCH
-- -----------------------------------------------------------------------------

-- Replace profiles_self_update to explicitly check that is_active cannot be tampered with
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
        AND is_active = (SELECT p.is_active FROM public.profiles p WHERE p.id = profiles.id)
    );

-- Trigger-level defense guarding against any unauthorized modifications to role, business_id, or is_active
CREATE OR REPLACE FUNCTION public.handle_profile_mutation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- If actor is NOT a verified business owner of the profile's business
    IF NOT app_auth.is_business_owner() THEN
        IF NEW.role IS DISTINCT FROM OLD.role THEN
            RAISE EXCEPTION 'Cannot modify user role'
                USING ERRCODE = '42501';
        END IF;
        IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
            RAISE EXCEPTION 'Cannot modify user business tenancy'
                USING ERRCODE = '42501';
        END IF;
        IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
            RAISE EXCEPTION 'Non-owners cannot modify account active status'
                USING ERRCODE = '42501';
        END IF;
    ELSE
        -- Even business owners cannot modify business tenancy or worker role once provisioned
        IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
            RAISE EXCEPTION 'Cannot modify user business tenancy'
                USING ERRCODE = '42501';
        END IF;
        IF NEW.id = (SELECT auth.uid()) AND NEW.role IS DISTINCT FROM OLD.role THEN
            RAISE EXCEPTION 'Cannot modify business owner role'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_fields ON public.profiles;
CREATE TRIGGER trg_protect_profile_fields
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_profile_mutation_guard();

-- -----------------------------------------------------------------------------
-- 3. WORKER INVITATIONS SCHEMA & RLS
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.worker_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    invite_code TEXT NOT NULL UNIQUE,
    invited_by UUID NOT NULL REFERENCES auth.users(id),
    email TEXT NULL,
    is_used BOOLEAN NOT NULL DEFAULT false,
    used_by UUID NULL REFERENCES auth.users(id),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '7 days'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Index for fast lookup by code and business
CREATE INDEX IF NOT EXISTS idx_worker_invitations_code ON public.worker_invitations(invite_code);
CREATE INDEX IF NOT EXISTS idx_worker_invitations_business ON public.worker_invitations(business_id);

ALTER TABLE public.worker_invitations ENABLE ROW LEVEL SECURITY;

-- Revoke direct mutation from clients
REVOKE ALL ON public.worker_invitations FROM anon, authenticated;
GRANT SELECT ON public.worker_invitations TO authenticated;

-- Owner SELECT policy: owners can view invitations for their own business
DROP POLICY IF EXISTS "worker_invitations_owner_select" ON public.worker_invitations;
CREATE POLICY "worker_invitations_owner_select"
    ON public.worker_invitations
    FOR SELECT
    TO authenticated
    USING (
        business_id = app_auth.current_business_id()
        AND app_auth.is_business_owner()
    );

-- -----------------------------------------------------------------------------
-- 4. WORKER INVITATION & ONBOARDING RPCS
-- -----------------------------------------------------------------------------

-- 4.1 Owner creates invitation
CREATE OR REPLACE FUNCTION public.create_worker_invitation(
    p_email TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_id UUID;
    v_business_id UUID;
    v_code TEXT;
    v_invitation_id UUID;
    v_expires_at TIMESTAMPTZ;
BEGIN
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT app_auth.is_business_owner() THEN
        RAISE EXCEPTION 'Only business owners can create worker invitations'
            USING ERRCODE = '42501';
    END IF;

    v_business_id := app_auth.current_business_id();
    IF v_business_id IS NULL THEN
        RAISE EXCEPTION 'Business context not found'
            USING ERRCODE = '42501';
    END IF;

    -- Generate random 8-character uppercase alphanumeric code: DISP-XXXX-XXXX
    v_code := 'DISP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)) || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 5, 4));
    v_expires_at := clock_timestamp() + interval '7 days';

    INSERT INTO public.worker_invitations (
        business_id,
        invite_code,
        invited_by,
        email,
        expires_at
    ) VALUES (
        v_business_id,
        v_code,
        v_caller_id,
        NULLIF(trim(p_email), ''),
        v_expires_at
    )
    RETURNING id INTO v_invitation_id;

    RETURN jsonb_build_object(
        'id', v_invitation_id,
        'business_id', v_business_id,
        'invite_code', v_code,
        'expires_at', v_expires_at
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_worker_invitation(TEXT) TO authenticated;

-- 4.2 Verify invitation code (safe public/authenticated check)
CREATE OR REPLACE FUNCTION public.verify_worker_invitation(
    p_invite_code TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_inv RECORD;
    v_business RECORD;
BEGIN
    IF p_invite_code IS NULL OR length(trim(p_invite_code)) = 0 THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Invitation code is required');
    END IF;

    SELECT id, business_id, is_used, expires_at
    INTO v_inv
    FROM public.worker_invitations
    WHERE upper(invite_code) = upper(trim(p_invite_code));

    IF NOT FOUND THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Invalid invitation code');
    END IF;

    IF v_inv.is_used THEN
        RETURN jsonb_build_object('valid', false, 'error', 'This invitation code has already been used');
    END IF;

    IF v_inv.expires_at <= clock_timestamp() THEN
        RETURN jsonb_build_object('valid', false, 'error', 'This invitation code has expired');
    END IF;

    SELECT id, name
    INTO v_business
    FROM public.businesses
    WHERE id = v_inv.business_id;

    RETURN jsonb_build_object(
        'valid', true,
        'invitation_id', v_inv.id,
        'business_id', v_inv.business_id,
        'business_name', COALESCE(v_business.name, 'Dispatcher Business')
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_worker_invitation(TEXT) TO authenticated, anon;

-- 4.3 Worker joins business team
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

    v_trimmed_name := trim(COALESCE(p_full_name, ''));
    IF length(v_trimmed_name) = 0 THEN
        RAISE EXCEPTION 'Full name is required to join'
            USING ERRCODE = '22023';
    END IF;

    v_trimmed_phone := NULLIF(trim(COALESCE(p_phone, '')), '');

    -- Lock and validate invitation
    SELECT id, business_id, is_used, expires_at
    INTO v_inv
    FROM public.worker_invitations
    WHERE upper(invite_code) = upper(trim(p_invite_code))
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
