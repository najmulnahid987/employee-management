/**
 * Dispatcher M18.2A — RLS and Business Isolation Hardening Verification Tests
 *
 * Verifies:
 * 1. PostgreSQL migration 20261103010000_rls_and_business_isolation_hardening.sql.
 * 2. Revocation of client execute on claim_notification_delivery RPC.
 * 3. Dropping of legacy unauthenticated get_customer_tracking_job(UUID) RPC.
 * 4. Revocation of unauthenticated execution on verify_worker_invitation RPC.
 * 5. Device tokens UPDATE RLS policy hardening (business_id check).
 * 6. Profile mutation guard trigger hardening (locking worker role).
 * 7. Functional index on worker_invitations(upper(invite_code)).
 * 8. Business table immutability guard trigger for id and created_at.
 * 9. Database types synchronization in src/types/database.ts.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

describe('M18.2A Migration & PostgreSQL Security Invariants', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261103010000_rls_and_business_isolation_hardening.sql'
  );

  test('migration file exists and follows chronological timestamp convention', () => {
    assert.ok(fs.existsSync(migrationPath), 'Migration 20261103010000 must exist');
  });

  const sqlContent = fs.readFileSync(migrationPath, 'utf8');

  test('drops legacy unauthenticated tracking RPC get_customer_tracking_job(UUID)', () => {
    assert.ok(
      sqlContent.includes('REVOKE EXECUTE ON FUNCTION public.get_customer_tracking_job(UUID) FROM PUBLIC, anon, authenticated;'),
      'Revokes execute on legacy get_customer_tracking_job(UUID)'
    );
    assert.ok(
      sqlContent.includes('DROP FUNCTION IF EXISTS public.get_customer_tracking_job(UUID);'),
      'Drops legacy get_customer_tracking_job(UUID)'
    );
  });

  test('revokes client execute on claim_notification_delivery from authenticated and anon', () => {
    assert.ok(
      sqlContent.includes('REVOKE EXECUTE ON FUNCTION public.claim_notification_delivery(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;'),
      'Revokes client execution on claim_notification_delivery'
    );
    assert.ok(
      sqlContent.includes('GRANT EXECUTE ON FUNCTION public.claim_notification_delivery(UUID, UUID, UUID, TEXT, TEXT) TO service_role;'),
      'Grants execution exclusively to service_role'
    );
  });

  test('restricts verify_worker_invitation execution strictly to authenticated callers', () => {
    assert.ok(
      sqlContent.includes('REVOKE EXECUTE ON FUNCTION public.verify_worker_invitation(TEXT) FROM PUBLIC, anon;'),
      'Revokes anon execute on verify_worker_invitation'
    );
    assert.ok(
      sqlContent.includes('GRANT EXECUTE ON FUNCTION public.verify_worker_invitation(TEXT) TO authenticated;'),
      'Grants execute to authenticated users'
    );
  });

  test('hardens device_tokens UPDATE RLS policy to enforce business isolation', () => {
    assert.ok(
      sqlContent.includes('CREATE POLICY "Users can update own device tokens"'),
      'Recreates Users can update own device tokens policy'
    );
    assert.ok(
      sqlContent.includes('business_id = app_auth.current_business_id()'),
      'Enforces business_id matching current_business_id() on UPDATE'
    );
    assert.ok(
      sqlContent.includes('user_id = (SELECT auth.uid())'),
      'Enforces user_id matching auth.uid() on UPDATE'
    );
  });

  test('hardens handle_profile_mutation_guard trigger to block worker role modification', () => {
    assert.ok(
      sqlContent.includes('CREATE OR REPLACE FUNCTION public.handle_profile_mutation_guard()'),
      'Defines hardened handle_profile_mutation_guard trigger function'
    );
    assert.ok(
      sqlContent.includes("IF OLD.role = 'worker' AND NEW.role IS DISTINCT FROM OLD.role THEN"),
      'Checks if worker role is being changed'
    );
    assert.ok(
      sqlContent.includes("RAISE EXCEPTION 'Cannot modify worker role once provisioned'"),
      'Raises exception when attempting to alter worker role'
    );
    assert.ok(
      sqlContent.includes('CREATE TRIGGER trg_protect_profile_fields'),
      'Attaches trigger to public.profiles'
    );
  });

  test('adds functional index for fast case-insensitive worker invitation lookups', () => {
    assert.ok(
      sqlContent.includes('CREATE INDEX IF NOT EXISTS idx_worker_invitations_upper_code'),
      'Creates functional index on worker_invitations'
    );
    assert.ok(
      sqlContent.includes('ON public.worker_invitations (upper(invite_code));'),
      'Indexes upper(invite_code) expression'
    );
  });

  test('adds immutability guard trigger on public.businesses table', () => {
    assert.ok(
      sqlContent.includes('CREATE OR REPLACE FUNCTION public.handle_business_mutation_guard()'),
      'Defines handle_business_mutation_guard trigger function'
    );
    assert.ok(
      sqlContent.includes('IF NEW.id IS DISTINCT FROM OLD.id THEN'),
      'Blocks modifying business primary key'
    );
    assert.ok(
      sqlContent.includes('IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN'),
      'Blocks modifying business created_at'
    );
    assert.ok(
      sqlContent.includes('CREATE TRIGGER trg_businesses_protect_immutable_fields'),
      'Installs trigger on public.businesses'
    );
  });
});

describe('Database Types Synchronization', () => {
  const dbTypesPath = path.resolve(process.cwd(), 'src/types/database.ts');
  const dbTypesContent = fs.readFileSync(dbTypesPath, 'utf8');

  test('legacy get_customer_tracking_job is removed from database types', () => {
    assert.equal(
      dbTypesContent.includes('get_customer_tracking_job: {'),
      false,
      'Legacy get_customer_tracking_job must not exist in database types'
    );
  });

  test('modern get_customer_tracking_session_job is present in database types', () => {
    assert.ok(
      dbTypesContent.includes('get_customer_tracking_session_job: {'),
      'get_customer_tracking_session_job must be defined in database types'
    );
  });
});

describe('pgTAP Database Verification Suite 13', () => {
  const pgtapPath = path.resolve(
    process.cwd(),
    'supabase/tests/13_rls_and_business_isolation_hardening.sql'
  );

  test('pgTAP test suite 13 exists and contains 10 planned test assertions', () => {
    assert.ok(fs.existsSync(pgtapPath), '13_rls_and_business_isolation_hardening.sql must exist');
    const content = fs.readFileSync(pgtapPath, 'utf8');
    assert.ok(content.includes('SELECT plan(10);'), 'Plans 10 assertions');
    assert.ok(content.includes('Calling dropped legacy get_customer_tracking_job(UUID)'), 'Test 1 assertion');
    assert.ok(content.includes('Authenticated client execution of claim_notification_delivery is rejected'), 'Test 2 assertion');
    assert.ok(content.includes('Anonymous execution of verify_worker_invitation is rejected'), 'Test 3 assertion');
    assert.ok(content.includes('Authenticated client can verify worker invitation code safely'), 'Test 4 assertion');
    assert.ok(content.includes('Functional index idx_worker_invitations_upper_code exists'), 'Test 5 assertion');
    assert.ok(content.includes('Trigger blocks changing primary key id on public.businesses'), 'Test 6 assertion');
    assert.ok(content.includes('Trigger blocks changing created_at on public.businesses'), 'Test 7 assertion');
    assert.ok(content.includes('Trigger blocks altering worker role once provisioned'), 'Test 8 assertion');
    assert.ok(content.includes('RLS policy blocks altering device token business_id to another business tenant'), 'Test 9 assertion');
    assert.ok(content.includes('Worker successfully updates device metadata for own token within same business'), 'Test 10 assertion');
  });
});

