/**
 * Dispatcher M11.6 — Owner Live Worker Locations Unit Tests
 *
 * Execution: node --test --experimental-strip-types scripts/test-owner-locations.mjs
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  calculateTerritorySummary,
  formatDistance,
  formatTimeAgo,
  processRawOwnerActiveLocation,
} from '../src/lib/owner-locations-core.ts';

describe('M11.6 Owner Active Location Row Processing', () => {
  const nowMs = 1700000000000;

  const validRow = {
    location_id: 'loc-1111',
    worker_id: 'worker-2222',
    worker_name: 'John Technician',
    worker_avatar_url: null,
    job_id: 'job-3333',
    job_service: 'Emergency Pipe Repair',
    job_address: '123 Market St, San Francisco, CA',
    job_status: 'on_the_way',
    // Worker is ~1.1 km north of destination (0.01 deg lat difference)
    destination_latitude: 37.7749,
    destination_longitude: -122.4194,
    worker_latitude: 37.7849,
    worker_longitude: -122.4194,
    accuracy: 15.0,
    recorded_at: new Date(nowMs - 30000).toISOString(), // 30s ago
  };

  test('processes valid active location row and calculates distance', () => {
    const processed = processRawOwnerActiveLocation(validRow, nowMs);
    assert.ok(processed !== null);
    assert.equal(processed.workerName, 'John Technician');
    assert.equal(processed.jobService, 'Emergency Pipe Repair');
    assert.equal(processed.jobStatus, 'on_the_way');
    assert.equal(processed.isStale, false);
    assert.equal(processed.isInaccurate, false);
    assert.ok(processed.distanceToDestinationMeters > 1000 && processed.distanceToDestinationMeters < 1200);
    assert.match(processed.freshnessLabel, /updated 30s ago/i);
  });

  test('marks position as stale if older than 5 minutes', () => {
    const staleRow = {
      ...validRow,
      recorded_at: new Date(nowMs - 360000).toISOString(), // 6 minutes ago
    };
    const processed = processRawOwnerActiveLocation(staleRow, nowMs);
    assert.ok(processed !== null);
    assert.equal(processed.isStale, true);
    assert.match(processed.freshnessLabel, /stale/i);
  });

  test('marks position as inaccurate if accuracy exceeds 200m threshold', () => {
    const inaccurateRow = {
      ...validRow,
      accuracy: 250.0,
    };
    const processed = processRawOwnerActiveLocation(inaccurateRow, nowMs);
    assert.ok(processed !== null);
    assert.equal(processed.isInaccurate, true);
    assert.match(processed.freshnessLabel, /low accuracy/i);
  });

  test('returns null if worker coordinates are invalid or out of bounds', () => {
    const invalidCoords = {
      ...validRow,
      worker_latitude: 95.0, // invalid latitude > 90
    };
    const processed = processRawOwnerActiveLocation(invalidCoords, nowMs);
    assert.equal(processed, null);
  });

  test('handles null destination coordinates gracefully', () => {
    const noDestRow = {
      ...validRow,
      destination_latitude: null,
      destination_longitude: null,
    };
    const processed = processRawOwnerActiveLocation(noDestRow, nowMs);
    assert.ok(processed !== null);
    assert.equal(processed.distanceToDestinationMeters, null);
  });
});

describe('M11.6 Distance & Time Formatting', () => {
  test('formats short distance in meters', () => {
    assert.equal(formatDistance(450), '450 m away');
    assert.equal(formatDistance(32.7), '33 m away');
  });

  test('formats long distance in kilometers', () => {
    assert.equal(formatDistance(1200), '1.2 km away');
    assert.equal(formatDistance(15600), '15.6 km away');
  });

  test('handles null distance', () => {
    assert.equal(formatDistance(null), 'Distance unavailable');
  });

  test('formats time ago accurately', () => {
    const now = 1000000;
    assert.equal(formatTimeAgo(new Date(now - 5000).toISOString(), now), 'Just now');
    assert.equal(formatTimeAgo(new Date(now - 45000).toISOString(), now), '45s ago');
    assert.equal(formatTimeAgo(new Date(now - 180000).toISOString(), now), '3m ago');
    assert.equal(formatTimeAgo(new Date(now - 7200000).toISOString(), now), '2h ago');
  });
});

describe('M11.6 Territory Summary Counts', () => {
  test('counts en-route, on-site, and stale workers correctly', () => {
    const locations = [
      {
        locationId: '1',
        workerId: 'w1',
        workerName: 'Alice',
        workerAvatarUrl: null,
        jobId: 'j1',
        jobService: 'HVAC',
        jobAddress: 'Addr 1',
        jobStatus: 'on_the_way',
        destinationLatitude: null,
        destinationLongitude: null,
        workerLatitude: 37.77,
        workerLongitude: -122.41,
        accuracy: 10,
        recordedAt: '2026-10-25T10:00:00Z',
        distanceToDestinationMeters: null,
        isStale: false,
        isInaccurate: false,
        freshnessLabel: 'Live',
      },
      {
        locationId: '2',
        workerId: 'w2',
        workerName: 'Bob',
        workerAvatarUrl: null,
        jobId: 'j2',
        jobService: 'Plumbing',
        jobAddress: 'Addr 2',
        jobStatus: 'arrived',
        destinationLatitude: null,
        destinationLongitude: null,
        workerLatitude: 37.78,
        workerLongitude: -122.42,
        accuracy: 15,
        recordedAt: '2026-10-25T10:00:00Z',
        distanceToDestinationMeters: null,
        isStale: true,
        isInaccurate: false,
        freshnessLabel: 'Stale',
      },
      {
        locationId: '3',
        workerId: 'w3',
        workerName: 'Charlie',
        workerAvatarUrl: null,
        jobId: 'j3',
        jobService: 'Electrical',
        jobAddress: 'Addr 3',
        jobStatus: 'in_progress',
        destinationLatitude: null,
        destinationLongitude: null,
        workerLatitude: 37.79,
        workerLongitude: -122.43,
        accuracy: 20,
        recordedAt: '2026-10-25T10:00:00Z',
        distanceToDestinationMeters: null,
        isStale: false,
        isInaccurate: false,
        freshnessLabel: 'Live',
      },
    ];

    const summary = calculateTerritorySummary(locations);
    assert.equal(summary.totalActive, 3);
    assert.equal(summary.enRouteCount, 1);
    assert.equal(summary.onSiteCount, 2);
    assert.equal(summary.staleCount, 1);
  });
});
