/**
 * Dispatcher M11.5 — Background Location Core Unit Tests
 *
 * Execution: node --test --experimental-strip-types scripts/test-background-location.mjs
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  BACKGROUND_TRACKING_STORAGE_KEY,
  buildBackgroundLocationOptionsConfig,
  DISPATCHER_BACKGROUND_LOCATION_TASK,
  isEligibleForBackgroundTracking,
  validateBackgroundJobContext,
} from '../src/lib/background-location-core.ts';

describe('M11.5 Background Task Constants & Storage Keys', () => {
  test('task name is stable and non-empty', () => {
    assert.equal(DISPATCHER_BACKGROUND_LOCATION_TASK, 'dispatcher-background-location-task');
  });

  test('storage key is scoped to dispatcher namespace', () => {
    assert.equal(BACKGROUND_TRACKING_STORAGE_KEY, '@dispatcher/active_background_tracking');
  });
});

describe('M11.5 Background Location Status Eligibility', () => {
  test('permits tracking strictly during active field travel and work', () => {
    assert.equal(isEligibleForBackgroundTracking('on_the_way'), true);
    assert.equal(isEligibleForBackgroundTracking('arrived'), true);
    assert.equal(isEligibleForBackgroundTracking('in_progress'), true);
  });

  test('forbids tracking during pre-travel stages', () => {
    assert.equal(isEligibleForBackgroundTracking('unassigned'), false);
    assert.equal(isEligibleForBackgroundTracking('assigned'), false);
    assert.equal(isEligibleForBackgroundTracking('accepted'), false);
  });

  test('strictly forbids tracking once job reaches terminal status', () => {
    assert.equal(isEligibleForBackgroundTracking('completed'), false);
    assert.equal(isEligibleForBackgroundTracking('cancelled'), false);
  });

  test('handles null, undefined, or empty statuses safely', () => {
    assert.equal(isEligibleForBackgroundTracking(null), false);
    assert.equal(isEligibleForBackgroundTracking(undefined), false);
    assert.equal(isEligibleForBackgroundTracking(''), false);
    assert.equal(isEligibleForBackgroundTracking('unknown_stage'), false);
  });
});

describe('M11.5 Stored Background Context Validation', () => {
  const validContext = {
    jobId: 'job-uuid-1111',
    workerId: 'worker-uuid-2222',
    status: 'on_the_way',
    startedAtMs: 1700000000000,
  };

  test('validates correct context without worker constraint', () => {
    const result = validateBackgroundJobContext(validContext);
    assert.equal(result.isValid, true);
    assert.equal(result.context?.jobId, 'job-uuid-1111');
    assert.equal(result.context?.workerId, 'worker-uuid-2222');
  });

  test('validates correct context matching authenticated worker', () => {
    const result = validateBackgroundJobContext(validContext, 'worker-uuid-2222');
    assert.equal(result.isValid, true);
  });

  test('rejects context when stored worker does not match authenticated user', () => {
    const result = validateBackgroundJobContext(validContext, 'different-worker-9999');
    assert.equal(result.isValid, false);
    assert.match(result.reason, /does not match authenticated worker/i);
    assert.equal(result.context, null);
  });

  test('rejects empty or non-object context', () => {
    assert.equal(validateBackgroundJobContext(null).isValid, false);
    assert.equal(validateBackgroundJobContext(undefined).isValid, false);
    assert.equal(validateBackgroundJobContext('string').isValid, false);
    assert.equal(validateBackgroundJobContext(12345).isValid, false);
  });

  test('rejects context missing jobId or workerId', () => {
    const missingJob = { ...validContext, jobId: '' };
    assert.equal(validateBackgroundJobContext(missingJob).isValid, false);

    const missingWorker = { ...validContext, workerId: '   ' };
    assert.equal(validateBackgroundJobContext(missingWorker).isValid, false);
  });

  test('rejects context with terminal or pre-travel status', () => {
    const completedJob = { ...validContext, status: 'completed' };
    const resCompleted = validateBackgroundJobContext(completedJob);
    assert.equal(resCompleted.isValid, false);
    assert.match(resCompleted.reason, /not eligible for background tracking/i);

    const assignedJob = { ...validContext, status: 'assigned' };
    const resAssigned = validateBackgroundJobContext(assignedJob);
    assert.equal(resAssigned.isValid, false);
    assert.match(resAssigned.reason, /not eligible for background tracking/i);
  });
});

describe('M11.5 Background Location Options Configuration Builder', () => {
  test('travel mode (on_the_way) targets 30s / 50m with High accuracy', () => {
    const config = buildBackgroundLocationOptionsConfig('on_the_way');
    assert.equal(config.accuracyLevel, 'High');
    assert.equal(config.timeIntervalMs, 30000);
    assert.equal(config.distanceIntervalMeters, 50);
    assert.equal(config.deferredUpdatesIntervalMs, 30000);
    assert.equal(config.deferredUpdatesDistanceMeters, 50);
    assert.equal(config.showsBackgroundLocationIndicator, true);
    assert.equal(config.pausesUpdatesAutomatically, false);
    assert.equal(config.foregroundService.notificationTitle, 'Dispatcher Active Visit');
    assert.match(config.foregroundService.notificationBody, /travel/i);
    assert.equal(config.foregroundService.killServiceOnDestroy, false);
    assert.equal(config.foregroundService.notificationColor, '#000000');
  });

  test('on-site mode (arrived/in_progress) throttles to 3m / 150m with Balanced accuracy', () => {
    const arrivedConfig = buildBackgroundLocationOptionsConfig('arrived');
    assert.equal(arrivedConfig.accuracyLevel, 'Balanced');
    assert.equal(arrivedConfig.timeIntervalMs, 180000);
    assert.equal(arrivedConfig.distanceIntervalMeters, 150);
    assert.match(arrivedConfig.foregroundService.notificationBody, /on-site/i);

    const inProgressConfig = buildBackgroundLocationOptionsConfig('in_progress');
    assert.equal(inProgressConfig.accuracyLevel, 'Balanced');
    assert.equal(inProgressConfig.timeIntervalMs, 180000);
    assert.equal(inProgressConfig.distanceIntervalMeters, 150);
    assert.match(inProgressConfig.foregroundService.notificationBody, /on-site/i);
  });
});
