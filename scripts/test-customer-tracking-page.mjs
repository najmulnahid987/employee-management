/**
 * Dispatcher M13.5 — Customer Tracking Web Page Verification Test Suite
 *
 * Verifies:
 * 1. Web route architecture (Expo Router Stack, public exemption, no forced redirect).
 * 2. Fragment and body token handling (zero tokens in HTTP URLs, POST body submission).
 * 3. Security controls (no-referrer, noindex, no-store cache, restrictive CSP).
 * 4. Strict exclusion of forbidden fields (zero customer phone, notes, internal IDs, raw tokens, etc.).
 * 5. UI state rendering & accessible messaging for all 6 core states:
 *    - Initial loading
 *    - Valid active tracking
 *    - Location temporarily unavailable
 *    - Last update is stale
 *    - Tracking expired, revoked, or ended (generic anti-enumeration)
 *    - Network error with retry
 * 6. No invented ETA or travel duration estimation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Import pure tracking token extraction helper
const { extractTrackingToken } = await import('../src/lib/tracking-token.ts');

const SAMPLE_HEX_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

// =============================================================================
// Test Suite 1: Web Route Architecture & Layout Exemption
// =============================================================================

test('M13.5 Web Route Architecture & Layout Exemption', async (t) => {
  await t.test('Root layout exempts /track from authentication redirect', () => {
    const rootLayoutPath = path.join(projectRoot, 'src/app/_layout.tsx');
    assert.ok(fs.existsSync(rootLayoutPath), 'src/app/_layout.tsx must exist');
    const content = fs.readFileSync(rootLayoutPath, 'utf8');

    // Must check rootSegment === 'track' before session redirect
    assert.match(
      content,
      /rootSegment\s*===\s*['"]track['"]/,
      'Root layout must explicitly exempt rootSegment === "track" from authentication redirect'
    );

    // Must register <Stack.Screen name="track"
    assert.match(
      content,
      /<Stack\.Screen\s+name=["']track["']/,
      'Root layout must register track screen in the Expo Router Stack'
    );
  });

  await t.test('/track layout and route endpoints exist and wrap CustomerTrackingView', () => {
    const trackLayoutPath = path.join(projectRoot, 'src/app/track/_layout.tsx');
    const trackIndexPath = path.join(projectRoot, 'src/app/track/index.tsx');
    const trackTokenPath = path.join(projectRoot, 'src/app/track/[token].tsx');

    assert.ok(fs.existsSync(trackLayoutPath), 'src/app/track/_layout.tsx must exist');
    assert.ok(fs.existsSync(trackIndexPath), 'src/app/track/index.tsx must exist');
    assert.ok(fs.existsSync(trackTokenPath), 'src/app/track/[token].tsx must exist');

    const indexContent = fs.readFileSync(trackIndexPath, 'utf8');
    assert.match(
      indexContent,
      /CustomerTrackingView/,
      'src/app/track/index.tsx must render CustomerTrackingView'
    );

    const tokenContent = fs.readFileSync(trackTokenPath, 'utf8');
    assert.match(
      tokenContent,
      /CustomerTrackingView/,
      'src/app/track/[token].tsx must render CustomerTrackingView'
    );
  });
});

// =============================================================================
// Test Suite 2: Fragment, Path, and Query Token Extraction
// =============================================================================

test('M13.5 Token Extraction Mechanisms', async (t) => {
  await t.test('extracts raw token from URL fragment hash (#<token>)', () => {
    // Simulate window.location.hash in Node test environment
    const previousWindow = globalThis.window;
    globalThis.window = {
      location: {
        hash: `#${SAMPLE_HEX_TOKEN}`,
        search: '',
      },
    };

    try {
      const extracted = extractTrackingToken();
      assert.equal(extracted, SAMPLE_HEX_TOKEN);
    } finally {
      globalThis.window = previousWindow;
    }
  });

  await t.test('extracts key-value token from URL fragment hash (#token=<token>)', () => {
    const previousWindow = globalThis.window;
    globalThis.window = {
      location: {
        hash: `#token=${SAMPLE_HEX_TOKEN}`,
        search: '',
      },
    };

    try {
      const extracted = extractTrackingToken();
      assert.equal(extracted, SAMPLE_HEX_TOKEN);
    } finally {
      globalThis.window = previousWindow;
    }
  });

  await t.test('extracts token from path parameter ([token])', () => {
    const extracted = extractTrackingToken({ pathToken: SAMPLE_HEX_TOKEN });
    assert.equal(extracted, SAMPLE_HEX_TOKEN);
  });

  await t.test('extracts token from query search parameter (?token=...)', () => {
    const extracted = extractTrackingToken({ searchParamToken: SAMPLE_HEX_TOKEN });
    assert.equal(extracted, SAMPLE_HEX_TOKEN);
  });

  await t.test('returns null when no token is present or token is malformed', () => {
    const previousWindow = globalThis.window;
    globalThis.window = {
      location: {
        hash: '',
        search: '',
      },
    };

    try {
      assert.equal(extractTrackingToken(), null);
      assert.equal(extractTrackingToken({ pathToken: 'too-short' }), null);
      assert.equal(extractTrackingToken({ searchParamToken: 'invalid@character!' }), null);
    } finally {
      globalThis.window = previousWindow;
    }
  });
});

// =============================================================================
// Test Suite 3: Client Security & POST Body Transmission
// =============================================================================

test('M13.5 Client Security & POST Body Transmission', async (t) => {
  await t.test('verifies fetchCustomerTrackingViaApi enforces POST body and no URL token', () => {
    const serviceFilePath = path.join(
      projectRoot,
      'src/lib/tracking-session-service.ts'
    );
    const content = fs.readFileSync(serviceFilePath, 'utf8');

    // Must use method: 'POST'
    assert.match(
      content,
      /method:\s*['"]POST['"]/,
      'fetchCustomerTrackingViaApi must use method: "POST"'
    );

    // Must submit token via JSON body
    assert.match(
      content,
      /body:\s*JSON\.stringify\(\{\s*token:\s*trimmed\s*\}\)/,
      'fetchCustomerTrackingViaApi must submit token in JSON body'
    );

    // Must NOT append token to query string in endpoint URL
    assert.equal(
      content.includes('url.searchParams.set(\'token\''),
      false,
      'fetchCustomerTrackingViaApi must never append token to searchParams'
    );
  });

  await t.test('verifies network error detection logic in service', () => {
    const serviceFilePath = path.join(
      projectRoot,
      'src/lib/tracking-session-service.ts'
    );
    const content = fs.readFileSync(serviceFilePath, 'utf8');

    assert.match(
      content,
      /isNetworkError:\s*isNetwork/,
      'Service must flag isNetworkError so the UI can render retry states'
    );
  });
});

// =============================================================================
// Test Suite 4: Strict Exclusion of Forbidden Fields & ETA
// =============================================================================

test('M13.5 Absence of Forbidden Fields & No Invented ETA', () => {
  const componentPath = path.join(
    projectRoot,
    'src/components/tracking/customer-tracking-view.tsx'
  );
  assert.ok(fs.existsSync(componentPath), 'customer-tracking-view.tsx must exist');
  const fileContent = fs.readFileSync(componentPath, 'utf8');

  const forbiddenIdentifiers = [
    'customer_phone',
    'customer_name',
    'internal_notes',
    'cancellation_reason',
    'worker_id',
    'business_id',
    'job_id',
    'session_id',
    'token_hash',
    'raw_token',
    'worker_full_name',
    'worker_phone',
    'worker_email',
  ];

  for (const field of forbiddenIdentifiers) {
    // Ensure the component never renders or attempts to bind these forbidden fields in UI
    const pattern = new RegExp(`payload\\.${field}`, 'g');
    assert.equal(
      pattern.test(fileContent),
      false,
      `customer-tracking-view.tsx must never access or display payload.${field}`
    );
  }

  // Ensure no straight-line distance calculations (e.g. Haversine distance, speed, ETA invention)
  assert.equal(
    fileContent.includes('haversine') || fileContent.includes('Math.atan2'),
    false,
    'Component must never calculate straight-line distance or invent estimated arrival durations'
  );

  // Ensure no service-role keys in public tracking view
  assert.equal(
    fileContent.includes('SUPABASE_SERVICE_ROLE_KEY'),
    false,
    'Service-role key must NEVER exist in client tracking code'
  );
});

// =============================================================================
// Test Suite 5: Security Meta Tags & Headers Enforcement
// =============================================================================

test('M13.5 Security Meta Tags & Headers Configuration', () => {
  const componentPath = path.join(
    projectRoot,
    'src/components/tracking/customer-tracking-view.tsx'
  );
  const content = fs.readFileSync(componentPath, 'utf8');

  // Verify Referrer-Policy: no-referrer
  assert.match(
    content,
    /no-referrer/,
    'Must enforce Referrer-Policy: no-referrer'
  );

  // Verify noindex, nofollow, noarchive
  assert.match(
    content,
    /noindex,\s*nofollow,\s*noarchive/,
    'Must enforce robots: noindex, nofollow, noarchive'
  );

  // Verify Cache-Control: no-store
  assert.match(
    content,
    /no-store,\s*no-cache,\s*must-revalidate/,
    'Must enforce Cache-Control: no-store'
  );

  // Verify Content Security Policy
  assert.match(
    content,
    /Content-Security-Policy/,
    'Must set restrictive Content Security Policy'
  );
});

// =============================================================================
// Test Suite 6: All 6 UI States Verification
// =============================================================================

test('M13.5 UI States Coverage in CustomerTrackingView', () => {
  const componentPath = path.join(
    projectRoot,
    'src/components/tracking/customer-tracking-view.tsx'
  );
  const content = fs.readFileSync(componentPath, 'utf8');

  // 1. Initial loading state
  assert.match(content, /uiState\s*===\s*['"]loading['"]/, 'Must implement Initial Loading state');
  assert.match(content, /Connecting to Live Tracking/);

  // 2. Valid active tracking state
  assert.match(content, /uiState\s*===\s*['"]active['"]|Live Service Map/, 'Must implement Valid Active Tracking state');
  assert.match(content, /GPS Active/);

  // 3. Location temporarily unavailable state
  assert.match(content, /location_unavailable/, 'Must implement Location Temporarily Unavailable state');
  assert.match(content, /GPS Telemetry Pending/);

  // 4. Stale location state (> 5-10 mins)
  assert.match(content, /uiState\s*===\s*['"]stale['"]/, 'Must implement Stale Location state');
  assert.match(content, /Location Update Delayed/);

  // 5. Expired / Revoked / Ended state (Generic anti-enumeration message)
  assert.match(content, /uiState\s*===\s*['"]expired['"]/, 'Must implement Expired/Revoked/Ended state');
  assert.match(content, /Tracking Unavailable/);
  assert.match(content, /This tracking link is unavailable, expired, or the service visit has ended\./);

  // 6. Network error with retry
  assert.match(content, /uiState\s*===\s*['"]network_error['"]/, 'Must implement Network Error state');
  assert.match(content, /Connection Error/);
  assert.match(content, /Try Again/);
});
