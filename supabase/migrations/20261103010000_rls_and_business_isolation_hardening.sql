-- =============================================================================
-- Migration: 20261103010000_rls_and_business_isolation_hardening.sql
-- Module: Dispatcher M18.2A — Row Level Security & Business Isolation Hardening
--
-- Authoritative Specifications:
-- - docs/product-specification.md (Frozen Core Specification)
-- - AGENTS.md (M4, M13, M18 Security Architecture)
-- - docs/database-schema.md
--
-- Goals:
-- 1. Drop obsolete legacy unauthenticated tracking RPC public.get_customer_tracking_job(UUID)
--    which bypassed M13 session-token hashing and expiration checks.
-- 2. Revoke client execution on public.claim_notification_delivery(UUID, UUID, UUID, TEXT, TEXT)
--    from 'authenticated' and 'anon', granting strictly to 'service_role'.
-- 3. Revoke unauthenticated public execution on public.verify_worker_invitation(TEXT)
--    from 'anon', ensuring only authenticated users can check or verify invitation codes.
-- 4. Harden public.device_tokens UPDATE RLS policy to enforce that users cannot alter
--    business_id to another business tenant.
-- 5. Harden public.handle_profile_mutation_guard() trigger to prevent altering worker role
--    once provisioned, closing the trigger-level defense gap for worker profiles.
-- 6. Add functional index on public.worker_invitations(upper(invite_code)) to optimize
--    case-insensitive invitation code lookups and eliminate sequential table scans.
-- 7. Add public.handle_business_mutation_guard() trigger on public.businesses to prevent
--    modifying immutable primary key 'id' and creation timestamp 'created_at'.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. DROP OBSOLETE LEGACY CUSTOMER TRACKING RPC
-- -----------------------------------------------------------------------------
-- M13 superseded single-UUID tracking with high-entropy hashed customer_tracking_sessions.
-- The legacy function lacked expiration, revocation, and active state checks.
REVOKE EXECUTE ON FUNCTION public.get_customer_tracking_job(UUID) FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.get_customer_tracking_job(UUID);

-- -----------------------------------------------------------------------------
-- 2. SECURE NOTIFICATION DELIVERY CLAIM RPC (LEAST PRIVILEGE)
-- -----------------------------------------------------------------------------
-- claim_notification_delivery is an internal outbox function meant exclusively for
-- server-side webhook background workers using service_role. Regular authenticated
-- users must NOT have execute privileges on this function.
REVOKE EXECUTE ON FUNCTION public.claim_notification_delivery(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_delivery(UUID, UUID, UUID, TEXT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 3. RESTRICT INVITATION CODE VERIFICATION TO AUTHENTICATED CALLERS
-- -----------------------------------------------------------------------------
-- Revoking anon execution prevents unauthenticated brute-force enumeration of
-- active 8-character invitation codes via PostgREST.
REVOKE EXECUTE ON FUNCTION public.verify_worker_invitation(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_worker_invitation(TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. HARDEN DEVICE TOKENS UPDATE RLS POLICY
-- -----------------------------------------------------------------------------
-- Ensure users can only update their own tokens AND cannot transfer a token to another business tenant.
DROP POLICY IF EXISTS "Users can update own device tokens" ON public.device_tokens;
CREATE POLICY "Users can update own device tokens"
    ON public.device_tokens
    FOR UPDATE
    TO authenticated
    USING (user_id = (SELECT auth.uid()))
    WITH CHECK (
        user_id = (SELECT auth.uid())
        AND business_id = app_auth.current_business_id()
    );

-- -----------------------------------------------------------------------------
-- 5. HARDEN PROFILE MUTATION GUARD TRIGGER (LOCK WORKER ROLE)
-- -----------------------------------------------------------------------------
-- Enforce that once provisioned, a worker's role cannot be altered by either workers or owners.
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
        IF OLD.role = 'worker' AND NEW.role IS DISTINCT FROM OLD.role THEN
            RAISE EXCEPTION 'Cannot modify worker role once provisioned'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;

-- Ensure trigger is active on public.profiles
DROP TRIGGER IF EXISTS trg_protect_profile_fields ON public.profiles;
CREATE TRIGGER trg_protect_profile_fields
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_profile_mutation_guard();

-- -----------------------------------------------------------------------------
-- 6. FUNCTIONAL INDEX ON WORKER INVITATIONS CODE
-- -----------------------------------------------------------------------------
-- Optimize WHERE upper(invite_code) = upper(...) queries
CREATE INDEX IF NOT EXISTS idx_worker_invitations_upper_code
    ON public.worker_invitations (upper(invite_code));

-- -----------------------------------------------------------------------------
-- 7. BUSINESS TABLE IMMUTABILITY GUARD
-- -----------------------------------------------------------------------------
-- Protect immutable primary key and creation timestamp on public.businesses
CREATE OR REPLACE FUNCTION public.handle_business_mutation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'Business ID cannot be altered'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Business created_at cannot be altered'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_businesses_protect_immutable_fields ON public.businesses;
CREATE TRIGGER trg_businesses_protect_immutable_fields
    BEFORE UPDATE ON public.businesses
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_business_mutation_guard();

COMMIT;

