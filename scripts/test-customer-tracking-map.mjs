/**
 * Dispatcher M13.6 — Customer Map and Live Tracking Updates Verification Test Suite
 *
 * Verifies:
 * 1. Web map provider & tile configuration (Leaflet + OpenStreetMap tiles, zero paid routing APIs).
 * 2. Proper attribution: © OpenStreetMap contributors.
 * 3. Real coordinate rendering: latest worker coordinates, no fabricated positions or fake routes.
 * 4. Conditional destination marker: rendered ONLY when destination coordinates exist.
 * 5. Accuracy uncertainty handling: visual radius circle and poor accuracy warning (> 100m).
 * 6. Stale and missing position handling: stops presenting as live, switches to amber delayed state.
 * 7. Status transitions: on arrival / in_progress, displays actual on-site status (never claims approaching).
 * 8. Moderate polling interval (20-30s) while visible.
 * 9. Tab visibility lifecycle: pauses when hidden, refreshes promptly when visible.
 * 10. Concurrency & race condition protection: out-of-order and older responses cannot overwrite newer data.
 * 11. Terminal & expired cutoff: stops polling on completion, cancellation, or revocation.
 * 12. Strict absence of forbidden fields (zero customer phone, notes, internal IDs, raw tokens).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// =============================================================================
// Test Suite 1: Web Map Provider, OpenStreetMap Tiles, and Attribution
// =============================================================================

test('M13.6 Web Map Provider, Tiles & Attribution', async (t) => {
  const mapComponentPath = path.join(
    projectRoot,
    'src/components/tracking/customer-tracking-map.tsx'
  );
  assert.ok(fs.existsSync(mapComponentPath), 'customer-tracking-map.tsx must exist');
  const content = fs.readFileSync(mapComponentPath, 'utf8');

  await t.test('uses OpenStreetMap tile layer without paid API keys', () => {
    assert.match(
      content,
      /https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/,
      'Map must use OpenStreetMap tile layer'
    );
    assert.equal(
      content.includes('maps.googleapis.com') || content.includes('api.mapbox.com'),
      false,
      'Map must NOT use Google Maps or Mapbox paid APIs'
    );
  });

  await t.test('displays mandatory OpenStreetMap copyright attribution', () => {
    assert.match(
      content,
      /OpenStreetMap/,
      'Map must include OpenStreetMap attribution'
    );
    assert.match(
      content,
      /openstreetmap\.org\/copyright/,
      'Map must link to OpenStreetMap copyright policy'
    );
  });

  await t.test('strictly excludes Google Routes API and straight-line ETA calculation', () => {
    assert.equal(
      content.includes('Routes') || content.includes('DirectionsService') || content.includes('DistanceMatrix'),
      false,
      'Must never invoke Google Routes or Directions APIs'
    );
    assert.equal(
      content.includes('haversine') || content.includes('Math.atan2'),
      false,
      'Must not calculate fake straight-line ETAs'
    );
  });
});

// =============================================================================
// Test Suite 2: Real Coordinate Rendering & Conditional Destination
// =============================================================================

test('M13.6 Coordinate Accuracy, Markers & Destination Logic', async (t) => {
  const mapComponentPath = path.join(
    projectRoot,
    'src/components/tracking/customer-tracking-map.tsx'
  );
  const content = fs.readFileSync(mapComponentPath, 'utf8');

  await t.test('renders destination marker ONLY if coordinates are present in endpoint payload', () => {
    // Verifies destination condition check
    assert.match(
      content,
      /typeof destination\.latitude === 'number' &&\s*typeof destination\.longitude === 'number'/,
      'Destination marker must strictly check valid coordinate numbers before rendering'
    );
    // Verifies removal when null
    assert.match(
      content,
      /map\.removeLayer\(destMarker\)/,
      'Destination marker must be removed from map if destination coordinates become null'
    );
  });

  await t.test('renders worker marker and smooth in-place telemetry update via postMessage', () => {
    assert.match(
      content,
      /workerMarker\.setLatLng\(workerLatLng\)/,
      'Map must update marker position in-place without full page reloads'
    );
    assert.match(
      content,
      /UPDATE_TELEMETRY/,
      'Map must listen for telemetry update postMessage from parent view'
    );
  });

  await t.test('renders accuracy uncertainty radius circle and poor accuracy warning (> 100m)', () => {
    // Leaflet circle for GPS uncertainty
    assert.match(
      content,
      /L\.circle\(workerLatLng,\s*\{\s*radius:\s*workerLocation\.accuracy/,
      'Map must render accuracy circle when GPS accuracy radius is available'
    );

    // Warning pill when accuracy > 100m
    assert.match(
      content,
      /accuracy > 100/,
      'Must detect poor accuracy (> 100m) and display approximate position warning'
    );
    assert.match(
      content,
      /Position approximate|accuracy: &plusmn;/,
      'Must explain to customer that position is approximate'
    );
  });

  await t.test('handles stale and missing positions: stops presenting as live', () => {
    assert.match(
      content,
      /pinClass \+= ' stale'/,
      'Worker pin must switch to stale styling when location is delayed'
    );
    assert.match(
      content,
      /staleOverlayBadge|Location delayed/,
      'Must render notice indicating location is delayed and not live'
    );
    assert.match(
      content,
      /waitingOverlay|Connecting to Technician GPS/,
      'Must render waiting notice when worker coordinates are not yet reported'
    );
  });

  await t.test('updates marker on arrival and in_progress: does not claim worker is approaching', () => {
    assert.match(
      content,
      /status === 'arrived'/,
      'Must detect arrived status'
    );
    assert.match(
      content,
      /Technician has arrived on-site/,
      'Must display on-site status when arrived'
    );
    assert.match(
      content,
      /status === 'in_progress'/,
      'Must detect in_progress status'
    );
    assert.match(
      content,
      /Work in progress/,
      'Must display work in progress status when active'
    );
  });
});

// =============================================================================
// Test Suite 3: Polling Interval, Concurrency & Race Condition Protection
// =============================================================================

test('M13.6 Polling Interval, Tab Visibility & Concurrency Controls', async (t) => {
  const viewComponentPath = path.join(
    projectRoot,
    'src/components/tracking/customer-tracking-view.tsx'
  );
  assert.ok(fs.existsSync(viewComponentPath), 'customer-tracking-view.tsx must exist');
  const content = fs.readFileSync(viewComponentPath, 'utf8');

  await t.test('defaults to moderate polling interval between 20 and 30 seconds', () => {
    assert.match(
      content,
      /pollIntervalMs = 20000|pollIntervalMs = 25000|pollIntervalMs = 30000/,
      'Poll interval must default to 20-30 seconds'
    );
  });

  await t.test('pauses polling when tab is hidden and refreshes promptly when visible', () => {
    // Visibilitychange listener
    assert.match(
      content,
      /document\.addEventListener\(['"]visibilitychange['"]/,
      'Must attach visibilitychange event listener'
    );
    // Pause when hidden
    assert.match(
      content,
      /if \(document\.hidden\)/,
      'Must check document.hidden state'
    );
    // Immediate refresh on return
    assert.match(
      content,
      /loadTrackingData\(false\)/,
      'Must immediately trigger fresh data load when tab becomes visible'
    );
  });

  await t.test('protects against race conditions and out-of-order async responses', () => {
    // Incrementing token
    assert.match(
      content,
      /\+\+activeRequestTokenRef\.current/,
      'Must use incrementing request token ref to track in-flight requests'
    );
    // Stale async response check
    assert.match(
      content,
      /currentRequestToken !== activeRequestTokenRef\.current/,
      'Must discard responses if a newer request was dispatched while in-flight'
    );
  });

  await t.test('chronological timestamp protection prevents older server states from overwriting newer data', () => {
    assert.match(
      content,
      /serverTime < latestServerTimestampRef\.current/,
      'Must reject server responses with older timestamps than currently rendered state'
    );
  });

  await t.test('stops polling on terminal statuses (completed, cancelled) and expired sessions', () => {
    assert.match(
      content,
      /status === 'completed' \|\| payload\.status === 'cancelled'/,
      'Must check for terminal statuses'
    );
    assert.match(
      content,
      /if \(isTerminalStatus\)\s*\{\s*return;\s*\}/,
      'Must halt polling permanently when job enters terminal status'
    );
    assert.match(
      content,
      /if \(isLoading \|\| isNetworkError \|\| isExpiredOrInvalid \|\| !payload\)\s*\{\s*return;\s*\}/,
      'Must halt polling when session is expired, invalid, or in error'
    );
  });
});

// =============================================================================
// Test Suite 4: Strict Absence of Forbidden Fields
// =============================================================================

test('M13.6 Absence of Forbidden Fields in Map Components', () => {
  const mapComponentPath = path.join(
    projectRoot,
    'src/components/tracking/customer-tracking-map.tsx'
  );
  const viewComponentPath = path.join(
    projectRoot,
    'src/components/tracking/customer-tracking-view.tsx'
  );

  const mapContent = fs.readFileSync(mapComponentPath, 'utf8');
  const viewContent = fs.readFileSync(viewComponentPath, 'utf8');

  const forbiddenFields = [
    'customer_phone',
    'customer_name',
    'internal_notes',
    'notes',
    'cancellation_reason',
    'worker_id',
    'business_id',
    'job_id',
    'session_id',
    'raw_token',
    'token_hash',
    'worker_full_name',
    'worker_phone',
    'worker_email',
  ];

  for (const field of forbiddenFields) {
    assert.equal(
      new RegExp(`payload\\.${field}`, 'g').test(mapContent),
      false,
      `customer-tracking-map.tsx must never access payload.${field}`
    );
    assert.equal(
      new RegExp(`payload\\.${field}`, 'g').test(viewContent),
      false,
      `customer-tracking-view.tsx must never access payload.${field}`
    );
  }

  // Verify CSP includes OpenStreetMap tiles and unpkg
  assert.match(
    viewContent,
    /tile\.openstreetmap\.org/,
    'CSP in customer-tracking-view must permit OpenStreetMap tiles'
  );
  assert.match(
    viewContent,
    /unpkg\.com/,
    'CSP in customer-tracking-view must permit unpkg.com for Leaflet'
  );
});
