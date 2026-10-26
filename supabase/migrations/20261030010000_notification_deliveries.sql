-- =============================================================================
-- Migration: 20261030010000_notification_deliveries.sql
-- Module: Dispatcher M15.4 — Secure Notification Delivery & Idempotency Outbox
-- Description:
-- 1. Creates public.notification_deliveries table storing delivery state,
--    recipient reference, event linkage, and retry metadata.
-- 2. Enforces strict idempotency constraint: UNIQUE (idempotency_key).
--    Prevents duplicate notifications for the same event and recipient.
-- 3. Implements Row Level Security (RLS) restricting reads to recipient owner.
-- 4. Provides transactional SECURITY DEFINER claim RPC to prevent concurrent
--    webhook delivery race conditions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. TABLE: public.notification_deliveries
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_event_id UUID NOT NULL REFERENCES public.job_events(id) ON DELETE CASCADE,
    recipient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL CHECK (
        notification_type IN ('job_assigned', 'job_accepted', 'worker_arrived', 'job_completed')
    ),
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'delivered', 'failed', 'no_tokens')
    ),
    device_tokens_count INTEGER NOT NULL DEFAULT 0,
    expo_ticket_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    delivered_at TIMESTAMPTZ,

    -- Idempotency key uniqueness guarantees at most ONE logical notification per event & recipient!
    CONSTRAINT uq_notification_deliveries_idempotency UNIQUE (idempotency_key)
);

-- Fast lookup indexes
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_event
    ON public.notification_deliveries (job_event_id);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_recipient
    ON public.notification_deliveries (recipient_user_id, status);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_business
    ON public.notification_deliveries (business_id);

-- -----------------------------------------------------------------------------
-- 2. ROW LEVEL SECURITY (RLS) POLICIES
-- -----------------------------------------------------------------------------
ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;

-- Deny all anonymous access
REVOKE ALL ON public.notification_deliveries FROM anon;
GRANT SELECT ON public.notification_deliveries TO authenticated;
GRANT ALL ON public.notification_deliveries TO service_role;

-- Recipients can view only notifications delivered to them
CREATE POLICY "Users can select own notification deliveries"
    ON public.notification_deliveries
    FOR SELECT
    TO authenticated
    USING (recipient_user_id = auth.uid());

-- Direct mutations revoked from authenticated users (service-role / trigger only)
REVOKE INSERT, UPDATE, DELETE ON public.notification_deliveries FROM authenticated;

-- -----------------------------------------------------------------------------
-- 3. RPC: public.claim_notification_delivery
-- -----------------------------------------------------------------------------
-- Atomically claims a delivery slot for an event + recipient pair.
-- Returns:
--   - 'claimed': Slot successfully claimed, caller should proceed with delivery
--   - 'already_delivered': Event already completed delivery to this recipient
--   - 'in_progress': Concurrently being processed by another worker
CREATE OR REPLACE FUNCTION public.claim_notification_delivery(
    p_job_event_id UUID,
    p_recipient_user_id UUID,
    p_business_id UUID,
    p_notification_type TEXT,
    p_idempotency_key TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_existing_status TEXT;
BEGIN
    -- Check if record already exists under the idempotency key
    SELECT status INTO v_existing_status
    FROM public.notification_deliveries
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing_status = 'delivered' THEN
            RETURN 'already_delivered';
        ELSIF v_existing_status = 'pending' THEN
            RETURN 'in_progress';
        ELSE
            -- Failed or no_tokens can be retried by updating to pending
            UPDATE public.notification_deliveries
            SET status = 'pending',
                created_at = pg_catalog.now()
            WHERE idempotency_key = p_idempotency_key;

            RETURN 'claimed';
        END IF;
    END IF;

    -- Attempt insert with ON CONFLICT DO NOTHING to handle concurrent race conditions
    INSERT INTO public.notification_deliveries (
        job_event_id,
        recipient_user_id,
        business_id,
        notification_type,
        idempotency_key,
        status,
        created_at
    ) VALUES (
        p_job_event_id,
        p_recipient_user_id,
        p_business_id,
        p_notification_type,
        p_idempotency_key,
        'pending',
        pg_catalog.now()
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    -- Verify if our insert claimed the slot
    IF FOUND THEN
        RETURN 'claimed';
    ELSE
        -- Concurrent insert won the race
        SELECT status INTO v_existing_status
        FROM public.notification_deliveries
        WHERE idempotency_key = p_idempotency_key;

        IF v_existing_status = 'delivered' THEN
            RETURN 'already_delivered';
        ELSE
            RETURN 'in_progress';
        END IF;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_notification_delivery(UUID, UUID, UUID, TEXT, TEXT) TO service_role;
