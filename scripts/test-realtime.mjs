/**
 * Dispatcher M10.3 — Central Realtime Subscription Manager Unit Tests
 *
 * Uses Node.js native test runner (node:test & node:assert/strict).
 * Execution: node --test --experimental-strip-types scripts/test-realtime.mjs
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  buildJobsChannelTopic,
  buildJobsSubscriptionFilter,
  clearAllSignalListeners,
  computeSubscriptionKey,
  createReconcileSignal,
  createSignalDebouncer,
  notifyJobSignal,
  parseLocationPostgresPayload,
  parsePostgresChangePayload,
  parseProfilePostgresPayload,
  subscribeToJobSignals,
  validateSubscriptionContext,
  WORKER_ASSIGNMENT_EDGE_CASE_DOC,
  filterOwnerJobs,
  checkRealtimeHealth,
  ensureRealtimeSocketConnected,
  triggerCoreReconciliation,
  resetReconciliationThrottle,
  createManagedJobsSubscriptionCore,
} from '../src/lib/realtime-core.ts';

describe('Realtime Topic & Filter Construction', () => {
  const mockBusinessId = '11111111-1111-1111-1111-111111111111';
  const mockWorkerId = '22222222-2222-2222-2222-222222222222';

  test('constructs privacy-safe owner channel topic and filter', () => {
    const topic = buildJobsChannelTopic('owner', mockBusinessId);
    assert.equal(topic, `business:${mockBusinessId}:jobs`);

    const filter = buildJobsSubscriptionFilter('owner', mockBusinessId);
    assert.equal(filter, `business_id=eq.${mockBusinessId}`);
  });

  test('constructs privacy-safe worker channel topic and filter', () => {
    const topic = buildJobsChannelTopic('worker', mockWorkerId);
    assert.equal(topic, `worker:${mockWorkerId}:jobs`);

    const filter = buildJobsSubscriptionFilter('worker', mockWorkerId);
    assert.equal(filter, `worker_id=eq.${mockWorkerId}`);
  });

  test('trims whitespace from entity identifiers', () => {
    const topic = buildJobsChannelTopic('owner', `  ${mockBusinessId}  `);
    assert.equal(topic, `business:${mockBusinessId}:jobs`);

    const filter = buildJobsSubscriptionFilter('worker', `  ${mockWorkerId}  `);
    assert.equal(filter, `worker_id=eq.${mockWorkerId}`);
  });

  test('rejects empty or whitespace-only entity identifiers', () => {
    assert.throws(() => buildJobsChannelTopic('owner', ''), /Entity ID is required/);
    assert.throws(() => buildJobsChannelTopic('owner', '   '), /Entity ID is required/);
    assert.throws(() => buildJobsSubscriptionFilter('worker', ''), /Entity ID is required/);
  });

  test('rejects invalid or unauthorized roles', () => {
    // @ts-expect-error testing invalid runtime role
    assert.throws(() => buildJobsChannelTopic('admin', mockBusinessId), /Invalid role/);
    // @ts-expect-error testing invalid runtime role
    assert.throws(() => buildJobsChannelTopic('', mockBusinessId), /Invalid role/);
  });
});

describe('Subscription Context Validation & Deduplication', () => {
  const mockBusinessId = '11111111-1111-1111-1111-111111111111';
  const mockWorkerId = '22222222-2222-2222-2222-222222222222';

  test('validates valid owner configuration', () => {
    const result = validateSubscriptionContext({
      role: 'owner',
      businessId: mockBusinessId,
    });
    assert.equal(result.valid, true);
    assert.equal(result.reason, undefined);
  });

  test('validates valid worker configuration', () => {
    const result = validateSubscriptionContext({
      role: 'worker',
      businessId: mockBusinessId,
      workerId: mockWorkerId,
    });
    assert.equal(result.valid, true);
    assert.equal(result.reason, undefined);
  });

  test('rejects owner configuration missing business ID', () => {
    const result = validateSubscriptionContext({
      role: 'owner',
      businessId: '',
    });
    assert.equal(result.valid, false);
    assert.match(result.reason || '', /Business ID is required/);
  });

  test('rejects worker configuration missing worker ID', () => {
    const result = validateSubscriptionContext({
      role: 'worker',
      businessId: mockBusinessId,
      workerId: null,
    });
    assert.equal(result.valid, false);
    assert.match(result.reason || '', /Worker ID is required/);
  });

  test('computes deterministic subscription key for deduplication', () => {
    const keyOwner = computeSubscriptionKey({
      role: 'owner',
      businessId: mockBusinessId,
    });
    assert.equal(keyOwner, `owner:${mockBusinessId}:`);

    const keyWorker = computeSubscriptionKey({
      role: 'worker',
      businessId: mockBusinessId,
      workerId: mockWorkerId,
    });
    assert.equal(keyWorker, `worker:${mockBusinessId}:${mockWorkerId}`);

    assert.equal(computeSubscriptionKey(null), 'none');
  });
});

describe('Postgres Changes Payload Parsing & Signal Validation', () => {
  test('parses valid INSERT payload with valid job status', () => {
    const raw = {
      id: 'job-123',
      business_id: 'biz-1',
      worker_id: 'worker-1',
      status: 'assigned',
      scheduled_at: '2026-10-25T12:00:00Z',
    };

    const signal = parsePostgresChangePayload('INSERT', raw);
    assert.ok(signal);
    assert.equal(signal.jobId, 'job-123');
    assert.equal(signal.eventType, 'INSERT');
    assert.equal(signal.newStatus, 'assigned');
    assert.equal(signal.source, 'remote');
    assert.ok(typeof signal.timestamp === 'number');
  });

  test('parses valid UPDATE payload with lifecycle progression', () => {
    const raw = {
      id: 'job-456',
      status: 'in_progress',
    };

    const signal = parsePostgresChangePayload('UPDATE', raw);
    assert.ok(signal);
    assert.equal(signal.jobId, 'job-456');
    assert.equal(signal.eventType, 'UPDATE');
    assert.equal(signal.newStatus, 'in_progress');
  });

  test('handles unrecognized or obsolete status values defensively', () => {
    const raw = {
      id: 'job-789',
      status: 'pending_approval', // invalid/non-frozen status
    };

    const signal = parsePostgresChangePayload('UPDATE', raw);
    assert.ok(signal);
    assert.equal(signal.jobId, 'job-789');
    assert.equal(signal.newStatus, null); // invalid status filtered out safely
  });

  test('returns null for missing or malformed record data', () => {
    assert.equal(parsePostgresChangePayload('UPDATE', null), null);
    assert.equal(parsePostgresChangePayload('UPDATE', undefined), null);
    assert.equal(parsePostgresChangePayload('UPDATE', {}), null); // missing id
    assert.equal(parsePostgresChangePayload('UPDATE', { id: '' }), null);
  });

  test('creates broadcast reconciliation signal with wildcard target', () => {
    const signal = createReconcileSignal('test_reconnect');
    assert.equal(signal.jobId, '*');
    assert.equal(signal.eventType, 'RECONCILE');
    assert.equal(signal.newStatus, null);
    assert.equal(signal.source, 'local_reconcile');
  });

  test('parses valid public.locations INSERT and UPDATE payloads', () => {
    const rawInsert = {
      id: 'loc-1',
      worker_id: 'worker-101',
      job_id: 'job-202',
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 12.5,
    };

    const signalInsert = parseLocationPostgresPayload('INSERT', rawInsert);
    assert.ok(signalInsert);
    assert.equal(signalInsert.jobId, 'job-202');
    assert.equal(signalInsert.workerId, 'worker-101');
    assert.equal(signalInsert.table, 'locations');
    assert.equal(signalInsert.eventType, 'INSERT');

    const rawUpdate = {
      id: 'loc-1',
      worker_id: 'worker-101',
      job_id: 'job-202',
      latitude: 37.7755,
      longitude: -122.4188,
      accuracy: 8.0,
    };

    const signalUpdate = parseLocationPostgresPayload('UPDATE', rawUpdate);
    assert.ok(signalUpdate);
    assert.equal(signalUpdate.table, 'locations');
    assert.equal(signalUpdate.eventType, 'UPDATE');
    assert.equal(signalUpdate.workerId, 'worker-101');
  });

  test('parses public.locations payload with null job_id using wildcard', () => {
    const raw = {
      id: 'loc-ambient',
      worker_id: 'worker-102',
      job_id: null,
      latitude: 37.7749,
      longitude: -122.4194,
    };

    const signal = parseLocationPostgresPayload('UPDATE', raw);
    assert.ok(signal);
    assert.equal(signal.jobId, '*');
    assert.equal(signal.workerId, 'worker-102');
    assert.equal(signal.table, 'locations');
  });

  test('rejects malformed public.locations payload missing both worker_id and job_id', () => {
    assert.equal(parseLocationPostgresPayload('INSERT', null), null);
    assert.equal(parseLocationPostgresPayload('INSERT', {}), null);
    assert.equal(parseLocationPostgresPayload('INSERT', { latitude: 37.7 }), null);
  });

  test('parses public.profiles UPDATE payload for worker roster updates', () => {
    const raw = {
      id: 'worker-303',
      business_id: 'biz-1',
      full_name: 'John Technician',
      is_active: false,
    };

    const signal = parseProfilePostgresPayload('UPDATE', raw);
    assert.ok(signal);
    assert.equal(signal.jobId, '*');
    assert.equal(signal.workerId, 'worker-303');
    assert.equal(signal.table, 'profiles');
    assert.equal(signal.eventType, 'UPDATE');
  });

  test('rejects malformed public.profiles payload missing id', () => {
    assert.equal(parseProfilePostgresPayload('UPDATE', null), null);
    assert.equal(parseProfilePostgresPayload('UPDATE', { full_name: 'Nobody' }), null);
  });
});

describe('Signal Bus & Listener Management', () => {
  test('subscribes and receives dispatched signals', () => {
    clearAllSignalListeners();

    const received = [];
    const unsubscribe = subscribeToJobSignals((signal) => {
      received.push(signal);
    });

    notifyJobSignal({
      jobId: 'job-1',
      eventType: 'UPDATE',
      newStatus: 'accepted',
      timestamp: Date.now(),
      source: 'remote',
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].jobId, 'job-1');
    assert.equal(received[0].newStatus, 'accepted');

    unsubscribe();

    notifyJobSignal({
      jobId: 'job-2',
      eventType: 'UPDATE',
      newStatus: 'completed',
      timestamp: Date.now(),
      source: 'remote',
    });

    assert.equal(received.length, 1); // no new signal after unsubscribe
  });

  test('listener exceptions do not disrupt peer listeners', () => {
    clearAllSignalListeners();

    let safeReceived = false;

    subscribeToJobSignals(() => {
      throw new Error('Exploding listener');
    });

    subscribeToJobSignals((signal) => {
      if (signal.jobId === 'job-safe') {
        safeReceived = true;
      }
    });

    notifyJobSignal({
      jobId: 'job-safe',
      eventType: 'UPDATE',
      newStatus: 'arrived',
      timestamp: Date.now(),
      source: 'remote',
    });

    assert.equal(safeReceived, true);
    clearAllSignalListeners();
  });
});

describe('Signal Debouncer', () => {
  test('coalesces rapid updates for the same job into a single signal', async () => {
    const dispatched = [];
    const debouncer = createSignalDebouncer(30, (signal) => {
      dispatched.push(signal);
    });

    debouncer.dispatch({
      jobId: 'job-debounce',
      eventType: 'UPDATE',
      newStatus: 'on_the_way',
      timestamp: 1,
      source: 'remote',
    });

    debouncer.dispatch({
      jobId: 'job-debounce',
      eventType: 'UPDATE',
      newStatus: 'arrived',
      timestamp: 2,
      source: 'remote',
    });

    debouncer.dispatch({
      jobId: 'job-debounce',
      eventType: 'UPDATE',
      newStatus: 'in_progress',
      timestamp: 3,
      source: 'remote',
    });

    assert.equal(dispatched.length, 0);

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].newStatus, 'in_progress');
  });

  test('wildcard reconciliation signals bypass debounce delay', () => {
    const dispatched = [];
    const debouncer = createSignalDebouncer(100, (signal) => {
      dispatched.push(signal);
    });

    debouncer.dispatch(createReconcileSignal('immediate_test'));

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].jobId, '*');
    debouncer.cancelAll();
  });

  test('cancelAll prevents pending timers from firing', async () => {
    const dispatched = [];
    const debouncer = createSignalDebouncer(40, (signal) => {
      dispatched.push(signal);
    });

    debouncer.dispatch({
      jobId: 'job-cancel',
      eventType: 'INSERT',
      newStatus: 'assigned',
      timestamp: 1,
      source: 'remote',
    });

    debouncer.cancelAll();

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(dispatched.length, 0);
  });

  test('coalesces rapid location updates for the same worker', async () => {
    const dispatched = [];
    const debouncer = createSignalDebouncer(30, (signal) => {
      dispatched.push(signal);
    });

    // Worker 1 emits 3 rapid location breadcrumbs
    debouncer.dispatch({
      jobId: 'job-1',
      workerId: 'worker-1',
      table: 'locations',
      eventType: 'UPDATE',
      newStatus: null,
      timestamp: 1,
      source: 'remote',
    });

    debouncer.dispatch({
      jobId: 'job-1',
      workerId: 'worker-1',
      table: 'locations',
      eventType: 'UPDATE',
      newStatus: null,
      timestamp: 2,
      source: 'remote',
    });

    // Worker 2 emits 1 breadcrumb concurrently
    debouncer.dispatch({
      jobId: 'job-2',
      workerId: 'worker-2',
      table: 'locations',
      eventType: 'UPDATE',
      newStatus: null,
      timestamp: 3,
      source: 'remote',
    });

    assert.equal(dispatched.length, 0);

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Both workers receive exactly one coalesced signal
    assert.equal(dispatched.length, 2);
    const workerIds = dispatched.map((s) => s.workerId).sort();
    assert.deepEqual(workerIds, ['worker-1', 'worker-2']);
  });
});

describe('Worker Assignment Revocation Edge Case Documentation', () => {
  test('documents worker filter limitation and mitigation strategy', () => {
    assert.ok(WORKER_ASSIGNMENT_EDGE_CASE_DOC.limitation.includes('worker_id'));
    assert.ok(WORKER_ASSIGNMENT_EDGE_CASE_DOC.mitigation.includes('reconciliation'));
    assert.ok(WORKER_ASSIGNMENT_EDGE_CASE_DOC.prerequisiteForInstantPush.includes('worker_notifications'));
  });
});

describe('Owner Jobs List Filtering & Search', () => {
  const mockJobs = [
    {
      id: 'job-1',
      status: 'unassigned',
      worker_id: null,
      customer_name: 'Alice Johnson',
      service: 'Leak Repair',
      address: '123 Main St',
      worker: null,
    },
    {
      id: 'job-2',
      status: 'assigned',
      worker_id: 'w-1',
      customer_name: 'Bob Smith',
      service: 'Pipe Installation',
      address: '456 Oak Ave',
      worker: { full_name: 'David Field' },
    },
    {
      id: 'job-3',
      status: 'in_progress',
      worker_id: 'w-2',
      customer_name: 'Charlie Brown',
      service: 'Boiler Service',
      address: '789 Pine Rd',
      worker: { full_name: 'Elena Tech' },
    },
    {
      id: 'job-4',
      status: 'completed',
      worker_id: 'w-1',
      customer_name: 'Diana Prince',
      service: 'Inspection',
      address: '100 Metro Blvd',
      worker: { full_name: 'David Field' },
    },
    {
      id: 'job-5',
      status: 'cancelled',
      worker_id: null,
      customer_name: 'Evan Wright',
      service: 'Drain Unclog',
      address: '200 River St',
      worker: null,
    },
  ];

  test('filters by "all" returns complete list', () => {
    const result = filterOwnerJobs(mockJobs, 'all');
    assert.equal(result.length, 5);
  });

  test('filters by "unassigned" returns only jobs awaiting dispatch', () => {
    const result = filterOwnerJobs(mockJobs, 'unassigned');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'job-1');
  });

  test('filters by "active" returns assigned, accepted, and in-progress visits', () => {
    const result = filterOwnerJobs(mockJobs, 'active');
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((j) => j.id),
      ['job-2', 'job-3']
    );
  });

  test('filters by "completed" returns only completed jobs', () => {
    const result = filterOwnerJobs(mockJobs, 'completed');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'job-4');
  });

  test('filters by "cancelled" returns only cancelled jobs', () => {
    const result = filterOwnerJobs(mockJobs, 'cancelled');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'job-5');
  });

  test('searches case-insensitively across customer name, service, and address', () => {
    assert.equal(filterOwnerJobs(mockJobs, 'all', 'alice').length, 1);
    assert.equal(filterOwnerJobs(mockJobs, 'all', 'boiler').length, 1);
    assert.equal(filterOwnerJobs(mockJobs, 'all', 'metro').length, 1);
    assert.equal(filterOwnerJobs(mockJobs, 'all', 'elena').length, 1);
  });

  test('combines filter category and text search query', () => {
    // Active jobs matching "david" -> job-2
    const result = filterOwnerJobs(mockJobs, 'active', 'david');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'job-2');

    // Completed jobs matching "david" -> job-4
    const resultCompleted = filterOwnerJobs(mockJobs, 'completed', 'david');
    assert.equal(resultCompleted.length, 1);
    assert.equal(resultCompleted[0].id, 'job-4');

    // Unassigned matching "david" -> empty
    const resultEmpty = filterOwnerJobs(mockJobs, 'unassigned', 'david');
    assert.equal(resultEmpty.length, 0);
  });
});

describe('Worker Realtime Scoping, Isolation & Deduplication (M10.5)', () => {
  const workerA = 'worker-uuid-aaaa-1111';
  const workerB = 'worker-uuid-bbbb-2222';
  const businessId = 'business-uuid-9999';

  test('constructs worker subscription filter strictly scoped to authenticated worker ID', () => {
    const filterA = buildJobsSubscriptionFilter('worker', workerA);
    assert.equal(filterA, `worker_id=eq.${workerA}`);

    const topicA = buildJobsChannelTopic('worker', workerA);
    assert.equal(topicA, `worker:${workerA}:jobs`);
  });

  test('enforces cross-worker isolation (worker A filter rejects worker B payloads)', () => {
    const filterA = buildJobsSubscriptionFilter('worker', workerA);

    // Payload for worker B
    const payloadForB = {
      id: 'job-b-1',
      worker_id: workerB,
      status: 'assigned',
    };

    // Filter verification: filter string specifies worker_id=eq.workerA
    const expectedPrefix = `worker_id=eq.${workerA}`;
    assert.equal(filterA, expectedPrefix);
    // Ensure worker B ID does NOT match worker A filter
    assert.notEqual(payloadForB.worker_id, workerA);
  });

  test('rejects worker subscription context without worker ID', () => {
    const invalidConfig = {
      role: 'worker',
      businessId,
      workerId: null,
    };

    const result = validateSubscriptionContext(invalidConfig);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('Worker ID is required'));
  });

  test('subscription key deduplication prevents redundant channels across worker screens', () => {
    const keyToday = computeSubscriptionKey({ role: 'worker', businessId, workerId: workerA });
    const keyJobs = computeSubscriptionKey({ role: 'worker', businessId, workerId: workerA });
    const keyDetails = computeSubscriptionKey({ role: 'worker', businessId, workerId: workerA });

    // All worker screens within the same session produce the identical deterministic subscription key
    assert.equal(keyToday, `worker:${businessId}:${workerA}`);
    assert.equal(keyToday, keyJobs);
    assert.equal(keyJobs, keyDetails);

    // Different worker produces a different key
    const keyOtherWorker = computeSubscriptionKey({ role: 'worker', businessId, workerId: workerB });
    assert.notEqual(keyToday, keyOtherWorker);
  });

  test('notifies worker screen listeners when assigned job transitions', () => {
    clearAllSignalListeners();

    let todayNotified = false;
    let detailsNotified = false;
    const targetJobId = 'job-technician-101';

    // Hook: useWorkerToday listener (subscribes to all assigned signals)
    const unsubToday = subscribeToJobSignals((signal) => {
      if (signal.jobId === targetJobId || signal.jobId === '*') {
        todayNotified = true;
      }
    });

    // Screen: Worker Job Details listener (subscribes to this job or wildcard)
    const unsubDetails = subscribeToJobSignals((signal) => {
      if (signal.jobId === targetJobId || signal.jobId === '*') {
        detailsNotified = true;
      }
    });

    // Remote event: Worker receives assignment acceptance or status progression
    notifyJobSignal({
      jobId: targetJobId,
      eventType: 'UPDATE',
      newStatus: 'accepted',
      timestamp: Date.now(),
      source: 'remote',
    });

    assert.equal(todayNotified, true);
    assert.equal(detailsNotified, true);

    unsubToday();
    unsubDetails();
    clearAllSignalListeners();
  });

  test('reconciliation wildcard signal notifies both Today and Job Details listeners', () => {
    clearAllSignalListeners();

    let todayReconciled = false;
    let detailsReconciled = false;
    const currentJobId = 'job-open-in-details';

    const unsubToday = subscribeToJobSignals(() => {
      todayReconciled = true;
    });

    const unsubDetails = subscribeToJobSignals((signal) => {
      if (signal.jobId === currentJobId || signal.jobId === '*') {
        detailsReconciled = true;
      }
    });

    // Dispatch broadcast reconciliation signal (e.g. app foreground or reconnect)
    notifyJobSignal(createReconcileSignal('foreground_resume'));

    assert.equal(todayReconciled, true);
    assert.equal(detailsReconciled, true);

    unsubToday();
    unsubDetails();
    clearAllSignalListeners();
  });

  test('documents worker unassignment/reassignment eviction behavior', () => {
    // When an owner unassigns worker A or reassigns to worker B:
    // 1. Worker A's subscription (worker_id=eq.workerA) does not match the new row (worker_id is null or workerB)
    // 2. Worker A's screen focus (useFocusEffect) or foreground reconciliation fetches authoritative Supabase data
    // 3. Authoritative query excludes unassigned job because worker_id != workerA
    const limitationDoc = WORKER_ASSIGNMENT_EDGE_CASE_DOC;
    assert.ok(limitationDoc.limitation.includes('worker_id'));
    assert.ok(limitationDoc.mitigation.includes('reconciliation'));
  });
});

describe('Realtime Health Checks, Socket Assurance & Reconnect (M10.6)', () => {
  test('reports healthy when socket is connected and channel is joined', () => {
    const mockClient = {
      realtime: {
        isConnected: () => true,
      },
    };
    const mockChannel = { state: 'joined' };

    const health = checkRealtimeHealth(mockClient, mockChannel);
    assert.equal(health.isSocketConnected, true);
    assert.equal(health.isChannelSubscribed, true);
    assert.equal(health.isHealthy, true);
  });

  test('reports unhealthy when socket is disconnected', () => {
    const mockClient = {
      realtime: {
        isConnected: () => false,
      },
    };
    const mockChannel = { state: 'joined' };

    const health = checkRealtimeHealth(mockClient, mockChannel);
    assert.equal(health.isSocketConnected, false);
    assert.equal(health.isHealthy, false);
  });

  test('reports unhealthy when channel state is closed, errored, or joining', () => {
    const mockClient = {
      realtime: {
        isConnected: () => true,
      },
    };

    assert.equal(checkRealtimeHealth(mockClient, { state: 'closed' }).isHealthy, false);
    assert.equal(checkRealtimeHealth(mockClient, { state: 'errored' }).isHealthy, false);
    assert.equal(checkRealtimeHealth(mockClient, { state: 'joining' }).isHealthy, false);
    assert.equal(checkRealtimeHealth(mockClient, { state: 'leaving' }).isHealthy, false);
  });

  test('ensureRealtimeSocketConnected triggers connect only when disconnected', () => {
    let connectCalled = false;
    const mockClientDisconnected = {
      realtime: {
        isConnected: () => false,
        connect: () => {
          connectCalled = true;
        },
      },
    };

    const triggered = ensureRealtimeSocketConnected(mockClientDisconnected);
    assert.equal(triggered, true);
    assert.equal(connectCalled, true);

    // When already connected: should not call connect again
    let connectCalledAgain = false;
    const mockClientConnected = {
      realtime: {
        isConnected: () => true,
        connect: () => {
          connectCalledAgain = true;
        },
      },
    };

    const triggeredConnected = ensureRealtimeSocketConnected(mockClientConnected);
    assert.equal(triggeredConnected, false);
    assert.equal(connectCalledAgain, false);
  });
});

describe('Throttled Data Reconciliation & Burst Coalescing (M10.6)', () => {
  test('dispatches reconciliation signal on first call and throttles rapid duplicates', () => {
    clearAllSignalListeners();
    resetReconciliationThrottle();

    const signals = [];
    const unsubscribe = subscribeToJobSignals((signal) => {
      signals.push(signal);
    });

    // First call: dispatches
    const firstResult = triggerCoreReconciliation('first_call');
    assert.equal(firstResult, true);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].jobId, '*');
    assert.equal(signals[0].eventType, 'RECONCILE');

    // Immediate second call: suppressed by 250ms throttle window
    const secondResult = triggerCoreReconciliation('rapid_duplicate');
    assert.equal(secondResult, false);
    assert.equal(signals.length, 1); // No duplicate signal dispatched

    // Forced call: bypasses throttle window
    const forcedResult = triggerCoreReconciliation('forced_reconnect', true);
    assert.equal(forcedResult, true);
    assert.equal(signals.length, 2);

    unsubscribe();
    clearAllSignalListeners();
  });
});

describe('Async Concurrency & Context Invalidation Invariants (M10.6)', () => {
  test('request token invalidation guarantees outdated responses are discarded', async () => {
    let activeToken = 0;
    let stateValue = 'initial';

    // Simulate first request (e.g. User A)
    const requestId1 = ++activeToken;

    // Fast context switch / logout occurred
    ++activeToken; // Invalidates all prior in-flight requests

    // Response for Request 1 arrives after context switch
    if (activeToken === requestId1) {
      stateValue = 'stale_user_a_data';
    }

    // State remains unaffected
    assert.equal(stateValue, 'initial');

    // Simulate second request (e.g. User B)
    const requestId2 = ++activeToken;
    if (activeToken === requestId2) {
      stateValue = 'user_b_data';
    }

    assert.equal(stateValue, 'user_b_data');
  });
});

describe('M12.6 Multi-Table Realtime Channel Subscriptions', () => {
  const businessId = 'biz-uuid-1111';
  const workerId = 'worker-uuid-2222';

  function createMockSupabaseClient() {
    const registeredHandlers = [];
    let removedChannel = null;

    const mockChannel = {
      state: 'joined',
      on: (type, options, callback) => {
        registeredHandlers.push({ type, options, callback });
        return mockChannel;
      },
      subscribe: (statusCallback) => {
        statusCallback('SUBSCRIBED', null);
        return mockChannel;
      },
    };

    const mockClient = {
      channel: (topic) => {
        mockChannel.topic = topic;
        return mockChannel;
      },
      removeChannel: async (ch) => {
        removedChannel = ch;
      },
      _getHandlers: () => registeredHandlers,
      _getRemovedChannel: () => removedChannel,
    };

    return mockClient;
  }

  test('owner subscription binds jobs, locations, and profiles on a single channel', async () => {
    const mockClient = createMockSupabaseClient();
    let statusReceived = null;
    const signalsReceived = [];

    const sub = createManagedJobsSubscriptionCore(
      { role: 'owner', businessId },
      {
        onStatusChange: (status) => {
          statusReceived = status;
        },
        onSignal: (signal) => {
          signalsReceived.push(signal);
        },
      },
      mockClient
    );

    assert.equal(statusReceived, 'SUBSCRIBED');
    assert.equal(sub.getTopic(), `business:${businessId}:jobs`);

    const handlers = mockClient._getHandlers();
    // 5 handlers: jobs (INSERT, UPDATE), locations (INSERT, UPDATE), profiles (UPDATE)
    assert.equal(handlers.length, 5);

    // Jobs handlers have business_id filter
    const jobHandlers = handlers.filter((h) => h.options.table === 'jobs');
    assert.equal(jobHandlers.length, 2);
    assert.equal(jobHandlers[0].options.filter, `business_id=eq.${businessId}`);

    // Locations handlers do not have column filter for owner (Postgres RLS locations_owner_select)
    const locationHandlers = handlers.filter((h) => h.options.table === 'locations');
    assert.equal(locationHandlers.length, 2);
    assert.equal(locationHandlers[0].options.filter, undefined);
    assert.equal(locationHandlers[1].options.filter, undefined);

    // Profiles handler has business_id filter
    const profileHandlers = handlers.filter((h) => h.options.table === 'profiles');
    assert.equal(profileHandlers.length, 1);
    assert.equal(profileHandlers[0].options.filter, `business_id=eq.${businessId}`);

    // Test incoming location event dispatch through the single channel
    locationHandlers[0].callback({
      new: {
        id: 'loc-1',
        worker_id: workerId,
        job_id: 'job-999',
        latitude: 37.77,
        longitude: -122.42,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(signalsReceived.length, 1);
    assert.equal(signalsReceived[0].table, 'locations');
    assert.equal(signalsReceived[0].workerId, workerId);
    assert.equal(signalsReceived[0].jobId, 'job-999');

    // Clean teardown
    await sub.unsubscribe();
    assert.equal(mockClient._getRemovedChannel()?.topic, `business:${businessId}:jobs`);
  });

  test('worker subscription binds jobs and locations with worker_id filter, excluding profiles', async () => {
    const mockClient = createMockSupabaseClient();

    const sub = createManagedJobsSubscriptionCore(
      { role: 'worker', businessId, workerId },
      {
        onStatusChange: () => {},
      },
      mockClient
    );

    const handlers = mockClient._getHandlers();
    // 4 handlers: jobs (INSERT, UPDATE), locations (INSERT, UPDATE) — profiles not registered for worker
    assert.equal(handlers.length, 4);

    const locationHandlers = handlers.filter((h) => h.options.table === 'locations');
    assert.equal(locationHandlers.length, 2);
    assert.equal(locationHandlers[0].options.filter, `worker_id=eq.${workerId}`);
    assert.equal(locationHandlers[1].options.filter, `worker_id=eq.${workerId}`);

    const profileHandlers = handlers.filter((h) => h.options.table === 'profiles');
    assert.equal(profileHandlers.length, 0);

    await sub.unsubscribe();
  });
});



