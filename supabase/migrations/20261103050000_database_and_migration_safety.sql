-- =============================================================================
-- Migration: 20261103050000_database_and_migration_safety.sql
-- Module: Dispatcher M18.5 — Database and Migration Safety
--
-- Authoritative Specifications:
-- - docs/product-specification.md (Frozen Core Specification)
-- - AGENTS.md (M4, M16, M18 Security and Performance Architecture)
-- - docs/database-schema.md
--
-- Performance & Query Rationale:
-- 1. `idx_jobs_worker_scheduled`:
--    Query Pattern:
--      SELECT * FROM public.jobs
--      WHERE business_id = $1 AND worker_id = $2
--      ORDER BY scheduled_at ASC NULLS LAST, id ASC;
--    Supports `fetchWorkerAssignedJobs` (Worker Jobs tab). Existing index
--    `idx_jobs_worker_status (worker_id, status)` cannot satisfy `scheduled_at`
--    ordering, forcing an in-memory Sort. A partial index on `worker_id IS NOT NULL`
--    enables index scan without in-memory sorting, while adding zero overhead
--    for unassigned jobs.
--
-- 2. `idx_jobs_business_cancelled`:
--    Query Pattern:
--      SELECT * FROM public.jobs
--      WHERE business_id = $1 AND status = 'cancelled'
--        [AND cancelled_at >= $2 AND cancelled_at < $3]
--      ORDER BY cancelled_at DESC NULLS LAST, id DESC;
--    Supports `fetchJobHistory` (Owner Job History tab when filtering cancelled).
--    While completed jobs are indexed by `idx_jobs_business_completed_at`,
--    cancelled jobs filter and sort by `cancelled_at DESC, id DESC`.
--    This partial index eliminates sort overhead on cancelled job history queries.
--
-- Discipline & Safety:
-- - Strictly additive; no existing tables, columns, or migrations are modified.
-- - Partial index filters (`WHERE worker_id IS NOT NULL`, `WHERE status = 'cancelled'`)
--   prevent bloat and avoid write overhead on high-frequency unassigned/active jobs.
-- =============================================================================

BEGIN;

-- 1. Worker assigned jobs schedule index
CREATE INDEX IF NOT EXISTS idx_jobs_worker_scheduled
    ON public.jobs (worker_id, scheduled_at ASC NULLS LAST, id ASC)
    WHERE worker_id IS NOT NULL;

-- 2. Cancelled jobs history index
CREATE INDEX IF NOT EXISTS idx_jobs_business_cancelled
    ON public.jobs (business_id, cancelled_at DESC, id DESC)
    WHERE status = 'cancelled';

COMMIT;
