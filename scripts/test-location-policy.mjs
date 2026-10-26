/**
 * Dispatcher M11.3 — Location Tracking Policy & Permission Manager Unit Tests
 *
 * Execution: node --test --experimental-strip-types scripts/test-location-policy.mjs
 */

import assert from 'node:assert/strict';
import test, { beforeEach, describe } from 'node:test';

import {
  evaluateTrackingPolicy,
  hasDismissedPermissionNotice,
  LOCATION_PERMISSION_EXPLANATION,
  setDismissedPermissionNotice,
} from '../src/lib/location-policy-core.ts';

describe('M11.3 Tracking Policy Engine (M9 State Machine Alignment)', () => {
  const workerId = 'worker-uuid-1111';
  const jobId = 'job-uuid-2222';

  test('accepted status: does NOT start continuous location collection', () => {
    const decision = evaluateTrackingPolicy({
      workerId,
      isActiveWorker: true,
      activeJob: { id: jobId, workerId, status: 'accepted' },
      currentTrackingJobId: null,
      currentMode: 'INACTIVE',
    });

    assert.equal(decision.action, 'NONE');
    assert.equal(decision.targetJobId, null);
    assert.equal(decision.trackingMode, 'INACTIVE');
    assert.match(decision.reason, /location collection not permitted before field travel/i);
  });

  test('on_the_way status: starts high-frequency tracking for this job', () => {
    const decision = evaluateTrackingPolicy({
      workerId,
      isActiveWorker: true,
      activeJob: { id: jobId, workerId, status: 'on_the_way' },
      currentTrackingJobId: null,
      currentMode: 'INACTIVE',
    });

    assert.equal(decision.action, 'START');
    assert.equal(decision.targetJobId, jobId);
    assert.equal(decision.trackingMode, 'HIGH_FREQUENCY');
    assert.match(decision.reason, /high-frequency tracking active/i);
  });

  test('on_the_way status: returns NONE if already tracking in high-frequency mode', () => {
    const decision = evaluateTrackingPolicy({
      workerId,
      isActiveWorker: true,
      activeJob: { id: jobId, workerId, status: 'on_the_way' },
      currentTrackingJobId: jobId,
      currentMode: 'HIGH_FREQUENCY',
    });

    assert.equal(decision.action, 'NONE');
    assert.equal(decision.targetJobId, jobId);
    assert.equal(decision.trackingMode, 'HIGH_FREQUENCY');
  });

  test('arrived status: throttles to low-frequency heartbeat on-site', () => {
    const decision = evaluateTrackingPolicy({
      workerId,
      isActiveWorker: true,
      activeJob: { id: jobId, workerId, status: 'arrived' },
      currentTrackingJobId: jobId,
      currentMode: 'HIGH_FREQUENCY',
    });

    assert.equal(decision.action, 'THROTTLE');
    assert.equal(decision.targetJobId, jobId);
    assert.equal(decision.trackingMode, 'LOW_FREQUENCY');
    assert.match(decision.reason, /throttled to low-frequency heartbeat/i);
  });

  test('in_progress status: continues low-frequency heartbeat on-site', () => {
    const decision = evaluateTrackingPolicy({
      workerId,
      isActiveWorker: true,
      activeJob: { id: jobId, workerId, status: 'in_progress' },
      currentTrackingJobId: jobId,
      currentMode: 'LOW_FREQUENCY',
    });

    assert.equal(decision.action, 'NONE');
    assert.equal(decision.targetJobId, jobId);
    assert.equal(decision.trackingMode, 'LOW_FREQUENCY');
    assert.match(decision.reason, /low-frequency heartbeat/i);
  });

  test('completed status: stops tracking immediately (terminal)', () => {
    const decision = evaluateTrackingPolicy({
      workerId,
      isActiveWorker: true,
      activeJob: { id: jobId, workerId, status: 'completed' },
      currentTrackingJobId: jobId,
      currentMode: 'LOW_FREQUENCY',
    });

    assert.equal(decision.action, 'STOP');
    assert.equal(decision.targetJobId, null);
    assert.equal(decision.trackingMode, 'INACTIVE');
    assert.match(decision.reason, /terminal status/i);
  });

  test('cancelled status: stops tracking immediately (terminal)', () => {
    const decision = evaluateTrackingPolicy({
      workerId,
      isActiveWorker: true,
      activeJob: { id: jobId, workerId, status: 'cancelled' },
      currentTrackingJobId: jobId,
      currentMode: 'HIGH_FREQUENCY',
    });

    assert.equal(decision.action, 'STOP');
    assert.equal(decision.targetJobId, null);
    assert.equal(decision.trackingMode, 'INACTIVE');
    assert.match(decision.reason, /terminal status/i);
  });

  test('worker sign-out: stops tracking immediately', () => {
    const decision = evaluateTrackingPolicy({
      workerId: null,
      isActiveWorker: false,
      activeJob: { id: jobId, workerId, status: 'on_the_way' },
      currentTrackingJobId: jobId,
      currentMode: 'HIGH_FREQUENCY',
    });

    assert.equal(decision.action, 'STOP');
    assert.equal(decision.targetJobId, null);
    assert.equal(decision.trackingMode, 'INACTIVE');
    assert.match(decision.reason, /signed out or deactivated/i);
  });

  test('worker deactivation: stops tracking immediately', () => {
    const decision = evaluateTrackingPolicy({
      workerId,
      isActiveWorker: false,
      activeJob: { id: jobId, workerId, status: 'on_the_way' },
      currentTrackingJobId: jobId,
      currentMode: 'HIGH_FREQUENCY',
    });

    assert.equal(decision.action, 'STOP');
    assert.equal(decision.targetJobId, null);
    assert.equal(decision.trackingMode, 'INACTIVE');
  });

  test('job unassigned or reassigned: stops tracking old job', () => {
    const decision = evaluateTrackingPolicy({
      workerId,
      isActiveWorker: true,
      activeJob: { id: jobId, workerId: 'different-worker-9999', status: 'on_the_way' },
      currentTrackingJobId: jobId,
      currentMode: 'HIGH_FREQUENCY',
    });

    assert.equal(decision.action, 'STOP');
    assert.equal(decision.targetJobId, null);
    assert.equal(decision.trackingMode, 'INACTIVE');
    assert.match(decision.reason, /not assigned to the authenticated technician/i);
  });

  test('job switch: never continues using old job ID, starts new job ID', () => {
    const newJobId = 'job-uuid-3333';
    const decision = evaluateTrackingPolicy({
      workerId,
      isActiveWorker: true,
      activeJob: { id: newJobId, workerId, status: 'on_the_way' },
      currentTrackingJobId: jobId, // was tracking old job
      currentMode: 'HIGH_FREQUENCY',
    });

    assert.equal(decision.action, 'START');
    assert.equal(decision.targetJobId, newJobId);
    assert.notEqual(decision.targetJobId, jobId);
    assert.equal(decision.trackingMode, 'HIGH_FREQUENCY');
    assert.match(decision.reason, /Switched active job/i);
  });
});

