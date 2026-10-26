-- =============================================================================
-- Migration: 20261029010000_device_tokens.sql
-- Module: Dispatcher M15.3 — Secure Push Token Registration & Management
-- Description:
-- 1. Creates public.device_tokens table with strict single-token uniqueness.
-- 2. Supports multiple devices per user while preventing duplicate records.
-- 3. Enforces Row Level Security (RLS) restricting access to token owner.
-- 4. Provides transactional SECURITY DEFINER RPCs:
--    - register_device_token: Authenticated upsert bound to auth.uid()
--    - deactivate_device_token: Clean deactivation on sign-out for current user
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. TABLE: public.device_tokens
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.device_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    expo_push_token TEXT NOT NULL,
    device_platform TEXT NOT NULL DEFAULT 'unknown',
    device_name TEXT,
    app_version TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

    -- Constraints
    CONSTRAINT uq_device_tokens_token UNIQUE (expo_push_token),
    CONSTRAINT chk_device_tokens_platform CHECK (device_platform IN ('ios', 'android', 'web', 'unknown')),
    CONSTRAINT chk_device_tokens_token_len CHECK (pg_catalog.length(pg_catalog.btrim(expo_push_token)) >= 10)
);

-- Fast lookup indexes
CREATE INDEX IF NOT EXISTS idx_device_tokens_user_active
    ON public.device_tokens (user_id)
    WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_device_tokens_business
    ON public.device_tokens (business_id);

CREATE INDEX IF NOT EXISTS idx_device_tokens_token
    ON public.device_tokens (expo_push_token);

-- -----------------------------------------------------------------------------
-- 2. ROW LEVEL SECURITY (RLS) POLICIES
-- -----------------------------------------------------------------------------
ALTER TABLE public.device_tokens ENABLE ROW LEVEL SECURITY;

-- Deny all anonymous access
REVOKE ALL ON public.device_tokens FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_tokens TO authenticated;
GRANT ALL ON public.device_tokens TO service_role;

-- Users can only select their own registered tokens
CREATE POLICY "Users can select own device tokens"
    ON public.device_tokens
    FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

-- Users can insert tokens only for their own authenticated user ID and business
CREATE POLICY "Users can insert own device tokens"
    ON public.device_tokens
    FOR INSERT
    TO authenticated
    WITH CHECK (
        user_id = auth.uid() AND
        business_id = app_auth.current_business_id()
    );

-- Users can update only their own tokens
CREATE POLICY "Users can update own device tokens"
    ON public.device_tokens
    FOR UPDATE
    TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- Users can delete only their own tokens
CREATE POLICY "Users can delete own device tokens"
    ON public.device_tokens
    FOR DELETE
    TO authenticated
    USING (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 3. RPC: public.register_device_token
-- -----------------------------------------------------------------------------
-- Secure, idempotent device token registration.
-- Strictly extracts caller identity from auth.uid() — client cannot spoof user_id.
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
BEGIN
    -- 1. Validate authenticated identity
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required to register device token';
    END IF;

    -- 2. Validate token format
    v_clean_token := pg_catalog.btrim(COALESCE(p_expo_push_token, ''));
    IF pg_catalog.length(v_clean_token) < 10 THEN
        RAISE EXCEPTION 'Invalid push token format: token must be at least 10 characters';
    END IF;

    -- 3. Normalize platform
    v_clean_platform := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_device_platform, 'unknown')));
    IF v_clean_platform NOT IN ('ios', 'android', 'web', 'unknown') THEN
        v_clean_platform := 'unknown';
    END IF;

    -- 4. Retrieve caller profile and business
    SELECT p.business_id, p.is_active
    INTO v_business_id, v_is_active
    FROM public.profiles p
    WHERE p.id = v_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User profile not found';
    END IF;

    IF v_is_active IS FALSE THEN
        RAISE EXCEPTION 'User account is deactivated';
    END IF;

    IF v_business_id IS NULL THEN
        RAISE EXCEPTION 'User is not associated with an active business';
    END IF;

    -- 5. Atomic Upsert on expo_push_token
    -- If token exists (even from previous session or account), reassign to current authenticated user
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
        pg_catalog.btrim(p_device_name),
        pg_catalog.btrim(p_app_version),
        true,
        pg_catalog.now(),
        pg_catalog.now(),
        pg_catalog.now()
    )
    ON CONFLICT (expo_push_token) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        business_id = EXCLUDED.business_id,
        device_platform = EXCLUDED.device_platform,
        device_name = COALESCE(EXCLUDED.device_name, public.device_tokens.device_name),
        app_version = COALESCE(EXCLUDED.app_version, public.device_tokens.app_version),
        is_active = true,
        updated_at = pg_catalog.now(),
        last_used_at = pg_catalog.now()
    RETURNING * INTO v_token_record;

    RETURN v_token_record;
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_device_token(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. RPC: public.deactivate_device_token
-- -----------------------------------------------------------------------------
-- Safely marks a device token as inactive upon user sign-out.
-- Strictly scoped to the authenticated user — cannot deactivate other users' tokens.
CREATE OR REPLACE FUNCTION public.deactivate_device_token(
    p_expo_push_token TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID;
    v_clean_token TEXT;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required to deactivate device token';
    END IF;

    v_clean_token := pg_catalog.btrim(COALESCE(p_expo_push_token, ''));
    IF pg_catalog.length(v_clean_token) < 10 THEN
        RETURN FALSE;
    END IF;

    -- Only deactivate if the token belongs to the calling authenticated user
    UPDATE public.device_tokens
    SET is_active = false,
        updated_at = pg_catalog.now()
    WHERE expo_push_token = v_clean_token
      AND user_id = v_user_id;

    RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.deactivate_device_token(TEXT) TO authenticated;
