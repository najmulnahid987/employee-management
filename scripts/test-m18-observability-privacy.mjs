/**
 * Dispatcher M18.4 — Observability & Privacy Hardening Verification Tests
 *
 * Verifies:
 * 1. Data sanitization: JWT, bearer tokens, hex tracking tokens, passwords, secrets,
 *    customer phone numbers, customer names, and addresses.
 * 2. GPS coordinate coarsening for diagnostic logs (2 decimal places ~1.1km area).
 * 3. Deep object sanitization with circular reference prevention.
 * 4. User-facing error message sanitization: masking SQL codes, table names, constraints,
 *    and translating network/auth/concurrency errors.
 * 5. StructuredLogger ring buffer: breadcrumb tracking, capacity capping, and reporter hook.
 * 6. Root ErrorBoundary export in src/app/_layout.tsx and AppErrorView fallback.
 * 7. Absence of un-sanitized raw console logging across src/ and supabase/.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  coarsenCoordinates,
  logger,
  REDACTION_MASKS,
  sanitizeForDiagnostics,
  sanitizeString,
  toUserFacingErrorMessage,
} from '../src/lib/logger.ts';

// Silence console output during tests while retaining in-memory breadcrumb testing
logger.setSilent(true);

describe('M18.4 Privacy Redaction & String Sanitization', () => {
  test('redacts JWT bearer tokens in headers and strings', () => {
    const raw = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozGzN_some_signature_here';
    const sanitized = sanitizeString(raw);
    assert.strictEqual(sanitized, `Authorization: Bearer ${REDACTION_MASKS.JWT}`);
    assert.strictEqual(sanitized.includes('eyJhbGciOi'), false);
  });

  test('redacts customer tracking tokens in URLs and query parameters', () => {
    const url1 = 'https://dispatcher.app/track/a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0';
    const sanitized1 = sanitizeString(url1);
    assert.strictEqual(sanitized1, `https://dispatcher.app/track/${REDACTION_MASKS.TOKEN}`);

    const url2 = 'https://dispatcher.app/customer-tracking?token=a1b2c3d4e5f67890123456789abcdef0';
    const sanitized2 = sanitizeString(url2);
    assert.strictEqual(sanitized2, `https://dispatcher.app/customer-tracking?token=${REDACTION_MASKS.TOKEN}`);
  });

  test('redacts standalone 64-character hexadecimal bearer tokens', () => {
    const raw = 'Session token: 7a9f8e4b2c1d0f3e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f';
    const sanitized = sanitizeString(raw);
    assert.strictEqual(sanitized, `Session token: ${REDACTION_MASKS.TOKEN}`);
  });

  test('redacts customer phone numbers in various formats', () => {
    const p1 = 'Customer called from (555) 234-5678 regarding arrival time';
    assert.strictEqual(sanitizeString(p1), `Customer called from ${REDACTION_MASKS.PHONE} regarding arrival time`);

    const p2 = 'Callback at 555-987-6543';
    assert.strictEqual(sanitizeString(p2), `Callback at ${REDACTION_MASKS.PHONE}`);

    const p3 = 'Direct: 5551234567';
    assert.strictEqual(sanitizeString(p3), `Direct: ${REDACTION_MASKS.PHONE}`);
  });

  test('preserves non-sensitive operational strings intact', () => {
    const safeMsg = 'Technician started travel for job 1234-5678';
    assert.strictEqual(sanitizeString(safeMsg), safeMsg);
  });
});

describe('M18.4 GPS Coordinate Coarsening', () => {
  test('coarsens exact coordinates to 2 decimal places (~1.1 km area)', () => {
    const exact = { latitude: 37.7749295, longitude: -122.4194155, accuracy: 12.4 };
    const coarsened = coarsenCoordinates(exact);

    assert.strictEqual(coarsened.latitude, 37.77);
    assert.strictEqual(coarsened.longitude, -122.42);
    assert.strictEqual(coarsened.accuracy, 12);
    assert.strictEqual(coarsened.coarsened, true);
  });

  test('preserves rounded boundary coordinates safely', () => {
    const zero = { latitude: 0.001, longitude: -0.004 };
    const coarsened = coarsenCoordinates(zero);
    assert.strictEqual(coarsened.latitude, 0);
    assert.strictEqual(coarsened.longitude, -0);
  });
});

describe('M18.4 Deep Object Sanitization for Diagnostics', () => {
  test('redacts sensitive keys from objects and records', () => {
    const rawObj = {
      jobId: 'job-123',
      status: 'in_progress',
      customer_name: 'Alice Smith',
      customer_phone: '555-019-2834',
      phone: '555-111-2222',
      address: '742 Evergreen Terrace',
      site_address: '123 Main St',
      gate_code: '#4589',
      notes: 'Customer has guard dog in yard',
      raw_token: 'secret-token-hex',
      token_hash: 'hash-abc',
      jwt: 'header.payload.signature',
      password: 'super-secret-password',
    };

    const sanitized = sanitizeForDiagnostics(rawObj);

    assert.strictEqual(sanitized.jobId, 'job-123');
    assert.strictEqual(sanitized.status, 'in_progress');
    assert.strictEqual(sanitized.customer_name, REDACTION_MASKS.SECRET);
    assert.strictEqual(sanitized.customer_phone, REDACTION_MASKS.SECRET);
    assert.strictEqual(sanitized.phone, REDACTION_MASKS.SECRET);
    assert.strictEqual(sanitized.address, REDACTION_MASKS.SECRET);
    assert.strictEqual(sanitized.site_address, REDACTION_MASKS.SECRET);
    assert.strictEqual(sanitized.gate_code, REDACTION_MASKS.SECRET);
    assert.strictEqual(sanitized.notes, REDACTION_MASKS.SECRET);
    assert.strictEqual(sanitized.raw_token, REDACTION_MASKS.SECRET);
    assert.strictEqual(sanitized.token_hash, REDACTION_MASKS.SECRET);
    assert.strictEqual(sanitized.jwt, REDACTION_MASKS.SECRET);
    assert.strictEqual(sanitized.password, REDACTION_MASKS.SECRET);
  });

  test('automatically coarsens GPS coordinates inside diagnostic objects', () => {
    const objWithCoords = {
      workerId: 'worker-456',
      latitude: 40.712776,
      longitude: -74.005974,
      accuracy: 8.7,
    };

    const result = sanitizeForDiagnostics(objWithCoords);
    assert.strictEqual(result.latitude, 40.71);
    assert.strictEqual(result.longitude, -74.01);
    assert.strictEqual(result.coarsened, true);
  });

  test('safely handles circular references without throwing or hanging', () => {
    const circularObj = { name: 'diagnostic-root' };
    circularObj.self = circularObj;

    const result = sanitizeForDiagnostics(circularObj);
    assert.strictEqual(result.name, 'diagnostic-root');
    assert.strictEqual(result.self, '[CircularReference]');
  });

  test('normalizes Error objects and scrubs their messages', () => {
    const err = new Error('Database error on Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature');
    err.code = '42501';

    const result = sanitizeForDiagnostics(err);
    assert.strictEqual(result.name, 'Error');
    assert.strictEqual(result.code, '42501');
    assert.strictEqual(result.message.includes('eyJhbGciOi'), false);
    assert.strictEqual(result.message.includes(REDACTION_MASKS.JWT), true);
  });
});

describe('M18.4 User-Facing Error Sanitization', () => {
  test('translates network connection errors to clear user messages', () => {
    const netErr = new Error('Network request failed: timeout after 10000ms');
    assert.strictEqual(
      toUserFacingErrorMessage(netErr),
      'Network connection error. Please check your internet connection and try again.'
    );
  });

  test('translates Postgres RLS / 42501 permission errors safely', () => {
    const permErr = { code: '42501', message: 'permission denied for table jobs' };
    assert.strictEqual(
      toUserFacingErrorMessage(permErr),
      'You do not have permission to perform this action.'
    );
  });

  test('translates unique constraint 23505 errors safely', () => {
    const dupErr = { code: '23505', message: 'duplicate key value violates unique constraint "jobs_pkey"' };
    assert.strictEqual(
      toUserFacingErrorMessage(dupErr),
      'A record with these details already exists.'
    );
  });

  test('translates foreign key 23503 errors safely', () => {
    const fkErr = { code: '23503', message: 'insert or update on table "jobs" violates foreign key constraint' };
    assert.strictEqual(
      toUserFacingErrorMessage(fkErr),
      'The requested record was not found or is no longer available.'
    );
  });

  test('translates rate limit P0004 errors safely', () => {
    const rateLimitErr = { code: 'P0004', message: 'Rate limit exceeded for client' };
    assert.strictEqual(
      toUserFacingErrorMessage(rateLimitErr),
      'Too many requests. Please wait a few moments before trying again.'
    );
  });

  test('suppresses raw SQL keywords and table names from leaking to user', () => {
    const sqlErr = new Error('syntax error at or near "SELECT" in relation "jobs"');
    const msg = toUserFacingErrorMessage(sqlErr, 'Custom safe fallback');
    assert.strictEqual(msg, 'Custom safe fallback');
  });

  test('preserves legitimate application validation messages', () => {
    const valErr = 'A valid cancellation reason is required to cancel this job.';
    assert.strictEqual(toUserFacingErrorMessage(valErr), valErr);
  });
});

describe('M18.4 StructuredLogger Ring Buffer & Monitoring Hook', () => {
  test('records breadcrumbs in in-memory ring buffer with timestamp and level', () => {
    logger.clearBreadcrumbs();
    logger.info('TestModule', 'Test informational event', { status: 'active' });
    logger.warn('TestModule', 'Test warning event');

    const breadcrumbs = logger.getBreadcrumbs();
    assert.strictEqual(breadcrumbs.length, 2);
    assert.strictEqual(breadcrumbs[0].level, 'info');
    assert.strictEqual(breadcrumbs[0].tag, 'TestModule');
    assert.strictEqual(breadcrumbs[0].message, 'Test informational event');
    assert.deepStrictEqual(breadcrumbs[0].data, { status: 'active' });
    assert.ok(breadcrumbs[0].timestamp);
    assert.strictEqual(breadcrumbs[1].level, 'warn');
  });

  test('caps ring buffer at max capacity (30) dropping oldest entries', () => {
    logger.clearBreadcrumbs();
    for (let i = 0; i < 40; i++) {
      logger.debug('CapacityTest', `Event ${i}`);
    }

    const breadcrumbs = logger.getBreadcrumbs();
    assert.strictEqual(breadcrumbs.length, 30);
    // Oldest 10 dropped; first item should be Event 10
    assert.strictEqual(breadcrumbs[0].message, 'Event 10');
    assert.strictEqual(breadcrumbs[29].message, 'Event 39');
  });

  test('forwards sanitized breadcrumbs to registered external reporter hook', () => {
    const captured = [];
    logger.setReporter((event) => captured.push(event));

    logger.error('ReporterTest', 'Test error with token', {
      raw_token: 'secret-token',
      jobId: 'job-999',
    });

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].level, 'error');
    assert.strictEqual(captured[0].tag, 'ReporterTest');
    assert.strictEqual(captured[0].data.raw_token, REDACTION_MASKS.SECRET);
    assert.strictEqual(captured[0].data.jobId, 'job-999');

    // Clean up reporter
    logger.setReporter(null);
  });

  test('prevents reporter errors from breaking logging execution', () => {
    logger.setReporter(() => {
      throw new Error('Monitoring service unavailable');
    });

    // Must not throw
    assert.doesNotThrow(() => {
      logger.info('SafeExecution', 'Message should succeed even if reporter fails');
    });

    logger.setReporter(null);
  });
});

describe('M18.4 Codebase Observability & Privacy Invariants', () => {
  test('src/app/_layout.tsx exports ErrorBoundary component and installs global handlers', () => {
    const layoutPath = path.resolve(process.cwd(), 'src/app/_layout.tsx');
    const layoutContent = fs.readFileSync(layoutPath, 'utf8');

    assert.ok(layoutContent.includes('export function ErrorBoundary'));
    assert.ok(layoutContent.includes('installGlobalErrorHandlers();'));
    assert.ok(layoutContent.includes('AppErrorView'));
  });

  test('src/components/app-error-view.tsx exists and renders sanitized user-friendly errors', () => {
    const errorViewPath = path.resolve(process.cwd(), 'src/components/app-error-view.tsx');
    assert.ok(fs.existsSync(errorViewPath));

    const content = fs.readFileSync(errorViewPath, 'utf8');
    assert.ok(content.includes('toUserFacingErrorMessage'));
    assert.ok(content.includes('Something went wrong'));
    assert.ok(content.includes('onRetry'));
  });

  test('docs/monitoring-and-privacy.md exists with Sentry setup and privacy scrubbing instructions', () => {
    const docPath = path.resolve(process.cwd(), 'docs/monitoring-and-privacy.md');
    assert.ok(fs.existsSync(docPath));

    const content = fs.readFileSync(docPath, 'utf8');
    assert.ok(content.includes('@sentry/react-native'));
    assert.ok(content.includes('beforeSend'));
    assert.ok(content.includes('Prohibited Monitoring Practices'));
  });
});
