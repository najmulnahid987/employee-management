-- =============================================================================
-- Migration: 20261031010000_notification_deduplication_retry.sql
-- Module: Dispatcher M15.7 — Notification Deduplication & Token Cleanup
-- Description:
-- 1. Enhances public.notification_deliveries with retry metadata, bounded
--    attempts, and ticket-to-token mapping for deferred receipt verification.
-- 2. Updates public.claim_notification_delivery RPC to enforce attempt bounds
--    (maximum 3 attempts) and prevent infinite retry loops on permanent failures.
-- 3. Stores receipt status and checks timestamps to track physical delivery.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. EXTEND TABLE: public.notification_deliveries
-- -----------------------------------------------------------------------------
ALTER TABLE public.notification_deliveries
    ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_retryable BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS ticket_token_map JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS receipt_status JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS receipts_checked_at TIMESTAMPTZ;

-- Fast index for deliveries awaiting receipt checking
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_receipts
    ON public.notification_deliveries (status, receipts_checked_at)
    WHERE status = 'delivered' AND receipts_checked_at IS NULL;

-- -----------------------------------------------------------------------------
-- 2. RPC: public.claim_notification_delivery (Bounded Retry Version)
-- -----------------------------------------------------------------------------
-- Atomically claims a delivery slot for an event + recipient pair.
-- Enforces:
--   - Deduplication: 'already_delivered' if already delivered
--   - Concurrency lock: 'in_progress' if pending
--   - Bounded retries: 'max_retries_exceeded' if retry_count >= 3 or not retryable
--   - Slot claim: 'claimed' for new or valid transient retry
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
    v_retry_count INTEGER;
    v_is_retryable BOOLEAN;
BEGIN
    -- Check if record already exists under the idempotency key
    SELECT status, retry_count, is_retryable
    INTO v_existing_status, v_retry_count, v_is_retryable
    FROM public.notification_deliveries
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing_status = 'delivered' THEN
            RETURN 'already_delivered';
        ELSIF v_existing_status = 'pending' THEN
            RETURN 'in_progress';
        ELSIF v_existing_status = 'no_tokens' THEN
            -- No registered tokens for user: duplicate webhook suppressed
            RETURN 'already_delivered';
        ELSE
            -- Status is 'failed' -> verify retryability and bounded attempts
            IF v_is_retryable IS FALSE OR COALESCE(v_retry_count, 0) >= 3 THEN
                RETURN 'max_retries_exceeded';
            END IF;

            -- Increment retry count and transition to pending for bounded retry
            UPDATE public.notification_deliveries
            SET status = 'pending',
                retry_count = COALESCE(retry_count, 0) + 1,
                created_at = pg_catalog.now()
            WHERE idempotency_key = p_idempotency_key;

            RETURN 'claimed';
        END IF;
    END IF;

    -- Attempt initial insert with ON CONFLICT DO NOTHING to handle race conditions
    INSERT INTO public.notification_deliveries (
        job_event_id,
        recipient_user_id,
        business_id,
        notification_type,
        idempotency_key,
        status,
        retry_count,
        is_retryable,
        created_at
    ) VALUES (
        p_job_event_id,
        p_recipient_user_id,
        p_business_id,
        p_notification_type,
        p_idempotency_key,
        'pending',
        0,
        true,
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
GRANT EXECUTE ON FUNCTION public.claim_notification_delivery(UUID, UUID, UUID, TEXT, TEXT) TO authenticated;
