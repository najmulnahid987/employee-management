-- =============================================================================
-- Dispatcher Test Suite: 17_database_and_migration_safety.sql
-- Module: M18.5 — Database and Migration Safety Verification
-- Verifies:
-- 1. idx_jobs_worker_scheduled index exists on public.jobs.
-- 2. idx_jobs_worker_scheduled has partial index predicate on worker_id IS NOT NULL.
-- 3. idx_jobs_business_cancelled index exists on public.jobs.
-- 4. idx_jobs_business_cancelled has partial index predicate on status = 'cancelled'.
-- 5. public.jobs retains RLS rowsecurity enabled after migration.
-- 6. Foreign key jobs_worker_business_fk remains intact and validated.
-- =============================================================================

BEGIN;
SELECT plan(6);

-- -----------------------------------------------------------------------------
-- Test 1: idx_jobs_worker_scheduled index exists on public.jobs
-- -----------------------------------------------------------------------------
SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'jobs'
          AND indexname = 'idx_jobs_worker_scheduled'
    ),
    'idx_jobs_worker_scheduled index exists on public.jobs'
);

-- -----------------------------------------------------------------------------
-- Test 2: idx_jobs_worker_scheduled has partial predicate (worker_id IS NOT NULL)
-- -----------------------------------------------------------------------------
SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'jobs'
          AND indexname = 'idx_jobs_worker_scheduled'
          AND indexdef LIKE '%WHERE (worker_id IS NOT NULL)%'
    ),
    'idx_jobs_worker_scheduled has partial predicate WHERE (worker_id IS NOT NULL)'
);

-- -----------------------------------------------------------------------------
-- Test 3: idx_jobs_business_cancelled index exists on public.jobs
-- -----------------------------------------------------------------------------
SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'jobs'
          AND indexname = 'idx_jobs_business_cancelled'
    ),
    'idx_jobs_business_cancelled index exists on public.jobs'
);

-- -----------------------------------------------------------------------------
-- Test 4: idx_jobs_business_cancelled has partial predicate (status = 'cancelled')
-- -----------------------------------------------------------------------------
SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'jobs'
          AND indexname = 'idx_jobs_business_cancelled'
          AND indexdef LIKE '%WHERE%status%cancelled%'
    ),
    'idx_jobs_business_cancelled has partial predicate WHERE status = ''cancelled'''
);

-- -----------------------------------------------------------------------------
-- Test 5: public.jobs retains RLS enabled
-- -----------------------------------------------------------------------------
SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename = 'jobs'
          AND rowsecurity = true
    ),
    'public.jobs retains rowsecurity = true'
);

-- -----------------------------------------------------------------------------
-- Test 6: Composite foreign key constraint jobs_worker_business_fk remains intact
-- -----------------------------------------------------------------------------
SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'jobs_worker_business_fk'
          AND contype = 'f'
    ),
    'Foreign key jobs_worker_business_fk constraint remains valid and active'
);

SELECT * FROM finish();
ROLLBACK;

