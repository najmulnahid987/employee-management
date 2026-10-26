/**
 * Dispatcher M9.2 — Job Lifecycle & State Machine Unit Tests
 *
 * Uses Node.js native test runner (node:test & node:assert/strict)
 * Execution: node --test --experimental-strip-types scripts/test-lifecycle.mjs
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  ACTIVE_JOB_STATUSES,
  canTransitionJob,
  getAllowedNextStatuses,
  getNextWorkerAction,
  getValidNextActions,
  isJobActive,
  isJobStatus,
  isJobUpcoming,
  isTerminalJobStatus,
  JOB_ACTIONS,
  JOB_STATUSES,
  JOB_TRANSITION_MAP,
  NON_TERMINAL_JOB_STATUSES,
  OWNER_TRANSITION_MAP,
  TERMINAL_JOB_STATUSES,
  UPCOMING_JOB_STATUSES,
  WORKER_STATUS_PRIORITY,
  WORKER_TRANSITION_MAP,
  LIFECYCLE_TIMESTAMP_FIELDS,
  STATUS_TIMESTAMP_FIELD_MAP,
  isLifecycleTimestampField,
  getStatusTimestampField,
} from '../src/lib/lifecycle.ts';

describe('Job Lifecycle Status Definitions', () => {
  test('contains exactly the 8 frozen statuses from product spec', () => {
    assert.equal(JOB_STATUSES.length, 8);
    const expectedStatuses = [
      'unassigned',
      'assigned',
      'accepted',
      'on_the_way',
      'arrived',
      'in_progress',
      'completed',
      'cancelled',
    ];
    for (const status of expectedStatuses) {
      assert.ok(JOB_STATUSES.includes(status), `Missing status: ${status}`);
      assert.ok(isJobStatus(status), `isJobStatus failed for: ${status}`);
    }
  });

  test('rejects unsupported or obsolete status values', () => {
    const invalidStatuses = ['pending', 'en_route', 'declined', 'paused', 'finished', ''];
    for (const invalid of invalidStatuses) {
      assert.equal(isJobStatus(invalid), false, `Should reject invalid status: ${invalid}`);
    }
  });

  test('correctly identifies terminal statuses', () => {
    assert.deepEqual([...TERMINAL_JOB_STATUSES], ['completed', 'cancelled']);
    assert.equal(isTerminalJobStatus('completed'), true);
    assert.equal(isTerminalJobStatus('cancelled'), true);

    for (const status of NON_TERMINAL_JOB_STATUSES) {
      assert.equal(isTerminalJobStatus(status), false, `${status} should not be terminal`);
    }
  });

  test('correctly identifies active and upcoming statuses', () => {
    assert.deepEqual([...ACTIVE_JOB_STATUSES], ['on_the_way', 'arrived', 'in_progress']);
    assert.deepEqual([...UPCOMING_JOB_STATUSES], ['unassigned', 'assigned', 'accepted']);

    assert.equal(isJobActive('on_the_way'), true);
    assert.equal(isJobActive('arrived'), true);
    assert.equal(isJobActive('in_progress'), true);
    assert.equal(isJobActive('assigned'), false);
    assert.equal(isJobActive('completed'), false);

    assert.equal(isJobUpcoming('unassigned'), true);
    assert.equal(isJobUpcoming('assigned'), true);
    assert.equal(isJobUpcoming('accepted'), true);
    assert.equal(isJobUpcoming('in_progress'), false);
    assert.equal(isJobUpcoming('cancelled'), false);
  });
});

describe('State Machine: Valid Transitions', () => {
  test('unassigned can transition to assigned and cancelled', () => {
    assert.deepEqual([...JOB_TRANSITION_MAP.unassigned], ['assigned', 'cancelled']);
    assert.equal(canTransitionJob('unassigned', 'assigned'), true);
    assert.equal(canTransitionJob('unassigned', 'cancelled'), true);
  });

  test('assigned can transition to accepted, unassigned, assigned, and cancelled', () => {
    assert.deepEqual([...JOB_TRANSITION_MAP.assigned], ['accepted', 'unassigned', 'assigned', 'cancelled']);
    assert.equal(canTransitionJob('assigned', 'accepted'), true); // Worker accept
    assert.equal(canTransitionJob('assigned', 'unassigned'), true); // Worker decline / Owner unassign
    assert.equal(canTransitionJob('assigned', 'assigned'), true); // Owner reassign
    assert.equal(canTransitionJob('assigned', 'cancelled'), true); // Owner cancel
  });

  test('sequential field execution progression', () => {
    assert.equal(canTransitionJob('accepted', 'on_the_way'), true);
    assert.equal(canTransitionJob('on_the_way', 'arrived'), true);
    assert.equal(canTransitionJob('arrived', 'in_progress'), true);
    assert.equal(canTransitionJob('in_progress', 'completed'), true);
  });

  test('all non-terminal statuses can transition to cancelled', () => {
    for (const status of NON_TERMINAL_JOB_STATUSES) {
      assert.equal(canTransitionJob(status, 'cancelled'), true, `${status} should allow transition to cancelled`);
    }
  });

  test('terminal statuses have zero permitted next transitions', () => {
    assert.deepEqual([...JOB_TRANSITION_MAP.completed], []);
    assert.deepEqual([...JOB_TRANSITION_MAP.cancelled], []);
    for (const target of JOB_STATUSES) {
      assert.equal(canTransitionJob('completed', target), false, `completed cannot transition to ${target}`);
      assert.equal(canTransitionJob('cancelled', target), false, `cancelled cannot transition to ${target}`);
    }
  });
});

describe('State Machine: Disallowed Transitions (Illegal Skips & Backward Steps)', () => {
  test('disallows arbitrary status jumps', () => {
    assert.equal(canTransitionJob('unassigned', 'accepted'), false);
    assert.equal(canTransitionJob('unassigned', 'in_progress'), false);
    assert.equal(canTransitionJob('unassigned', 'completed'), false);
    assert.equal(canTransitionJob('assigned', 'in_progress'), false);
    assert.equal(canTransitionJob('assigned', 'completed'), false);
    assert.equal(canTransitionJob('accepted', 'completed'), false);
    assert.equal(canTransitionJob('on_the_way', 'completed'), false);
  });

  test('disallows backward steps for field stages', () => {
    assert.equal(canTransitionJob('accepted', 'assigned'), false);
    assert.equal(canTransitionJob('on_the_way', 'accepted'), false);
    assert.equal(canTransitionJob('arrived', 'on_the_way'), false);
    assert.equal(canTransitionJob('in_progress', 'arrived'), false);
    assert.equal(canTransitionJob('in_progress', 'unassigned'), false);
  });
});

describe('Role-Based Authorization Rules', () => {
  test('worker permissions: field execution, accept, and decline only', () => {
    // Worker can accept and decline in assigned
    assert.equal(canTransitionJob('assigned', 'accepted', 'worker'), true);
    assert.equal(canTransitionJob('assigned', 'unassigned', 'worker'), true);

    // Worker can advance sequential field steps
    assert.equal(canTransitionJob('accepted', 'on_the_way', 'worker'), true);
    assert.equal(canTransitionJob('on_the_way', 'arrived', 'worker'), true);
    assert.equal(canTransitionJob('arrived', 'in_progress', 'worker'), true);
    assert.equal(canTransitionJob('in_progress', 'completed', 'worker'), true);

    // Worker CANNOT cancel any job
    for (const status of JOB_STATUSES) {
      assert.equal(canTransitionJob(status, 'cancelled', 'worker'), false, `Worker cannot cancel from ${status}`);
    }

    // Worker CANNOT assign jobs
    assert.equal(canTransitionJob('unassigned', 'assigned', 'worker'), false);
    assert.equal(canTransitionJob('assigned', 'assigned', 'worker'), false);
  });

  test('owner permissions: dispatch assignment, unassign, reassign, and cancellation only', () => {
    // Owner can assign from unassigned
    assert.equal(canTransitionJob('unassigned', 'assigned', 'owner'), true);

    // Owner can unassign and reassign from assigned
    assert.equal(canTransitionJob('assigned', 'unassigned', 'owner'), true);
    assert.equal(canTransitionJob('assigned', 'assigned', 'owner'), true);

    // Owner can cancel any nonterminal job
    for (const status of NON_TERMINAL_JOB_STATUSES) {
      assert.equal(canTransitionJob(status, 'cancelled', 'owner'), true, `Owner should be able to cancel from ${status}`);
    }

    // Owner CANNOT perform field progression steps
    assert.equal(canTransitionJob('assigned', 'accepted', 'owner'), false);
    assert.equal(canTransitionJob('accepted', 'on_the_way', 'owner'), false);
    assert.equal(canTransitionJob('on_the_way', 'arrived', 'owner'), false);
    assert.equal(canTransitionJob('arrived', 'in_progress', 'owner'), false);
    assert.equal(canTransitionJob('in_progress', 'completed', 'owner'), false);
  });
});

describe('Action Helpers & Worker Flow', () => {
  test('returns valid actions for assigned status by role', () => {
    const workerActions = getValidNextActions('assigned', 'worker');
    assert.equal(workerActions.length, 2);
    const workerTypes = workerActions.map((a) => a.type);
    assert.ok(workerTypes.includes('accept_assignment'));
    assert.ok(workerTypes.includes('decline_assignment'));

    const ownerActions = getValidNextActions('assigned', 'owner');
    assert.equal(ownerActions.length, 3);
    const ownerTypes = ownerActions.map((a) => a.type);
    assert.ok(ownerTypes.includes('reassign_worker'));
    assert.ok(ownerTypes.includes('unassign_worker'));
    assert.ok(ownerTypes.includes('cancel_job'));
  });

  test('getNextWorkerAction returns correct sequential step', () => {
    assert.equal(getNextWorkerAction('assigned')?.type, 'accept_assignment');
    assert.equal(getNextWorkerAction('accepted')?.type, 'start_travel');
    assert.equal(getNextWorkerAction('on_the_way')?.type, 'record_arrival');
    assert.equal(getNextWorkerAction('arrived')?.type, 'start_work');
    assert.equal(getNextWorkerAction('in_progress')?.type, 'complete_work');
    assert.equal(getNextWorkerAction('completed'), null);
    assert.equal(getNextWorkerAction('cancelled'), null);
    assert.equal(getNextWorkerAction('unassigned'), null);
  });

  test('actions requiring reasons are flagged', () => {
    assert.equal(JOB_ACTIONS.cancel_job.requiresReason, true);
    assert.equal(JOB_ACTIONS.decline_assignment.requiresReason, true);
    assert.equal(JOB_ACTIONS.accept_assignment.requiresReason ?? false, false);
    assert.equal(JOB_ACTIONS.start_travel.requiresReason ?? false, false);
  });

  test('terminal actions are flagged', () => {
    assert.equal(JOB_ACTIONS.complete_work.isTerminal, true);
    assert.equal(JOB_ACTIONS.cancel_job.isTerminal, true);
    assert.equal(JOB_ACTIONS.accept_assignment.isTerminal ?? false, false);
  });
});

describe('Lifecycle Timestamp Consistency & Field Mappings', () => {
  test('contains exactly the 7 transition timestamp columns supported by the schema', () => {
    assert.equal(LIFECYCLE_TIMESTAMP_FIELDS.length, 7);
    const expectedFields = [
      'assigned_at',
      'accepted_at',
      'travelling_at',
      'arrived_at',
      'started_at',
      'completed_at',
      'cancelled_at',
    ];
    assert.deepEqual([...LIFECYCLE_TIMESTAMP_FIELDS], expectedFields);

    for (const field of expectedFields) {
      assert.equal(isLifecycleTimestampField(field), true, `Expected valid field: ${field}`);
    }
  });

  test('rejects non-lifecycle or arbitrary columns as transition timestamps', () => {
    const nonLifecycleColumns = [
      'created_at',
      'updated_at',
      'scheduled_at',
      'customer_name',
      'status',
      'notes',
      'id',
      '',
    ];
    for (const col of nonLifecycleColumns) {
      assert.equal(isLifecycleTimestampField(col), false, `Should reject column: ${col}`);
    }
  });

  test('maps each of the 8 statuses to its corresponding timestamp field or null', () => {
    assert.equal(getStatusTimestampField('unassigned'), null);
    assert.equal(getStatusTimestampField('assigned'), 'assigned_at');
    assert.equal(getStatusTimestampField('accepted'), 'accepted_at');
    assert.equal(getStatusTimestampField('on_the_way'), 'travelling_at');
    assert.equal(getStatusTimestampField('arrived'), 'arrived_at');
    assert.equal(getStatusTimestampField('in_progress'), 'started_at');
    assert.equal(getStatusTimestampField('completed'), 'completed_at');
    assert.equal(getStatusTimestampField('cancelled'), 'cancelled_at');
  });

  test('STATUS_TIMESTAMP_FIELD_MAP covers every frozen status exhaustively', () => {
    for (const status of JOB_STATUSES) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(STATUS_TIMESTAMP_FIELD_MAP, status),
        `Status ${status} is missing from STATUS_TIMESTAMP_FIELD_MAP`
      );
    }
  });
});

describe('M9.6 — Exhaustive Role & Status Action Matrix', () => {
  const allStatuses = [
    'unassigned',
    'assigned',
    'accepted',
    'on_the_way',
    'arrived',
    'in_progress',
    'completed',
    'cancelled',
  ];

  test('validates every role/status combination for Worker role', () => {
    const expectedWorkerActions = {
      unassigned: [],
      assigned: ['accept_assignment', 'decline_assignment'],
      accepted: ['start_travel'],
      on_the_way: ['record_arrival'],
      arrived: ['start_work'],
      in_progress: ['complete_work'],
      completed: [],
      cancelled: [],
    };

    const expectedNextWorkerAction = {
      unassigned: null,
      assigned: 'accept_assignment',
      accepted: 'start_travel',
      on_the_way: 'record_arrival',
      arrived: 'start_work',
      in_progress: 'complete_work',
      completed: null,
      cancelled: null,
    };

    for (const status of allStatuses) {
      const actions = getValidNextActions(status, 'worker');
      const actionTypes = actions.map((a) => a.type);
      assert.deepEqual(
        actionTypes,
        expectedWorkerActions[status],
        `Worker action mismatch for status: ${status}`
      );

      const nextAction = getNextWorkerAction(status);
      assert.equal(
        nextAction ? nextAction.type : null,
        expectedNextWorkerAction[status],
        `Next worker action mismatch for status: ${status}`
      );
    }
  });

  test('validates every role/status combination for Owner role', () => {
    const expectedOwnerActions = {
      unassigned: ['assign_worker', 'cancel_job'],
      assigned: ['reassign_worker', 'unassign_worker', 'cancel_job'],
      accepted: ['cancel_job'],
      on_the_way: ['cancel_job'],
      arrived: ['cancel_job'],
      in_progress: ['cancel_job'],
      completed: [],
      cancelled: [],
    };

    for (const status of allStatuses) {
      const actions = getValidNextActions(status, 'owner');
      const actionTypes = actions.map((a) => a.type);
      assert.deepEqual(
        actionTypes,
        expectedOwnerActions[status],
        `Owner action mismatch for status: ${status}`
      );
    }
  });

  test('enforces terminal finality for complete_work and cancel_job', () => {
    // Complete work action
    const completeAction = JOB_ACTIONS.complete_work;
    assert.equal(completeAction.targetStatus, 'completed');
    assert.equal(completeAction.isTerminal, true);

    // Cancel job action
    const cancelAction = JOB_ACTIONS.cancel_job;
    assert.equal(cancelAction.targetStatus, 'cancelled');
    assert.equal(cancelAction.isTerminal, true);
    assert.equal(cancelAction.requiresReason, true);

    // Terminal statuses allow zero actions for both roles
    for (const terminal of ['completed', 'cancelled']) {
      assert.equal(getValidNextActions(terminal, 'worker').length, 0);
      assert.equal(getValidNextActions(terminal, 'owner').length, 0);
    }
  });

  test('field execution stages strictly lock worker assignment/reassignment/unassignment', () => {
    const fieldExecutionStatuses = ['accepted', 'on_the_way', 'arrived', 'in_progress'];
    for (const status of fieldExecutionStatuses) {
      const ownerActions = getValidNextActions(status, 'owner');
      const types = ownerActions.map((a) => a.type);
      assert.ok(!types.includes('assign_worker'), `Status ${status} must not allow assign_worker`);
      assert.ok(!types.includes('reassign_worker'), `Status ${status} must not allow reassign_worker`);
      assert.ok(!types.includes('unassign_worker'), `Status ${status} must not allow unassign_worker`);
      assert.deepEqual(types, ['cancel_job'], `Status ${status} should only permit cancel_job for owner`);
    }
  });
});

describe('M9.7 — Idempotency & Race-Condition Protection Safeguards', () => {
  // Pure error sanitizer function reflecting jobs.ts logic
  function sanitizeError(msg) {
    if (msg.includes('Job status has changed') || msg.includes('expected')) {
      return 'The job status changed on another device. The screen has been refreshed with the latest status.';
    }
    if (msg.includes('Worker assignment is locked while job is in active field execution')) {
      return 'Technician is actively servicing this visit. Worker assignment is locked during field execution.';
    }
    if (
      msg.includes('Job is in terminal status') ||
      msg.includes('Cannot modify worker assignment for job in terminal status') ||
      msg.includes('Cannot cancel a completed job')
    ) {
      return 'This job has already reached a terminal status and cannot be modified.';
    }
    if (msg.includes('Network') || msg.includes('Failed to fetch')) {
      return 'Network connection error. Please check your internet connection and retry.';
    }
    return msg;
  }

  test('double-tap mutex: rejects concurrent transitions on same job', async () => {
    const inFlightTransitions = new Set();
    const jobId = 'job-123';

    // Mock transition runner with in-flight lock
    async function executeTransition(jobId, targetStatus, delayMs) {
      if (inFlightTransitions.has(jobId)) {
        return {
          success: false,
          error: 'A transition request is already in progress for this job. Please wait.',
        };
      }
      inFlightTransitions.add(jobId);
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        return { success: true, targetStatus };
      } finally {
        inFlightTransitions.delete(jobId);
      }
    }

    // Launch two transitions concurrently on the same job
    const call1Promise = executeTransition(jobId, 'accepted', 50);
    const call2Promise = executeTransition(jobId, 'accepted', 10);

    const [res1, res2] = await Promise.all([call1Promise, call2Promise]);

    // Exactly one should succeed and one should be rejected by the in-flight mutex
    assert.equal(res1.success, true);
    assert.equal(res2.success, false);
    assert.equal(
      res2.error,
      'A transition request is already in progress for this job. Please wait.'
    );

    // After completion, lock is cleared and subsequent transition succeeds
    const call3 = await executeTransition(jobId, 'on_the_way', 10);
    assert.equal(call3.success, true);
  });

  test('stale screen detection: rejects transitions when expected status is out of date', () => {
    // Screen expected 'assigned', but actual DB status is 'cancelled'
    const expectedCurrentStatus = 'assigned';
    const actualDatabaseStatus = 'cancelled';
    const targetStatus = 'accepted';

    // 1. Client guard check
    assert.equal(canTransitionJob(actualDatabaseStatus, targetStatus), false);

    // 2. Server conditional guard check simulation
    let serverError = null;
    if (expectedCurrentStatus !== actualDatabaseStatus) {
      serverError = `Job status has changed (expected ${expectedCurrentStatus}, currently ${actualDatabaseStatus}). Please refresh to view the latest status`;
    }

    assert.ok(serverError !== null);
    const userMessage = sanitizeError(serverError);
    assert.equal(
      userMessage,
      'The job status changed on another device. The screen has been refreshed with the latest status.'
    );
  });

  test('idempotent replay detection: targetStatus equals currentStatus produces zero state jump', () => {
    // If client retries and job is already at targetStatus
    function simulateAtomicTransition(job, targetStatus, expectedStatus) {
      // 1. Idempotency check: already reached target status
      if (job.status === targetStatus) {
        return { success: true, job, wasAlreadyReached: true, duplicateEventCreated: false };
      }
      // 2. Stale status check
      if (expectedStatus && job.status !== expectedStatus) {
        throw new Error(
          `Job status has changed (expected ${expectedStatus}, currently ${job.status})`
        );
      }
      // 3. Permitted transition check
      if (!canTransitionJob(job.status, targetStatus)) {
        throw new Error(`Invalid transition from ${job.status} to ${targetStatus}`);
      }
      return {
        success: true,
        job: { ...job, status: targetStatus },
        wasAlreadyReached: false,
        duplicateEventCreated: true,
      };
    }

    const initialJob = { id: 'j-1', status: 'accepted' };

    // Retry transition to 'accepted'
    const result = simulateAtomicTransition(initialJob, 'accepted', 'assigned');
    assert.equal(result.success, true);
    assert.equal(result.wasAlreadyReached, true);
    assert.equal(result.duplicateEventCreated, false);
    assert.equal(result.job.status, 'accepted');
  });

  test('terminal statuses remain completely terminal on retry or modification', () => {
    const completedJob = { id: 'j-comp', status: 'completed' };
    const cancelledJob = { id: 'j-canc', status: 'cancelled' };

    // Terminal jobs cannot be transitioned to any other status
    for (const target of ['unassigned', 'assigned', 'accepted', 'on_the_way', 'in_progress']) {
      assert.equal(canTransitionJob(completedJob.status, target), false);
      assert.equal(canTransitionJob(cancelledJob.status, target), false);
    }

    // Sanitize terminal messages properly
    const sanitizedComp = sanitizeError('Job is in terminal status (completed) and cannot be modified');
    assert.equal(
      sanitizedComp,
      'This job has already reached a terminal status and cannot be modified.'
    );
  });

  test('error sanitization maps all M9.7 concurrency & stale errors accurately', () => {
    assert.equal(
      sanitizeError('Job status has changed (expected assigned, currently cancelled)'),
      'The job status changed on another device. The screen has been refreshed with the latest status.'
    );
    assert.equal(
      sanitizeError('Worker assignment is locked while job is in active field execution (on_the_way)'),
      'Technician is actively servicing this visit. Worker assignment is locked during field execution.'
    );
    assert.equal(
      sanitizeError('Cannot cancel a completed job'),
      'This job has already reached a terminal status and cannot be modified.'
    );
    assert.equal(
      sanitizeError('Network request failed: timeout after 10000ms'),
      'Network connection error. Please check your internet connection and retry.'
    );
  });
});

describe('M9.8 — Full Lifecycle Acceptance Suite', () => {
  test('Required normal flow (Steps 1–7): sequential execution from unassigned to completed', () => {
    // Step 1: Initial creation is unassigned
    let currentStatus = 'unassigned';
    assert.equal(isJobStatus(currentStatus), true);
    assert.equal(isTerminalJobStatus(currentStatus), false);

    // Step 2: Owner assigns valid worker
    assert.equal(canTransitionJob(currentStatus, 'assigned', 'owner'), true);
    currentStatus = 'assigned';
    assert.equal(getStatusTimestampField(currentStatus), 'assigned_at');

    // Step 3: Assigned worker accepts
    assert.equal(canTransitionJob(currentStatus, 'accepted', 'worker'), true);
    currentStatus = 'accepted';
    assert.equal(getStatusTimestampField(currentStatus), 'accepted_at');

    // Step 4: Worker moves to customer
    assert.equal(canTransitionJob(currentStatus, 'on_the_way', 'worker'), true);
    currentStatus = 'on_the_way';
    assert.equal(getStatusTimestampField(currentStatus), 'travelling_at');

    // Step 5: Worker arrives
    assert.equal(canTransitionJob(currentStatus, 'arrived', 'worker'), true);
    currentStatus = 'arrived';
    assert.equal(getStatusTimestampField(currentStatus), 'arrived_at');

    // Step 6: Worker starts the job
    assert.equal(canTransitionJob(currentStatus, 'in_progress', 'worker'), true);
    currentStatus = 'in_progress';
    assert.equal(getStatusTimestampField(currentStatus), 'started_at');

    // Step 7: Worker confirms completion
    assert.equal(canTransitionJob(currentStatus, 'completed', 'worker'), true);
    currentStatus = 'completed';
    assert.equal(getStatusTimestampField(currentStatus), 'completed_at');
    assert.equal(isTerminalJobStatus(currentStatus), true);
  });

  test('Negative tests: rejects invalid status jumps and backward steps', () => {
    // unassigned -> accepted is rejected
    assert.equal(canTransitionJob('unassigned', 'accepted'), false);
    assert.equal(canTransitionJob('unassigned', 'accepted', 'worker'), false);
    assert.equal(canTransitionJob('unassigned', 'accepted', 'owner'), false);

    // assigned -> arrived is rejected
    assert.equal(canTransitionJob('assigned', 'arrived'), false);
    assert.equal(canTransitionJob('assigned', 'arrived', 'worker'), false);

    // completed -> on_the_way is rejected
    assert.equal(canTransitionJob('completed', 'on_the_way'), false);
    assert.equal(canTransitionJob('completed', 'on_the_way', 'worker'), false);
    assert.equal(canTransitionJob('completed', 'on_the_way', 'owner'), false);

    // cancelled jobs cannot be reopened
    for (const target of JOB_STATUSES) {
      assert.equal(canTransitionJob('cancelled', target), false);
      assert.equal(canTransitionJob('cancelled', target, 'worker'), false);
      assert.equal(canTransitionJob('cancelled', target, 'owner'), false);
    }

    // completed jobs cannot transition to anything
    for (const target of JOB_STATUSES) {
      assert.equal(canTransitionJob('completed', target), false);
      assert.equal(canTransitionJob('completed', target, 'worker'), false);
      assert.equal(canTransitionJob('completed', target, 'owner'), false);
    }
  });

  test('Role segregation: owner cannot impersonate worker execution steps', () => {
    const fieldExecutionSteps = [
      ['assigned', 'accepted'],
      ['accepted', 'on_the_way'],
      ['on_the_way', 'arrived'],
      ['arrived', 'in_progress'],
      ['in_progress', 'completed'],
    ];

    for (const [from, to] of fieldExecutionSteps) {
      // Worker can perform
      assert.equal(canTransitionJob(from, to, 'worker'), true);
      // Owner CANNOT perform
      assert.equal(canTransitionJob(from, to, 'owner'), false, `Owner must not be allowed to perform ${from} -> ${to}`);
    }
  });

  test('Role segregation: worker cannot assign, reassign, or cancel jobs', () => {
    // Worker cannot assign or reassign
    assert.equal(canTransitionJob('unassigned', 'assigned', 'worker'), false);
    assert.equal(canTransitionJob('assigned', 'assigned', 'worker'), false);

    // Worker cannot cancel any job
    for (const status of JOB_STATUSES) {
      assert.equal(canTransitionJob(status, 'cancelled', 'worker'), false);
    }
  });

  test('Decline and cancellation semantics remain explicit and auditable', () => {
    // Worker decline
    assert.equal(canTransitionJob('assigned', 'unassigned', 'worker'), true);
    assert.equal(JOB_ACTIONS.decline_assignment.requiresReason, true);
    assert.equal(JOB_ACTIONS.decline_assignment.targetStatus, 'unassigned');

    // Owner cancellation
    for (const status of ['unassigned', 'assigned', 'accepted', 'on_the_way', 'arrived', 'in_progress']) {
      assert.equal(canTransitionJob(status, 'cancelled', 'owner'), true);
    }
    assert.equal(JOB_ACTIONS.cancel_job.requiresReason, true);
    assert.equal(JOB_ACTIONS.cancel_job.isTerminal, true);
    assert.equal(JOB_ACTIONS.cancel_job.targetStatus, 'cancelled');
  });

  test('Cross-screen consistency: status categorization is consistent across all views', () => {
    // Both worker Today hero and Owner Dashboard active metrics consider active statuses identical
    assert.deepEqual([...ACTIVE_JOB_STATUSES], ['on_the_way', 'arrived', 'in_progress']);

    // Terminal statuses consistent
    assert.deepEqual([...TERMINAL_JOB_STATUSES], ['completed', 'cancelled']);

    // Upcoming queue statuses consistent
    assert.deepEqual([...UPCOMING_JOB_STATUSES], ['unassigned', 'assigned', 'accepted']);
  });
});




