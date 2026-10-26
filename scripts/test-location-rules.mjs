/**
 * Dispatcher M11.2 — Location Storage & Security Unit Tests
 *
 * Execution: node --test --experimental-strip-types scripts/test-location-rules.mjs
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  APPROVED_TRACKING_STATUSES,
  isTelemetryStale,
  isTrackingEligibleStatus,
  STALE_TELEMETRY_THRESHOLD_MS,
  validateCoordinates,
} from '../src/lib/location-rules.ts';

describe('M11.2 Location Tracking Status Eligibility', () => {
  test('permits tracking strictly during approved active field visit statuses', () => {
    assert.equal(APPROVED_TRACKING_STATUSES.length, 3);
    assert.deepEqual([...APPROVED_TRACKING_STATUSES], ['on_the_way', 'arrived', 'in_progress']);

    assert.equal(isTrackingEligibleStatus('on_the_way'), true);
    assert.equal(isTrackingEligibleStatus('arrived'), true);
    assert.equal(isTrackingEligibleStatus('in_progress'), true);
  });

  test('strictly forbids tracking during pre-travel or unassigned statuses', () => {
    assert.equal(isTrackingEligibleStatus('unassigned'), false);
    assert.equal(isTrackingEligibleStatus('assigned'), false);
    assert.equal(isTrackingEligibleStatus('accepted'), false);
  });

  test('strictly forbids tracking once job reaches terminal status', () => {
    assert.equal(isTrackingEligibleStatus('completed'), false);
    assert.equal(isTrackingEligibleStatus('cancelled'), false);
  });

  test('rejects malformed, unexpected, or empty status strings', () => {
    assert.equal(isTrackingEligibleStatus(''), false);
    assert.equal(isTrackingEligibleStatus(null), false);
    assert.equal(isTrackingEligibleStatus(undefined), false);
    assert.equal(isTrackingEligibleStatus('en_route'), false);
    assert.equal(isTrackingEligibleStatus('travelling'), false);
  });
});

describe('M11.2 Coordinate & Accuracy Validation', () => {
  test('accepts valid coordinates and accuracies', () => {
    assert.equal(validateCoordinates(37.7749, -122.4194, 5.0).valid, true);
    assert.equal(validateCoordinates(0, 0, 0).valid, true);
    assert.equal(validateCoordinates(-90.0, -180.0, null).valid, true);
    assert.equal(validateCoordinates(90.0, 180.0, undefined).valid, true);
  });

  test('rejects latitude out of bounds', () => {
    const tooNorth = validateCoordinates(90.001, 0, 5);
    assert.equal(tooNorth.valid, false);
    assert.match(tooNorth.error, /Latitude must be between -90.0 and 90.0/);

    const tooSouth = validateCoordinates(-90.1, 0, 5);
    assert.equal(tooSouth.valid, false);
  });

  test('rejects longitude out of bounds', () => {
    const tooEast = validateCoordinates(0, 180.001, 5);
    assert.equal(tooEast.valid, false);
    assert.match(tooEast.error, /Longitude must be between -180.0 and 180.0/);

    const tooWest = validateCoordinates(0, -180.001, 5);
    assert.equal(tooWest.valid, false);
  });

  test('rejects NaN or non-number coordinates', () => {
    assert.equal(validateCoordinates(NaN, 0).valid, false);
    assert.equal(validateCoordinates(0, NaN).valid, false);
  });

  test('rejects negative accuracy values', () => {
    const negativeAccuracy = validateCoordinates(37.7749, -122.4194, -1.0);
    assert.equal(negativeAccuracy.valid, false);
    assert.match(negativeAccuracy.error, /Accuracy cannot be negative/);
  });
});

describe('M11.2 Telemetry Freshness & Stale Detection', () => {
  test('marks recent location as fresh (within 5 minutes)', () => {
    const now = Date.now();
    const twoMinutesAgo = new Date(now - 2 * 60 * 1000).toISOString();
    assert.equal(isTelemetryStale(twoMinutesAgo, STALE_TELEMETRY_THRESHOLD_MS, now), false);
  });

  test('marks older location as stale (> 5 minutes)', () => {
    const now = Date.now();
    const sixMinutesAgo = new Date(now - 6 * 60 * 1000).toISOString();
    assert.equal(isTelemetryStale(sixMinutesAgo, STALE_TELEMETRY_THRESHOLD_MS, now), true);
  });

  test('handles null, undefined, or invalid date strings as stale', () => {
    assert.equal(isTelemetryStale(null), true);
    assert.equal(isTelemetryStale(undefined), true);
    assert.equal(isTelemetryStale('not-a-date'), true);
  });
});
