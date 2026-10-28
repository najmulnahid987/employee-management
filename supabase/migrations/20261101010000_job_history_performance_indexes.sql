-- =============================================================================
-- Migration: 20261101010000_job_history_performance_indexes.sql
-- Module: Dispatcher M16.5 — Job History Query Performance
-- Description:
-- Adds a targeted partial index for business-scoped completed job history.
--
-- Query Pattern Optimized:
--   SELECT * FROM public.jobs
--   WHERE business_id = $1
--     AND status = 'completed'
--     [AND completed_at >= $2 AND completed_at < $3]
--   ORDER BY completed_at DESC NULLS LAST, id DESC
--   LIMIT $limit OFFSET $offset;
--
-- Performance Rationale:
-- 1. Existing index `idx_jobs_business_status (business_id, status)` allows filtering
--    by status, but lacks `completed_at` and `id`. This forces an in-memory Sort
--    (Sort Key: completed_at DESC, id DESC) across all completed jobs of the business.
-- 2. As completed jobs grow monotonically over time, this index enables an
--    efficient B-Tree index scan in exact sort order without any sort overhead.
-- 3. The `WHERE status = 'completed'` predicate ensures this index is a lightweight
--    partial index. Active jobs (unassigned, assigned, accepted, on_the_way,
--    arrived, in_progress) incur ZERO write or storage overhead from this index.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_jobs_business_completed_at
    ON public.jobs (business_id, completed_at DESC, id DESC)
    WHERE status = 'completed';
