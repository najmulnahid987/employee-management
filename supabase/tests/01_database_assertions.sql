-- =============================================================================
-- Dispatcher Test Suite: 01_database_assertions.sql
-- Verifies RLS flags, grants, function privileges, and search_path settings
-- =============================================================================

BEGIN;
SELECT plan(18);

-- 1. Verify RLS is enabled on all six application tables
SELECT ok(
    (SELECT relrowsecurity FROM pg_class WHERE relname = 'businesses' AND relnamespace = 'public'::regnamespace),
    'businesses table must have RLS enabled'
);

SELECT ok(
    (SELECT relrowsecurity FROM pg_class WHERE relname = 'profiles' AND relnamespace = 'public'::regnamespace),
    'profiles table must have RLS enabled'
);

SELECT ok(
    (SELECT relrowsecurity FROM pg_class WHERE relname = 'jobs' AND relnamespace = 'public'::regnamespace),
    'jobs table must have RLS enabled'
);

SELECT ok(
    (SELECT relrowsecurity FROM pg_class WHERE relname = 'job_events' AND relnamespace = 'public'::regnamespace),
    'job_events table must have RLS enabled'
);

SELECT ok(
    (SELECT relrowsecurity FROM pg_class WHERE relname = 'locations' AND relnamespace = 'public'::regnamespace),
    'locations table must have RLS enabled'
);

SELECT ok(
    (SELECT relrowsecurity FROM pg_class WHERE relname = 'subscriptions' AND relnamespace = 'public'::regnamespace),
    'subscriptions table must have RLS enabled'
);

-- 2. Verify Anonymous Role has ZERO direct table grants on application tables
SELECT is(
    (SELECT count(*)::int FROM information_schema.table_privileges 
     WHERE table_schema = 'public' 
       AND table_name IN ('businesses', 'profiles', 'jobs', 'job_events', 'locations', 'subscriptions')
       AND grantee = 'anon'),
    0,
    'anon role must possess zero direct privileges on public application tables'
);

-- 3. Verify Authenticated Role cannot directly INSERT into job_events
SELECT is(
    (SELECT count(*)::int FROM information_schema.table_privileges 
     WHERE table_schema = 'public' 
       AND table_name = 'job_events'
       AND grantee = 'authenticated'
       AND privilege_type = 'INSERT'),
    0,
    'authenticated role must not have direct INSERT privilege on job_events'
);

-- 4. Verify Authenticated Role cannot directly UPDATE or DELETE subscriptions
SELECT is(
    (SELECT count(*)::int FROM information_schema.table_privileges 
     WHERE table_schema = 'public' 
       AND table_name = 'subscriptions'
       AND grantee = 'authenticated'
       AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')),
    0,
    'authenticated role must not have write privileges on subscriptions'
);

-- 5. Verify Authenticated Role cannot directly DELETE jobs
SELECT is(
    (SELECT count(*)::int FROM information_schema.table_privileges 
     WHERE table_schema = 'public' 
       AND table_name = 'jobs'
       AND grantee = 'authenticated'
       AND privilege_type = 'DELETE'),
    0,
    'authenticated role must not have direct DELETE privilege on jobs'
);

-- 6. Verify Authenticated Role cannot directly DELETE or UPDATE locations
SELECT is(
    (SELECT count(*)::int FROM information_schema.table_privileges 
     WHERE table_schema = 'public' 
       AND table_name = 'locations'
       AND grantee = 'authenticated'
       AND privilege_type IN ('UPDATE', 'DELETE')),
    0,
    'authenticated role must not have UPDATE or DELETE privilege on locations'
);

-- 7. Verify search_path is hardened on critical trigger functions
SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'handle_job_event_logging'
          AND 'search_path=' = ANY(p.proconfig)
    ),
    'handle_job_event_logging must have explicit search_path='''''
);

SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'validate_job_lifecycle_transition'
          AND 'search_path=' = ANY(p.proconfig)
    ),
    'validate_job_lifecycle_transition must have explicit search_path='''''
);

SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'get_customer_tracking_job'
          AND 'search_path=' = ANY(p.proconfig)
    ),
    'get_customer_tracking_job must have explicit search_path='''''
);

-- 8. Verify app_auth helper functions exist and have hardened search_path
SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app_auth'
          AND p.proname = 'current_business_id'
          AND 'search_path=' = ANY(p.proconfig)
    ),
    'app_auth.current_business_id must exist with search_path='''''
);

SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app_auth'
          AND p.proname = 'current_user_role'
          AND 'search_path=' = ANY(p.proconfig)
    ),
    'app_auth.current_user_role must exist with search_path='''''
);

SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app_auth'
          AND p.proname = 'is_business_owner'
          AND 'search_path=' = ANY(p.proconfig)
    ),
    'app_auth.is_business_owner must exist with search_path='''''
);

SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app_auth'
          AND p.proname = 'is_active_worker'
          AND 'search_path=' = ANY(p.proconfig)
    ),
    'app_auth.is_active_worker must exist with search_path='''''
);

SELECT * FROM finish();
ROLLBACK;