describe('M11.3 User-Facing Permission Explanation Exact Wording', () => {
  test('contains the exact frozen required policy text', () => {
    const requiredPhrase =
      'Dispatcher shares your location with your business owner while you are handling an active job. Location sharing starts when you begin travelling and stops when the job ends or is no longer assigned to you. Location is not tracked when you are off duty or have no eligible job.';

    const actualFullText = `${LOCATION_PERMISSION_EXPLANATION.lead} ${LOCATION_PERMISSION_EXPLANATION.body}`;
    assert.equal(actualFullText, requiredPhrase);
  });

  test('includes explicit non-blocking notices for approximate and denied states', () => {
    assert.ok(LOCATION_PERMISSION_EXPLANATION.approximateNotice.includes('Approximate location was granted'));
    assert.ok(LOCATION_PERMISSION_EXPLANATION.deniedNotice.includes('Live tracking will be unavailable to your dispatcher'));
    assert.ok(LOCATION_PERMISSION_EXPLANATION.servicesDisabledNotice.includes('Device location services are turned off'));
  });
});

describe('M11.3 Prevention of Repetitive Prompts', () => {
  beforeEach(() => {
    setDismissedPermissionNotice(false);
  });

  test('initially hasDismissedPermissionNotice is false', () => {
    assert.equal(hasDismissedPermissionNotice(), false);
  });

  test('setting dismissed marks hasDismissedPermissionNotice true', () => {
    setDismissedPermissionNotice(true);
    assert.equal(hasDismissedPermissionNotice(), true);
  });
});
