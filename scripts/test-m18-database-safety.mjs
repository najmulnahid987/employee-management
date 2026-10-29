/**
 * Dispatcher M18.5 — Database and Migration Safety Verification Tests
 *
 * Verifies:
 * 1. Migration 20261103050000_database_and_migration_safety.sql:
 *    - Additive partial indexes: idx_jobs_worker_scheduled and idx_jobs_business_cancelled.
 *    - Correct columns and sorting specifications.
 *    - Partial predicates to eliminate unassigned and active job overhead.
 *    - Transaction wrapping (BEGIN / COMMIT) and zero destructive DDL.
 * 2. Migration discipline and ordering across all migrations in supabase/migrations/:
 *    - Monotonically increasing UTC timestamps.
 *    - No duplicate migration versions.
 * 3. Bounded pagination and query safety:
 *    - fetchOwnerJobsList bounds queries to a sensible default (100) and max ceiling (250).
 *    - Worker assigned jobs ordering matches idx_jobs_worker_scheduled.
 *    - Cancelled jobs history ordering matches idx_jobs_business_cancelled.
 * 4. Backup & Restore Runbook (docs/database-backup-and-restore-runbook.md):
 *    - Pre-migration backup targets (schema, public tables, credentials, ephemeral limits).
 *    - Tooling options (supabase db dump, pg_dump).
 *    - Secure off-repo encrypted storage (KMS AES-256, versioning, shredding).
 *    - Credential hygiene (interactive prompts, secret injection, no committed secrets).
 *    - Staging/dev restoration procedure and post-restore verification checklist.
 *    - Forward-fix rollback matrix by migration type (indexes, RPCs, RLS, tables).
 *    - Clear operator boundary notice distinguishing procedure from executed dump.
 * 5. pgTAP Test Suite 17:
 *    - 17_database_and_migration_safety.sql exists with planned assertions.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'supabase', 'migrations');
const MIGRATION_FILE = path.join(MIGRATIONS_DIR, '20261103050000_database_and_migration_safety.sql');
const RUNBOOK_FILE = path.join(PROJECT_ROOT, 'docs', 'database-backup-and-restore-runbook.md');
const JOBS_LIB_FILE = path.join(PROJECT_ROOT, 'src', 'lib', 'jobs.ts');
const PGTAP_FILE = path.join(PROJECT_ROOT, 'supabase', 'tests', '17_database_and_migration_safety.sql');

describe('Dispatcher M18.5 — Database and Migration Safety', () => {
  describe('Part A & B: Migration 20261103050000 Invariants', () => {
    test('migration file exists and is strictly additive', () => {
      assert.ok(fs.existsSync(MIGRATION_FILE), 'Migration file must exist');
      const content = fs.readFileSync(MIGRATION_FILE, 'utf-8');

      // Must be wrapped in a transaction
      assert.ok(content.includes('BEGIN;'), 'Migration must begin with transaction');
      assert.ok(content.includes('COMMIT;'), 'Migration must commit transaction');

      // No destructive statements
      assert.doesNotMatch(content, /DROP\s+TABLE/i, 'No DROP TABLE allowed');
      assert.doesNotMatch(content, /DROP\s+COLUMN/i, 'No DROP COLUMN allowed');
      assert.doesNotMatch(content, /TRUNCATE/i, 'No TRUNCATE allowed');
      assert.doesNotMatch(content, /ALTER\s+TABLE.*DROP/i, 'No destructive ALTER TABLE DROP');
    });

    test('defines worker schedule partial index idx_jobs_worker_scheduled', () => {
      const content = fs.readFileSync(MIGRATION_FILE, 'utf-8');

      assert.ok(
        content.includes('CREATE INDEX IF NOT EXISTS idx_jobs_worker_scheduled'),
        'Must define idx_jobs_worker_scheduled'
      );
      assert.ok(
        content.includes('(worker_id, scheduled_at ASC NULLS LAST, id ASC)'),
        'Index must cover worker_id, scheduled_at ASC NULLS LAST, id ASC'
      );
      assert.ok(
        content.includes('WHERE worker_id IS NOT NULL'),
        'Index must have partial filter WHERE worker_id IS NOT NULL'
      );
    });

    test('defines cancelled job history partial index idx_jobs_business_cancelled', () => {
      const content = fs.readFileSync(MIGRATION_FILE, 'utf-8');

      assert.ok(
        content.includes('CREATE INDEX IF NOT EXISTS idx_jobs_business_cancelled'),
        'Must define idx_jobs_business_cancelled'
      );
      assert.ok(
        content.includes('(business_id, cancelled_at DESC, id DESC)'),
        'Index must cover business_id, cancelled_at DESC, id DESC'
      );
      assert.ok(
        content.includes("WHERE status = 'cancelled'"),
        'Index must have partial filter WHERE status = cancelled'
      );
    });

    test('all migrations in supabase/migrations have strictly ordered timestamps', () => {
      const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      assert.ok(files.length >= 7, 'Expected at least 7 migrations');

      let previousTimestamp = '';
      for (const file of files) {
        const match = file.match(/^(\d{14})_/);
        assert.ok(match, `Migration filename ${file} must start with 14-digit timestamp`);
        const timestamp = match[1];

        assert.ok(
          timestamp > previousTimestamp,
          `Migration timestamps must be strictly monotonic: ${file} (${timestamp}) <= previous (${previousTimestamp})`
        );
        previousTimestamp = timestamp;
      }
    });
  });

  describe('Part A: Query Safety & Bounded Limits in jobs.ts', () => {
    test('fetchOwnerJobsList enforces bounded query limits', () => {
      assert.ok(fs.existsSync(JOBS_LIB_FILE), 'jobs.ts must exist');
      const content = fs.readFileSync(JOBS_LIB_FILE, 'utf-8');

      // Verify function signature has default limit
      assert.match(
        content,
        /export async function fetchOwnerJobsList\s*\(\s*businessId:\s*string,\s*limit:\s*number\s*=\s*100\s*\)/,
        'fetchOwnerJobsList must accept bounded limit with default 100'
      );

      // Verify query has .limit(...) with clamping
      assert.ok(
        content.includes('.limit(Math.min(Math.max(1, limit), 250))'),
        'Query must clamp and bound limit between 1 and 250'
      );
    });

    test('worker assigned jobs query matches idx_jobs_worker_scheduled ordering', () => {
      const content = fs.readFileSync(JOBS_LIB_FILE, 'utf-8');

      assert.ok(
        content.includes(".order('scheduled_at', { ascending: true, nullsFirst: false })"),
        'Worker assigned jobs query must order by scheduled_at ascending nulls last'
      );
    });

    test('job history query matches idx_jobs_business_cancelled ordering', () => {
      const content = fs.readFileSync(JOBS_LIB_FILE, 'utf-8');

      assert.ok(
        content.includes("statusFilter === 'cancelled'\n          ? 'cancelled_at'"),
        'Cancelled jobs must use cancelled_at timestamp column'
      );
      assert.ok(
        content.includes(".order(timestampCol, { ascending: false, nullsFirst: false })"),
        'Job history query must order by timestampCol descending nulls last'
      );
      assert.ok(
        content.includes(".order('id', { ascending: false })"),
        'Job history query must order by id descending for deterministic pagination'
      );
    });
  });

  describe('Part C & D: Backup, Restore & Rollback Runbook', () => {
    test('runbook file exists with comprehensive sections', () => {
      assert.ok(fs.existsSync(RUNBOOK_FILE), 'Runbook file must exist at docs/database-backup-and-restore-runbook.md');
      const content = fs.readFileSync(RUNBOOK_FILE, 'utf-8');

      // Operator Boundary Notice
      assert.ok(
        content.includes('Operational Boundary Notice'),
        'Runbook must include operator boundary notice'
      );

      // Backup Targets
      assert.ok(content.includes('Schema & DDL Definitions'), 'Must specify DDL targets');
      assert.ok(content.includes('Authoritative Business Data'), 'Must specify data targets');
      assert.ok(content.includes('Ephemeral Tables'), 'Must document rate_limit_buckets as ephemeral');

      // Tooling
      assert.ok(content.includes('supabase db dump'), 'Must document Supabase CLI dump command');
      assert.ok(content.includes('pg_dump'), 'Must document native pg_dump command');

      // Secure Storage
      assert.ok(content.includes('Encrypted Object Storage'), 'Must document encrypted cloud storage');
      assert.ok(content.includes('KMS encryption'), 'Must require KMS encryption');
      assert.ok(content.includes('shred'), 'Must specify local dump shredding');

      // Credential Hygiene
      assert.ok(content.includes('Credential Hygiene'), 'Must include credential hygiene section');
      assert.ok(content.includes('PGPASSWORD'), 'Must demonstrate secure password injection');

      // Staging Restoration
      assert.ok(content.includes('Staging Target'), 'Must document staging environment setup');
      assert.ok(content.includes('Post-Restore Verification Checklist'), 'Must include post-restore checklist');
      assert.ok(content.includes('Row Count Sanity Check'), 'Checklist must include row counts');
      assert.ok(content.includes('Foreign Key & Constraint Integrity'), 'Checklist must verify constraints');
      assert.ok(content.includes('RLS Policy Verification'), 'Checklist must verify RLS enabled');

      // Recovery Matrix & Forward-Fix
      assert.ok(content.includes('Forward-Fix Recovery Strategy'), 'Must articulate forward-fix preference');
      assert.ok(content.includes('Recovery Matrix by Migration Type'), 'Must include recovery matrix table');
      assert.ok(content.includes('DROP INDEX CONCURRENTLY'), 'Index recovery must recommend concurrent drop');
    });
  });

  describe('Part E: pgTAP Test Suite 17', () => {
    test('pgtap test suite 17 exists with required test plan', () => {
      assert.ok(fs.existsSync(PGTAP_FILE), 'Test file 17_database_and_migration_safety.sql must exist');
      const content = fs.readFileSync(PGTAP_FILE, 'utf-8');

      assert.ok(content.includes('SELECT plan(6);'), 'Test plan must declare 6 tests');
      assert.ok(content.includes('idx_jobs_worker_scheduled'), 'Must assert worker schedule index');
      assert.ok(content.includes('idx_jobs_business_cancelled'), 'Must assert cancelled history index');
      assert.ok(content.includes('rowsecurity = true'), 'Must assert RLS remains enabled');
      assert.ok(content.includes('jobs_worker_business_fk'), 'Must assert foreign key constraint remains valid');
      assert.ok(content.includes('SELECT * FROM finish();'), 'Must conclude with finish()');
      assert.ok(content.includes('ROLLBACK;'), 'Must rollback to avoid mutating test db');
    });
  });
});
