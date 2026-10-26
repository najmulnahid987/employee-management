/**
 * Dispatcher M11.7 — Tracking Stop Rules, Recovery, and Cleanup Unit Tests
 *
 * Authoritative Specifications:
 * - docs/product-specification.md
 * - AGENTS.md (M4 & M11 Architecture)
 * - M11.7 Tracking Stop Rules, Recovery, and Cleanup
 *
 * Execution: node --test --experimental-strip-types scripts/test-tracking-cleanup.mjs
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  evaluateCandidatePosition,
  LocationCoalescingQueue,
} from '../src/lib/location-tracker-core.ts';
import {
  isEligibleForBackgroundTracking,
  validateBackgroundJobContext,
} from '../src/lib/background-location-core.ts';

describe('M11.7 Idempotent Queue Cleanup & Cancellation', () => {
  test('repeated clear() calls are safe, idempotent, and leave stopped state', () => {
    let writeCount = 0;
    const queue = new LocationCoalescingQueue(async () => {
      writeCount++;
      return true;
    });

    // Initial state
    assert.equal(queue.getIsStopped(), false);
    assert.equal(queue.getIsWriting(), false);
    assert.equal(queue.getHasPending(), false);

    // Call clear multiple times sequentially
    queue.clear();
    assert.equal(queue.getIsStopped(), true);
    assert.equal(queue.getHasPending(), false);

    queue.clear();
    queue.clear();
    assert.equal(queue.getIsStopped(), true);
    assert.equal(queue.getHasPending(), false);
    assert.equal(writeCount, 0);
  });

  test('submitting to a stopped queue immediately discards candidate fixes', async () => {
    let writeCount = 0;
    const queue = new LocationCoalescingQueue(async () => {
      writeCount++;
      return true;
    });

    queue.clear();
    assert.equal(queue.getIsStopped(), true);

    await queue.submit({ latitude: 37.7749, longitude: -122.4194, accuracy: 10 });
    assert.equal(writeCount, 0);
    assert.equal(queue.getHasPending(), false);
    assert.equal(queue.getIsWriting(), false);
  });

  test('queue.reset() cleanly reactivates queue for new active tracking sessions', async () => {
    let writeCount = 0;
    const queue = new LocationCoalescingQueue(async () => {
      writeCount++;
      return true;
    });

    queue.clear();
    assert.equal(queue.getIsStopped(), true);

    queue.reset();
    assert.equal(queue.getIsStopped(), false);

    await queue.submit({ latitude: 37.7749, longitude: -122.4194, accuracy: 10 });
    assert.equal(writeCount, 1);
  });
});

describe('M11.7 In-Flight Write Interruption & Pending Buffer Discard', () => {
  test('clear() during in-flight network write immediately drops pending buffer and stops draining', async () => {
    let writeResolve = null;
    const writesExecuted = [];

    const queue = new LocationCoalescingQueue(async (coords) => {
      writesExecuted.push(coords);
      return new Promise((resolve) => {
        writeResolve = resolve;
      });
    });

    // 1. Submit first fix (write starts, remains in flight)
    const fix1 = { latitude: 37.7749, longitude: -122.4194, accuracy: 10 };
    const submitPromise1 = queue.submit(fix1);

    assert.equal(queue.getIsWriting(), true);
    assert.equal(writesExecuted.length, 1);
    assert.equal(writesExecuted[0], fix1);

    // 2. Submit second fix while first write is in flight (buffered as pendingFix)
    const fix2 = { latitude: 37.7755, longitude: -122.4185, accuracy: 12 };
    await queue.submit(fix2);
    assert.equal(queue.getHasPending(), true);

    // 3. Status transition to completed / cancelled occurs mid-flight -> stop tracking called!
    queue.clear();
    assert.equal(queue.getIsStopped(), true);
    assert.equal(queue.getHasPending(), false);

    // 4. In-flight network promise finishes
    writeResolve(true);
    await submitPromise1;

    // 5. Verify that fix2 was NEVER submitted and queue stopped draining
    assert.equal(writesExecuted.length, 1);
    assert.equal(queue.getIsWriting(), false);
    assert.equal(queue.getHasPending(), false);
  });
});

describe('M11.7 Coalescing Queue Discard on Disconnect & Reconnect', () => {
  test('never accumulates an unbounded FIFO queue: retains only single freshest point', async () => {
    const writesExecuted = [];
    let resolveFirstWrite = null;

    const queue = new LocationCoalescingQueue(async (coords) => {
      writesExecuted.push(coords);
      if (writesExecuted.length === 1) {
        return new Promise((resolve) => {
          resolveFirstWrite = resolve;
        });
      }
      return true;
    });

    // First write starts
    const fix1 = { latitude: 37.7749, longitude: -122.4194, accuracy: 10 };
    const submitPromise = queue.submit(fix1);

    // Rapid burst of 4 location updates while offline or in-flight
    const fix2 = { latitude: 37.7750, longitude: -122.4190, accuracy: 10 };
    const fix3 = { latitude: 37.7752, longitude: -122.4180, accuracy: 10 };
    const fix4 = { latitude: 37.7754, longitude: -122.4170, accuracy: 10 };
    const fix5 = { latitude: 37.7760, longitude: -122.4160, accuracy: 10 };

    await queue.submit(fix2);
    await queue.submit(fix3);
    await queue.submit(fix4);
    await queue.submit(fix5);

    // Only fix5 should be kept in pending buffer (coalesced)
    assert.equal(queue.getHasPending(), true);

    // Complete first write
    resolveFirstWrite(true);
    await submitPromise;

    // Second write should be strictly fix5 (freshest); fix2, fix3, fix4 are discarded
    assert.equal(writesExecuted.length, 2);
    assert.equal(writesExecuted[0], fix1);
    assert.equal(writesExecuted[1], fix5);
    assert.equal(queue.getHasPending(), false);
  });
});

describe('M11.7 Stored Context Stop Rules & Pre-Flight Validation', () => {
  test('rejects resumed tracking context if job status is completed or cancelled', () => {
    const completedContext = {
      jobId: 'job-uuid-1',
      workerId: 'worker-uuid-1',
      status: 'completed',
      startedAtMs: Date.now() - 60000,
    };

    const cancelledContext = {
      jobId: 'job-uuid-2',
      workerId: 'worker-uuid-1',
      status: 'cancelled',
      startedAtMs: Date.now() - 60000,
    };

    const validation1 = validateBackgroundJobContext(completedContext);
    assert.equal(validation1.isValid, false);
    assert.match(validation1.reason, /not eligible/i);

    const validation2 = validateBackgroundJobContext(cancelledContext);
    assert.equal(validation2.isValid, false);
    assert.match(validation2.reason, /not eligible/i);
  });

  test('rejects tracking context if worker ID does not match authenticated user', () => {
    const context = {
      jobId: 'job-uuid-1',
      workerId: 'worker-uuid-alice',
      status: 'on_the_way',
      startedAtMs: Date.now(),
    };

    const validation = validateBackgroundJobContext(context, 'worker-uuid-bob');
    assert.equal(validation.isValid, false);
    assert.match(validation.reason, /does not match authenticated worker/i);
  });

  test('rejects pre-travel statuses as ineligible for tracking', () => {
    assert.equal(isEligibleForBackgroundTracking('unassigned'), false);
    assert.equal(isEligibleForBackgroundTracking('assigned'), false);
    assert.equal(isEligibleForBackgroundTracking('accepted'), false);
  });

  test('permits active field stages only', () => {
    assert.equal(isEligibleForBackgroundTracking('on_the_way'), true);
    assert.equal(isEligibleForBackgroundTracking('arrived'), true);
    assert.equal(isEligibleForBackgroundTracking('in_progress'), true);
  });
});

describe('M11.7 Backend Database Error Code Handling', () => {
  test('identifies authorization failure (42501) and ineligible status (P0001) as stop triggers', () => {
    const isStopError = (err) => {
      const msg = err.message || '';
      const code = err.code || '';
      return (
        msg.includes('not in status') ||
        msg.includes('not assigned') ||
        code === '42501' ||
        code === 'P0001'
      );
    };

    // Unassigned or reassigned
    assert.equal(
      isStopError({ code: '42501', message: 'Job is not assigned to the authenticated worker in this business.' }),
      true
    );

    // Completed or cancelled
    assert.equal(
      isStopError({ code: 'P0001', message: 'Job is in status "completed", which is not eligible for location tracking.' }),
      true
    );

    assert.equal(
      isStopError({ code: 'P0001', message: 'Job is in status "cancelled", which is not eligible for location tracking.' }),
      true
    );

    // Transient network error should NOT trigger permanent stop
    assert.equal(
      isStopError({ code: 'ETIMEDOUT', message: 'Network connection lost.' }),
      false
    );
  });
});
