/**
 * Dispatcher M11.4 — Foreground Location Tracker Unit Tests
 *
 * Execution: node --test --experimental-strip-types scripts/test-location-tracker.mjs
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  calculateHaversineDistance,
  evaluateCandidatePosition,
  LocationCoalescingQueue,
  MAX_ACCURACY_THRESHOLD_METERS,
  MIN_SIGNIFICANT_MOVEMENT_METERS,
  MIN_STATIONARY_INTERVAL_MS,
  ONSITE_TRACKING_PROFILE,
  TRAVEL_TRACKING_PROFILE,
} from '../src/lib/location-tracker-core.ts';

describe('M11.4 Distance Calculation (Haversine Formula)', () => {
  test('returns 0 for identical coordinates', () => {
    const dist = calculateHaversineDistance(40.7128, -74.006, 40.7128, -74.006);
    assert.equal(dist, 0);
  });

  test('calculates known distance between landmarks accurately', () => {
    // London (51.5074, -0.1278) to Paris (48.8566, 2.3522) ~ 343.5 km (±1%)
    const distance = calculateHaversineDistance(51.5074, -0.1278, 48.8566, 2.3522);
    assert.ok(distance > 340000 && distance < 350000, `Distance was ${distance}`);
  });

  test('calculates small distance movements accurately', () => {
    // ~111 meters is roughly 0.001 degree latitude at equator
    const distance = calculateHaversineDistance(0, 0, 0.001, 0);
    assert.ok(Math.abs(distance - 111.2) < 2, `Distance was ${distance}`);
  });
});

describe('M11.4 Target Tracking Profiles', () => {
  test('Travel profile targets 30 seconds and 50 meters with High accuracy', () => {
    assert.equal(TRAVEL_TRACKING_PROFILE.timeIntervalMs, 30000);
    assert.equal(TRAVEL_TRACKING_PROFILE.distanceIntervalMeters, 50);
    assert.equal(TRAVEL_TRACKING_PROFILE.accuracyLabel, 'High');
  });

  test('On-site profile throttles to 3 minutes and 150 meters with Balanced accuracy', () => {
    assert.equal(ONSITE_TRACKING_PROFILE.timeIntervalMs, 180000);
    assert.equal(ONSITE_TRACKING_PROFILE.distanceIntervalMeters, 150);
    assert.equal(ONSITE_TRACKING_PROFILE.accuracyLabel, 'Balanced');
  });

  test('Approved thresholds are conservative', () => {
    assert.equal(MAX_ACCURACY_THRESHOLD_METERS, 200.0);
    assert.equal(MIN_SIGNIFICANT_MOVEMENT_METERS, 10.0);
    assert.equal(MIN_STATIONARY_INTERVAL_MS, 60000);
  });
});

describe('M11.4 Candidate Position Evaluation', () => {
  const validBaseCoord = {
    latitude: 37.7749,
    longitude: -122.4194,
    accuracy: 12.5,
  };

  test('accepts first valid position fix', () => {
    const result = evaluateCandidatePosition({
      candidate: validBaseCoord,
      lastSubmitted: null,
      lastSubmittedTimestampMs: 0,
    });
    assert.equal(result.shouldSubmit, true);
    assert.match(result.reason, /initial position fix/i);
  });

  test('rejects non-finite coordinates', () => {
    const nanLat = evaluateCandidatePosition({
      candidate: { ...validBaseCoord, latitude: NaN },
      lastSubmitted: null,
      lastSubmittedTimestampMs: 0,
    });
    assert.equal(nanLat.shouldSubmit, false);
    assert.match(nanLat.reason, /non-finite/i);

    const infLon = evaluateCandidatePosition({
      candidate: { ...validBaseCoord, longitude: Infinity },
      lastSubmitted: null,
      lastSubmittedTimestampMs: 0,
    });
    assert.equal(infLon.shouldSubmit, false);
    assert.match(infLon.reason, /non-finite/i);
  });

  test('rejects out-of-range coordinates', () => {
    const latHigh = evaluateCandidatePosition({
      candidate: { ...validBaseCoord, latitude: 91.0 },
      lastSubmitted: null,
      lastSubmittedTimestampMs: 0,
    });
    assert.equal(latHigh.shouldSubmit, false);
    assert.match(latHigh.reason, /latitude is out of valid bounds/i);

    const latLow = evaluateCandidatePosition({
      candidate: { ...validBaseCoord, latitude: -90.5 },
      lastSubmitted: null,
      lastSubmittedTimestampMs: 0,
    });
    assert.equal(latLow.shouldSubmit, false);

    const lonHigh = evaluateCandidatePosition({
      candidate: { ...validBaseCoord, longitude: 181.0 },
      lastSubmitted: null,
      lastSubmittedTimestampMs: 0,
    });
    assert.equal(lonHigh.shouldSubmit, false);
    assert.match(lonHigh.reason, /longitude is out of valid bounds/i);
  });

  test('rejects negative or non-finite accuracy', () => {
    const negAccuracy = evaluateCandidatePosition({
      candidate: { ...validBaseCoord, accuracy: -5 },
      lastSubmitted: null,
      lastSubmittedTimestampMs: 0,
    });
    assert.equal(negAccuracy.shouldSubmit, false);
    assert.match(negAccuracy.reason, /accuracy is not a valid/i);
  });

  test('rejects weak accuracy beyond threshold (200m)', () => {
    const weakAccuracy = evaluateCandidatePosition({
      candidate: { ...validBaseCoord, accuracy: 250 },
      lastSubmitted: null,
      lastSubmittedTimestampMs: 0,
    });
    assert.equal(weakAccuracy.shouldSubmit, false);
    assert.match(weakAccuracy.reason, /exceeds threshold of 200m/i);
  });

  test('accepts accuracy within approved threshold (<= 200m)', () => {
    const exactThreshold = evaluateCandidatePosition({
      candidate: { ...validBaseCoord, accuracy: 200 },
      lastSubmitted: null,
      lastSubmittedTimestampMs: 0,
    });
    assert.equal(exactThreshold.shouldSubmit, true);
  });

  test('skips unchanged stationary positions within 60 seconds and < 10m', () => {
    const baseTime = 1000000;
    // Moving 2 meters north is ~0.00002 degrees lat
    const smallMove = {
      latitude: validBaseCoord.latitude + 0.00002,
      longitude: validBaseCoord.longitude,
      accuracy: 10,
    };

    const result = evaluateCandidatePosition({
      candidate: smallMove,
      lastSubmitted: validBaseCoord,
      lastSubmittedTimestampMs: baseTime,
      nowTimestampMs: baseTime + 25000, // 25s elapsed (< 60s)
    });

    assert.equal(result.shouldSubmit, false);
    assert.match(result.reason, /stationary position fix/i);
  });

  test('allows stationary heartbeat after 60 seconds elapsed', () => {
    const baseTime = 1000000;
    const sameSpot = { ...validBaseCoord };

    const result = evaluateCandidatePosition({
      candidate: sameSpot,
      lastSubmitted: validBaseCoord,
      lastSubmittedTimestampMs: baseTime,
      nowTimestampMs: baseTime + 65000, // 65s elapsed (> 60s)
    });

    assert.equal(result.shouldSubmit, true);
    assert.match(result.reason, /position changed/i);
  });

  test('allows position fix immediately if distance moved is >= 10m', () => {
    const baseTime = 1000000;
    // ~25 meters movement
    const movedCoord = {
      latitude: validBaseCoord.latitude + 0.00025,
      longitude: validBaseCoord.longitude,
      accuracy: 10,
    };

    const result = evaluateCandidatePosition({
      candidate: movedCoord,
      lastSubmitted: validBaseCoord,
      lastSubmittedTimestampMs: baseTime,
      nowTimestampMs: baseTime + 5000, // only 5s elapsed
    });

    assert.equal(result.shouldSubmit, true);
    assert.match(result.reason, /position changed by/i);
  });
});

describe('M11.4 Concurrency Coalescing Queue', () => {
  test('executes write immediately when queue is idle', async () => {
    const executedWrites = [];
    const queue = new LocationCoalescingQueue(async (coords) => {
      executedWrites.push(coords);
      return true;
    });

    const fix1 = { latitude: 37.77, longitude: -122.41, accuracy: 10 };
    await queue.submit(fix1);

    assert.equal(executedWrites.length, 1);
    assert.equal(executedWrites[0], fix1);
    assert.equal(queue.getIsWriting(), false);
  });

  test('coalesces rapid fixes into only the newest fix while write is in flight', async () => {
    const executedWrites = [];
    let resolveFirstWrite;
    const firstWritePromise = new Promise((resolve) => {
      resolveFirstWrite = resolve;
    });

    const queue = new LocationCoalescingQueue(async (coords) => {
      executedWrites.push(coords);
      if (executedWrites.length === 1) {
        await firstWritePromise;
      }
      return true;
    });

    const fix1 = { latitude: 10, longitude: 20, accuracy: 5 };
    const fix2 = { latitude: 11, longitude: 21, accuracy: 5 };
    const fix3 = { latitude: 12, longitude: 22, accuracy: 5 };
    const fix4 = { latitude: 13, longitude: 23, accuracy: 5 };

    // Launch first write (will pause)
    const write1 = queue.submit(fix1);
    assert.equal(queue.getIsWriting(), true);

    // Enqueue intermediate fixes while first write is pending
    const write2 = queue.submit(fix2);
    const write3 = queue.submit(fix3);
    const write4 = queue.submit(fix4);

    assert.equal(queue.getHasPending(), true);

    // Complete first write
    resolveFirstWrite();
    await Promise.all([write1, write2, write3, write4]);

    // Only fix1 and fix4 should have been executed. fix2 and fix3 were dropped (coalesced)
    assert.equal(executedWrites.length, 2);
    assert.equal(executedWrites[0].latitude, 10);
    assert.equal(executedWrites[1].latitude, 13);
    assert.equal(queue.getIsWriting(), false);
    assert.equal(queue.getHasPending(), false);
  });

  test('clear() resets pending buffer and state immediately', () => {
    const queue = new LocationCoalescingQueue(async () => true);
    queue.clear();
    assert.equal(queue.getIsWriting(), false);
    assert.equal(queue.getHasPending(), false);
  });

  test('recovers safely and does not deadlock if write rejects', async () => {
    let callCount = 0;
    const queue = new LocationCoalescingQueue(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Database network timeout');
      }
      return true;
    });

    const fix1 = { latitude: 10, longitude: 20, accuracy: 5 };
    const fix2 = { latitude: 11, longitude: 21, accuracy: 5 };

    await assert.rejects(async () => {
      await queue.submit(fix1);
    }, /Database network timeout/);

    assert.equal(queue.getIsWriting(), false);

    // Next write should succeed normally
    await queue.submit(fix2);
    assert.equal(callCount, 2);
    assert.equal(queue.getIsWriting(), false);
  });
});
