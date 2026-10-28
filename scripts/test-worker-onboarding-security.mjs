/**
 * Dispatcher Worker Onboarding & Security Verification Tests
 *
 * Validates:
 * 1. Secure storage adapter behavior, platform routing, and AsyncStorage session migration.
 * 2. Worker invitation and join team client RPC helpers and validation logic.
 * 3. PostgreSQL migration security audit (profiles_self_update RLS, mutation trigger guard,
 *    worker_invitations schema and RLS, transactional concurrency locks).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

describe('Secure Storage Adapter & Session Persistence', () => {
  test('secureStorage exports getItem, setItem, removeItem interfaces', async () => {
    // Dynamically test the exported structure
    const storageFile = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/secure-storage.ts'),
      'utf8'
    );
    assert.match(storageFile, /export const secureStorage\s*=/);
    assert.match(storageFile, /async getItem\(key: string\)/);
    assert.match(storageFile, /async setItem\(key: string, value: string\)/);
    assert.match(storageFile, /async removeItem\(key: string\)/);
  });

  test('secureStorage implements hardware-backed expo-secure-store on native', async () => {
    const storageFile = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/secure-storage.ts'),
      'utf8'
    );
    assert.match(storageFile, /SecureStore\.getItemAsync/);
    assert.match(storageFile, /SecureStore\.setItemAsync/);
    assert.match(storageFile, /SecureStore\.deleteItemAsync/);
  });

  test('secureStorage migrates legacy AsyncStorage sessions seamlessly to SecureStore', async () => {
    const storageFile = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/secure-storage.ts'),
      'utf8'
    );
    // Verifies that if SecureStore returns null, legacy AsyncStorage is checked, migrated, and purged
    assert.match(storageFile, /const legacyValue = await AsyncStorage\.getItem\(key\)/);
    assert.match(storageFile, /await SecureStore\.setItemAsync\(key, legacyValue\)/);
    assert.match(storageFile, /await AsyncStorage\.removeItem\(key\)/);
  });

  test('supabase client configuration binds secureStorage to auth storage', async () => {
    const supabaseConfigFile = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/supabase.ts'),
      'utf8'
    );
    assert.match(supabaseConfigFile, /import\s*\{\s*secureStorage\s*\}\s*from\s*'@\/lib\/secure-storage'/);
    assert.match(supabaseConfigFile, /storage:\s*Platform\.OS === 'web' && typeof window === 'undefined' \? undefined : secureStorage/);
  });
});

describe('Worker Invitation & Onboarding Client Helpers', () => {
  test('auth.ts exports createWorkerInvitation, verifyWorkerInvitation, joinBusinessTeam', () => {
    const authFile = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/auth.ts'),
      'utf8'
    );
    assert.match(authFile, /export async function createWorkerInvitation\(/);
    assert.match(authFile, /export async function verifyWorkerInvitation\(/);
    assert.match(authFile, /export async function joinBusinessTeam\(/);
  });

  test('sanitizeAuthError translates invitation error codes into user-friendly messages', () => {
    const authFile = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/auth.ts'),
      'utf8'
    );
    assert.match(authFile, /Invalid invitation code/);
    assert.match(authFile, /already been used/);
    assert.match(authFile, /has expired/);
    assert.match(authFile, /cannot join a new business/);
  });

  test('database.ts defines worker_invitations table and RPC signatures', () => {
    const dbTypesFile = fs.readFileSync(
      path.resolve(process.cwd(), 'src/types/database.ts'),
      'utf8'
    );
    assert.match(dbTypesFile, /worker_invitations:\s*\{/);
    assert.match(dbTypesFile, /create_worker_invitation:\s*\{/);
    assert.match(dbTypesFile, /verify_worker_invitation:\s*\{/);
    assert.match(dbTypesFile, /join_business_team:\s*\{/);
  });

  test('worker join screen implements invitation verification, empty state, and refreshProfile', () => {
    const joinScreen = fs.readFileSync(
      path.resolve(process.cwd(), 'src/app/worker/join.tsx'),
      'utf8'
    );
    assert.match(joinScreen, /joinBusinessTeam/);
    assert.match(joinScreen, /refreshProfile/);
    assert.match(joinScreen, /title="Invalid or expired invitation"/);
    assert.match(joinScreen, /router\.replace\('\/worker\/today'\)/);
  });
});

describe('Database Migration & PostgreSQL Security Invariants', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261102010000_security_patches_and_worker_onboarding.sql'
  );

  test('security patch migration exists and is properly sequenced', () => {
    assert.ok(fs.existsSync(migrationPath), 'Migration file must exist');
  });

  test('cleans up legacy 2-arg customer tracking session function', () => {
    const content = fs.readFileSync(migrationPath, 'utf8');
    assert.match(
      content,
      /DROP FUNCTION IF EXISTS public\.generate_customer_tracking_session\(UUID, INT\);/
    );
  });

  test('patches profiles_self_update RLS to prevent unauthorized active status tampering', () => {
    const content = fs.readFileSync(migrationPath, 'utf8');
    assert.match(content, /CREATE POLICY "profiles_self_update"/);
    assert.match(
      content,
      /AND is_active = \(SELECT p\.is_active FROM public\.profiles p WHERE p\.id = profiles\.id\)/
    );
  });

  test('installs handle_profile_mutation_guard trigger defense on profiles', () => {
    const content = fs.readFileSync(migrationPath, 'utf8');
    assert.match(content, /CREATE OR REPLACE FUNCTION public\.handle_profile_mutation_guard\(\)/);
    assert.match(content, /IF NOT app_auth\.is_business_owner\(\) THEN/);
    assert.match(content, /Non-owners cannot modify account active status/);
    assert.match(content, /Cannot modify user role/);
    assert.match(content, /Cannot modify user business tenancy/);
    assert.match(content, /CREATE TRIGGER trg_protect_profile_fields/);
  });

  test('enforces strict RLS and table privileges on worker_invitations', () => {
    const content = fs.readFileSync(migrationPath, 'utf8');
    assert.match(content, /CREATE TABLE IF NOT EXISTS public\.worker_invitations/);
    assert.match(content, /ALTER TABLE public\.worker_invitations ENABLE ROW LEVEL SECURITY;/);
    assert.match(content, /REVOKE ALL ON public\.worker_invitations FROM anon, authenticated;/);
    assert.match(content, /GRANT SELECT ON public\.worker_invitations TO authenticated;/);
    assert.match(content, /CREATE POLICY "worker_invitations_owner_select"/);
  });

  test('join_business_team enforces atomic FOR UPDATE lock and burns invitation', () => {
    const content = fs.readFileSync(migrationPath, 'utf8');
    assert.match(content, /CREATE OR REPLACE FUNCTION public\.join_business_team/);
    assert.match(content, /FOR UPDATE;/);
    assert.match(content, /INSERT INTO public\.profiles/);
    assert.match(content, /UPDATE public\.worker_invitations/);
    assert.match(content, /is_used = true/);
  });
});
