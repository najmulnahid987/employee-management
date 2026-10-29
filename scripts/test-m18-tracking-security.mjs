/**
 * Dispatcher M18.2C — Tracking Token and Secret Security Verification Tests
 *
 * Verifies:
 * 1. Migration 20261103030000_tracking_token_and_secret_security.sql.
 * 2. CSPRNG 256-bit token entropy via gen_random_bytes(32) hex encoding.
 * 3. Token hashing & anti-enumeration guarantees (SHA-256 hash storage).
 * 4. Token lifecycle constraints (unassigned, terminal, reassignment, superseding).
 * 5. Allowlisted customer tracking fields (strict exclusion of customer PII, worker contact, internal notes).
 * 6. Secret exposure hygiene: absence of service-role keys and database credentials in client code.
 * 7. Environment configuration & .gitignore rules.
 * 8. pgTAP test suite 15 structure and assertions.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  FORBIDDEN_RESPONSE_FIELDS,
  sanitizeCustomerTrackingPayload,
} from '../supabase/functions/customer-tracking/core.ts';

describe('M18.2C Migration & Token Security SQL Invariants', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261103030000_tracking_token_and_secret_security.sql'
  );

  test('migration file exists and follows chronological timestamp convention', () => {
    assert.ok(fs.existsSync(migrationPath), 'Migration 20261103030000 must exist');
  });

  const sqlContent = fs.readFileSync(migrationPath, 'utf8');

  test('generate_customer_tracking_session uses gen_random_bytes(32) for 256-bit CSPRNG entropy', () => {
    assert.ok(
      sqlContent.includes("pg_catalog.encode(pg_catalog.gen_random_bytes(32), 'hex')"),
      'Generates 32 random bytes encoded as hex (256 bits CSPRNG entropy)'
    );
  });

  test('generate_customer_tracking_session stores SHA-256 hash and never raw token', () => {
    assert.ok(
      sqlContent.includes("pg_catalog.encode(\n        pg_catalog.sha256(pg_catalog.convert_to(v_raw_token, 'UTF8')),\n        'hex'\n    )") ||
      sqlContent.includes("sha256(pg_catalog.convert_to(v_raw_token, 'UTF8'))"),
      'Computes SHA-256 hash of raw token before insert'
    );
    assert.ok(
      sqlContent.includes("token_hash,\n        created_at"),
      'Inserts token_hash into customer_tracking_sessions table'
    );
  });

  test('generate_customer_tracking_session enforces strict owner authorization and job tenancy', () => {
    assert.ok(
      sqlContent.includes("IF NOT app_auth.is_business_owner() THEN"),
      'Requires caller to be business owner'
    );
    assert.ok(
      sqlContent.includes("WHERE id = p_job_id\n      AND business_id = v_business_id;"),
      'Requires job to belong to owner business'
    );
  });

  test('generate_customer_tracking_session rejects unassigned and terminal jobs', () => {
    assert.ok(
      sqlContent.includes("Cannot create tracking link for unassigned job"),
      'Rejects unassigned jobs'
    );
    assert.ok(
      sqlContent.includes("Cannot create tracking link for job in terminal status"),
      'Rejects terminal jobs (completed / cancelled)'
    );
  });

  test('generate_customer_tracking_session enforces duration bounds (1..72 hours)', () => {
    assert.ok(
      sqlContent.includes("Tracking session duration must be between 1 and 72 hours."),
      'Enforces duration bounds (1..72)'
    );
  });

  test('get_customer_tracking_session_job validates token hex format and length bounds (16..128)', () => {
    assert.ok(
      sqlContent.includes("length(v_clean_token) < 16 OR pg_catalog.length(v_clean_token) > 128"),
      'Enforces token length bounds (16..128)'
    );
    assert.ok(
      sqlContent.includes("v_clean_token !~* '^[0-9a-f]{16,128}$'"),
      'Enforces strict hexadecimal token format'
    );
  });

  test('get_customer_tracking_session_job verifies worker active state', () => {
    assert.ok(
      sqlContent.includes("IF v_worker.is_active IS FALSE THEN\n            RETURN NULL;"),
      'Returns NULL if assigned worker account is deactivated'
    );
  });
});

describe('M18.2C Allowlist Projection & PII Masking', () => {
  test('strictly excludes forbidden PII and database IDs from tracking payloads', () => {
    const rawDatabasePayload = {
      service: 'HVAC Maintenance',
      status: 'on_the_way',
      status_label: 'Technician is on the way',
      scheduled_at: '2026-11-03T10:00:00Z',
      business_name: 'Delta Services',
      business_phone: '555-0100',
      worker_first_name: 'Alex',
      worker_avatar_url: 'https://example.com/avatar.jpg',
      destination: { latitude: 37.7749, longitude: -122.4194 },
      worker_location: {
        latitude: 37.7833,
        longitude: -122.4167,
        accuracy: 10,
        recorded_at: '2026-11-03T09:45:00Z',
      },
      is_tracking_active: true,
      activated_at: '2026-11-03T09:30:00Z',
      tracking_message: 'Technician is on the way.',
      last_location_updated_at: '2026-11-03T09:45:00Z',
      estimated_arrival: null,
      session_expires_at: '2026-11-04T09:30:00Z',
      updated_at: '2026-11-03T09:45:00Z',
      // Intentionally injected forbidden fields
      id: 'job-12345',
      job_id: 'job-12345',
      business_id: 'biz-999',
      worker_id: 'worker-888',
      session_id: 'sess-777',
      token: 'raw-token-value',
      raw_token: 'raw-token-value',
      token_hash: 'hash-abc',
      customer_name: 'Alice Customer',
      customer_phone: '555-9999',
      notes: 'Customer gate code: 1234. Dog in backyard.',
      cancellation_reason: 'Client requested reschedule',
      worker_full_name: 'Alex Smith',
      worker_phone: '555-4321',
      worker_email: 'alex@company.com',
      address: '123 Private Residential Lane',
    };

    const sanitized = sanitizeCustomerTrackingPayload(rawDatabasePayload);

    for (const forbiddenKey of FORBIDDEN_RESPONSE_FIELDS) {
      assert.equal(
        sanitized[forbiddenKey],
        undefined,
        `Sanitized payload must NEVER include "${forbiddenKey}"`
      );
    }

    assert.equal(sanitized.business_name, 'Delta Services');
    assert.equal(sanitized.worker_first_name, 'Alex');
    assert.equal(sanitized.is_tracking_active, true);
  });
});

describe('M18.2C Secret Hygiene & Repository Configuration', () => {
  test('.gitignore covers local environment files and native secrets', () => {
    const gitignorePath = path.resolve(process.cwd(), '.gitignore');
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');

    assert.ok(gitignoreContent.includes('.env'), '.gitignore must exclude .env');
    assert.ok(gitignoreContent.includes('.env.*'), '.gitignore must exclude .env.* wildcard');
    assert.ok(gitignoreContent.includes('!.env.example'), '.gitignore must preserve .env.example template');
    assert.ok(gitignoreContent.includes('node_modules/'), '.gitignore must exclude node_modules');
    assert.ok(gitignoreContent.includes('.expo/'), '.gitignore must exclude .expo');
  });

  test('.env.example contains only non-sensitive placeholder values', () => {
    const envExamplePath = path.resolve(process.cwd(), '.env.example');
    const envExampleContent = fs.readFileSync(envExamplePath, 'utf8');

    assert.equal(
      envExampleContent.includes('eyJh'), // Common JWT header prefix
      false,
      '.env.example must not contain real JWT tokens'
    );
    assert.equal(
      envExampleContent.includes('service_role'),
      false,
      '.env.example must not contain service_role credentials'
    );
    assert.equal(
      envExampleContent.includes('postgres://'),
      false,
      '.env.example must not contain database connection strings'
    );
    assert.ok(
      envExampleContent.includes('your-project-id.supabase.co'),
      '.env.example must use generic template placeholders'
    );
  });

  test('client application code in src/ contains zero service-role keys', () => {
    function scanDirectory(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDirectory(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          const content = fs.readFileSync(fullPath, 'utf8');
          assert.equal(
            content.includes('SUPABASE_SERVICE_ROLE_KEY'),
            false,
            `Client file "${fullPath}" must NEVER reference SUPABASE_SERVICE_ROLE_KEY`
          );
        }
      }
    }

    scanDirectory(path.resolve(process.cwd(), 'src'));
  });
});

describe('pgTAP Database Verification Suite 15', () => {
  const pgtapPath = path.resolve(
    process.cwd(),
    'supabase/tests/15_tracking_token_and_secret_security.sql'
  );

  test('pgTAP test suite 15 exists and contains 10 planned test assertions', () => {
    assert.ok(fs.existsSync(pgtapPath), '15_tracking_token_and_secret_security.sql must exist');
    const content = fs.readFileSync(pgtapPath, 'utf8');
    assert.ok(content.includes('SELECT plan(10);'), 'Plans 10 assertions');
    assert.ok(content.includes('generate_customer_tracking_session outputs 64-character hex token'), 'Test 1 assertion');
    assert.ok(content.includes('generate_customer_tracking_session rejects unassigned job'), 'Test 2 assertion');
    assert.ok(content.includes('generate_customer_tracking_session rejects completed job'), 'Test 3 assertion');
    assert.ok(content.includes('generate_customer_tracking_session rejects duration > 72 hours'), 'Test 4 assertion');
    assert.ok(content.includes('Second generation revokes previous session with reason superseded'), 'Test 5 assertion');
    assert.ok(content.includes('get_customer_tracking_session_job returns NULL for non-hex token'), 'Test 6 assertion');
    assert.ok(content.includes('get_customer_tracking_session_job returns NULL for random non-existent token'), 'Test 7 assertion');
    assert.ok(content.includes('Anonymous customer query returns public allowlisted business_name'), 'Test 8 assertion');
    assert.ok(content.includes('Customer tracking payload strictly withholds customer PII'), 'Test 9 assertion');
    assert.ok(content.includes('get_customer_tracking_session_job immediately returns NULL once job is completed'), 'Test 10 assertion');
  });
});
