/**
 * Dispatcher M12.3 — Owner Live Map Data Service Unit Tests
 *
 * Execution: node --test --experimental-strip-types scripts/test-owner-live-map.mjs
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  buildOwnerLiveMapData,
  buildOwnerLiveMapWorkerItem,
  composeOwnerLiveMapData,
  findWorkerMapItemById,
  getMapLifecycleStatusLabel,
  isWorkerLocationStale,
  MAP_STATUS_COLORS,
} from '../src/lib/owner-locations-core.ts';

describe('M12.3 Owner Live Map Item Builder & Status Classification', () => {
  const nowMs = 1700000000000;

  const baseWorker = {
    id: 'worker-1',
    full_name: 'Alice Tech',
    avatar_url: 'https://example.com/avatar.jpg',
    phone: '+15551234567',
    is_active: true,
  };

  const activeJob = {
    id: 'job-101',
    service: 'HVAC Diagnostics',
    address: '100 Main St, San Francisco, CA',
    status: 'on_the_way',
    latitude: 37.7749,
    longitude: -122.4194,
  };

  test('classifies fresh fix on active field job as LIVE and marker-eligible', () => {
    const freshLocation = {
      id: 'loc-1',
      latitude: 37.7849,
      longitude: -122.4194,
      accuracy: 12.0,
      created_at: new Date(nowMs - 30000).toISOString(), // 30s ago
    };

    const item = buildOwnerLiveMapWorkerItem({
      worker: baseWorker,
      job: activeJob,
      location: freshLocation,
      nowMs,
    });

    assert.equal(item.workerId, 'worker-1');
    assert.equal(item.workerName, 'Alice Tech');
    assert.equal(item.jobId, 'job-101');
    assert.equal(item.positionStatus, 'LIVE');
    assert.equal(item.isEligibleForLiveMarker, true);
    assert.equal(item.isLive, true);
    assert.equal(item.isStale, false);
    assert.equal(item.isInaccurate, false);
    assert.equal(item.workerLatitude, 37.7849);
    assert.equal(item.workerLongitude, -122.4194);
    assert.ok(item.distanceToDestinationMeters > 1000 && item.distanceToDestinationMeters < 1200);
    assert.match(item.freshnessLabel, /updated 30s ago/i);
  });

  test('classifies telemetry older than 5m as STALE but still marker-eligible', () => {
    const staleLocation = {
      id: 'loc-1',
      latitude: 37.7849,
      longitude: -122.4194,
      accuracy: 15.0,
      created_at: new Date(nowMs - 360000).toISOString(), // 6m ago (>5m)
    };

    const item = buildOwnerLiveMapWorkerItem({
      worker: baseWorker,
      job: activeJob,
      location: staleLocation,
      nowMs,
    });

    assert.equal(item.positionStatus, 'STALE');
    assert.equal(item.isEligibleForLiveMarker, true);
    assert.equal(item.isLive, false);
    assert.equal(item.isStale, true);
    assert.match(item.freshnessLabel, /stale/i);
  });

  test('classifies accuracy > 200m as LOW_ACCURACY but still marker-eligible', () => {
    const inaccurateLocation = {
      id: 'loc-1',
      latitude: 37.7849,
      longitude: -122.4194,
      accuracy: 250.0,
      created_at: new Date(nowMs - 45000).toISOString(),
    };

    const item = buildOwnerLiveMapWorkerItem({
      worker: baseWorker,
      job: activeJob,
      location: inaccurateLocation,
      nowMs,
    });

    assert.equal(item.positionStatus, 'LOW_ACCURACY');
    assert.equal(item.isEligibleForLiveMarker, true);
    assert.equal(item.isLive, false);
    assert.equal(item.isInaccurate, true);
    assert.match(item.freshnessLabel, /low accuracy/i);
  });

  test('active field job without recorded location yields NO_FIX without fallback coordinates', () => {
    const item = buildOwnerLiveMapWorkerItem({
      worker: baseWorker,
      job: activeJob,
      location: null,
      nowMs,
    });

    assert.equal(item.positionStatus, 'NO_FIX');
    assert.equal(item.isEligibleForLiveMarker, false);
    assert.equal(item.isLive, false);
    assert.equal(item.workerLatitude, null);
    assert.equal(item.workerLongitude, null);
    assert.equal(item.distanceToDestinationMeters, null);
    assert.equal(item.freshnessLabel, 'Awaiting GPS fix');
  });

  test('active field job with invalid coordinates bounds yields NO_FIX', () => {
    const invalidCoordsLocation = {
      id: 'loc-1',
      latitude: 105.0, // invalid lat > 90
      longitude: -122.4194,
      accuracy: 10.0,
      created_at: new Date(nowMs - 10000).toISOString(),
    };

    const item = buildOwnerLiveMapWorkerItem({
      worker: baseWorker,
      job: activeJob,
      location: invalidCoordsLocation,
      nowMs,
    });

    assert.equal(item.positionStatus, 'NO_FIX');
    assert.equal(item.isEligibleForLiveMarker, false);
    assert.equal(item.workerLatitude, null);
    assert.equal(item.freshnessLabel, 'Invalid GPS fix');
  });

  test('upcoming job (accepted/assigned) is NOT_TRACKABLE even if location exists', () => {
    const upcomingJob = {
      id: 'job-102',
      service: 'Leak Inspection',
      address: '200 Pine St',
      status: 'accepted',
      latitude: 37.79,
      longitude: -122.40,
    };

    const item = buildOwnerLiveMapWorkerItem({
      worker: baseWorker,
      job: upcomingJob,
      location: null,
      nowMs,
    });

    assert.equal(item.positionStatus, 'NOT_TRACKABLE');
    assert.equal(item.isEligibleForLiveMarker, false);
    assert.equal(item.workerLatitude, null);
    assert.equal(item.freshnessLabel, 'Scheduled (not travelling yet)');
  });

  test('idle worker without job is NOT_TRACKABLE', () => {
    const item = buildOwnerLiveMapWorkerItem({
      worker: baseWorker,
      job: null,
      location: null,
      nowMs,
    });

    assert.equal(item.positionStatus, 'NOT_TRACKABLE');
    assert.equal(item.isEligibleForLiveMarker, false);
    assert.equal(item.freshnessLabel, 'No active assignments');
  });

  test('inactive worker profile yields INACTIVE status', () => {
    const inactiveWorker = {
      ...baseWorker,
      is_active: false,
    };

    const item = buildOwnerLiveMapWorkerItem({
      worker: inactiveWorker,
      job: activeJob,
      location: null,
      nowMs,
    });

    assert.equal(item.positionStatus, 'INACTIVE');
    assert.equal(item.isEligibleForLiveMarker, false);
    assert.equal(item.freshnessLabel, 'Inactive account');
  });
});

describe('M12.3 Composite View Model & Summary Metrics', () => {
  test('partitions items into activeMarkers vs untrackedWorkers and computes truthful metrics', () => {
    const items = [
      // 1. Live Marker (en route)
      {
        workerId: 'w1',
        workerName: 'Worker 1',
        workerAvatarUrl: null,
        workerPhone: null,
        isActive: true,
        jobId: 'j1',
        jobService: 'HVAC',
        jobAddress: 'Address 1',
        jobStatus: 'on_the_way',
        destinationLatitude: 37.7,
        destinationLongitude: -122.4,
        locationId: 'l1',
        workerLatitude: 37.71,
        workerLongitude: -122.41,
        accuracy: 10,
        recordedAt: new Date().toISOString(),
        positionStatus: 'LIVE',
        isEligibleForLiveMarker: true,
        isLive: true,
        isStale: false,
        isInaccurate: false,
        distanceToDestinationMeters: 500,
        freshnessLabel: 'Updated 20s ago',
      },
      // 2. Stale Marker (working on site)
      {
        workerId: 'w2',
        workerName: 'Worker 2',
        workerAvatarUrl: null,
        workerPhone: null,
        isActive: true,
        jobId: 'j2',
        jobService: 'Plumbing',
        jobAddress: 'Address 2',
        jobStatus: 'in_progress',
        destinationLatitude: 37.75,
        destinationLongitude: -122.45,
        locationId: 'l2',
        workerLatitude: 37.75,
        workerLongitude: -122.45,
        accuracy: 15,
        recordedAt: new Date(Date.now() - 400000).toISOString(),
        positionStatus: 'STALE',
        isEligibleForLiveMarker: true,
        isLive: false,
        isStale: true,
        isInaccurate: false,
        distanceToDestinationMeters: 0,
        freshnessLabel: 'Stale',
      },
      // 3. Active visit awaiting fix (no marker)
      {
        workerId: 'w3',
        workerName: 'Worker 3',
        workerAvatarUrl: null,
        workerPhone: null,
        isActive: true,
        jobId: 'j3',
        jobService: 'Electrical',
        jobAddress: 'Address 3',
        jobStatus: 'arrived',
        destinationLatitude: 37.8,
        destinationLongitude: -122.3,
        locationId: null,
        workerLatitude: null,
        workerLongitude: null,
        accuracy: null,
        recordedAt: null,
        positionStatus: 'NO_FIX',
        isEligibleForLiveMarker: false,
        isLive: false,
        isStale: false,
        isInaccurate: false,
        distanceToDestinationMeters: null,
        freshnessLabel: 'Awaiting GPS fix',
      },
      // 4. Idle worker
      {
        workerId: 'w4',
        workerName: 'Worker 4',
        workerAvatarUrl: null,
        workerPhone: null,
        isActive: true,
        jobId: null,
        jobService: null,
        jobAddress: null,
        jobStatus: null,
        destinationLatitude: null,
        destinationLongitude: null,
        locationId: null,
        workerLatitude: null,
        workerLongitude: null,
        accuracy: null,
        recordedAt: null,
        positionStatus: 'NOT_TRACKABLE',
        isEligibleForLiveMarker: false,
        isLive: false,
        isStale: false,
        isInaccurate: false,
        distanceToDestinationMeters: null,
        freshnessLabel: 'No active assignments',
      },
    ];

    const data = buildOwnerLiveMapData(items);

    assert.equal(data.workers.length, 4);
    assert.equal(data.activeMarkers.length, 2);
    assert.equal(data.untrackedWorkers.length, 2);

    assert.equal(data.summary.totalWorkers, 4);
    assert.equal(data.summary.activeOnDuty, 3); // w1, w2, w3
    assert.equal(data.summary.liveTracked, 1);
    assert.equal(data.summary.staleTracked, 1);
    assert.equal(data.summary.enRouteCount, 1);
    assert.equal(data.summary.onSiteCount, 2); // w2 (in_progress), w3 (arrived)
    assert.equal(data.summary.awaitingFixCount, 1);
    assert.equal(data.summary.idleCount, 1);
  });
});

describe('M12.3 Batched Query & Historical Location Safe Deduplication', () => {
  test('composeOwnerLiveMapData deduplicates historical location rows and prioritizes field visits', () => {
    const workerProfiles = [
      { id: 'w1', full_name: 'Worker 1', avatar_url: null, phone: null, is_active: true },
      { id: 'w2', full_name: 'Worker 2', avatar_url: null, phone: null, is_active: true },
      { id: 'w3', full_name: 'Worker 3', avatar_url: null, phone: null, is_active: true },
    ];

    // Worker 1 has an active visit AND a later accepted job
    const rawJobs = [
      {
        id: 'job-active-1',
        worker_id: 'w1',
        service: 'Emergency Repair',
        address: '123 Market St',
        status: 'on_the_way',
        latitude: 37.7749,
        longitude: -122.4194,
        scheduled_at: '2026-10-25T14:00:00Z',
      },
      {
        id: 'job-scheduled-later',
        worker_id: 'w1',
        service: 'Routine Checkup',
        address: '456 Mission St',
        status: 'accepted',
        latitude: 37.78,
        longitude: -122.40,
        scheduled_at: '2026-10-25T16:00:00Z',
      },
      // Worker 2 has only an upcoming scheduled job
      {
        id: 'job-upcoming-2',
        worker_id: 'w2',
        service: 'Drain Cleaning',
        address: '789 Castro St',
        status: 'assigned',
        latitude: 37.76,
        longitude: -122.43,
        scheduled_at: '2026-10-25T15:00:00Z',
      },
      // Worker 3 has an active visit (in_progress)
      {
        id: 'job-active-3',
        worker_id: 'w3',
        service: 'Water Heater Fix',
        address: '101 Bay St',
        status: 'in_progress',
        latitude: 37.80,
        longitude: -122.41,
        scheduled_at: null,
      },
    ];

    // Locations contains 2 historical rows for Worker 1
    const nowMs = 1700000000000;
    const rawLocations = [
      {
        id: 'loc-older',
        worker_id: 'w1',
        job_id: 'job-active-1',
        latitude: 37.7600,
        longitude: -122.4100,
        accuracy: 18.0,
        created_at: new Date(nowMs - 300000).toISOString(), // 5m ago
      },
      {
        id: 'loc-newest',
        worker_id: 'w1',
        job_id: 'job-active-1',
        latitude: 37.7700,
        longitude: -122.4150,
        accuracy: 10.0,
        created_at: new Date(nowMs - 20000).toISOString(), // 20s ago
      },
      // Worker 3 has a fresh on-site fix
      {
        id: 'loc-w3',
        worker_id: 'w3',
        job_id: 'job-active-3',
        latitude: 37.8000,
        longitude: -122.4100,
        accuracy: 8.0,
        created_at: new Date(nowMs - 45000).toISOString(),
      },
    ];

    const data = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs,
      rawLocations,
      options: { nowMs },
    });

    assert.equal(data.workers.length, 3);
    assert.equal(data.activeMarkers.length, 2); // w1, w3
    assert.equal(data.untrackedWorkers.length, 1); // w2

    // Worker 1 selected newest location (loc-newest) and prioritized active visit over accepted visit
    const w1 = data.workers.find((w) => w.workerId === 'w1');
    assert.ok(w1 !== undefined);
    assert.equal(w1.jobId, 'job-active-1');
    assert.equal(w1.locationId, 'loc-newest');
    assert.equal(w1.workerLatitude, 37.7700);
    assert.equal(w1.positionStatus, 'LIVE');
    assert.equal(w1.isLive, true);

    // Worker 2 has only assigned job: NOT_TRACKABLE, not on map
    const w2 = data.workers.find((w) => w.workerId === 'w2');
    assert.ok(w2 !== undefined);
    assert.equal(w2.positionStatus, 'NOT_TRACKABLE');
    assert.equal(w2.isEligibleForLiveMarker, false);
    assert.equal(w2.workerLatitude, null);

    // Worker 3 in_progress: LIVE
    const w3 = data.workers.find((w) => w.workerId === 'w3');
    assert.ok(w3 !== undefined);
    assert.equal(w3.positionStatus, 'LIVE');
    assert.equal(w3.jobStatus, 'in_progress');

    // Summary counts
    assert.equal(data.summary.totalWorkers, 3);
    assert.equal(data.summary.activeOnDuty, 2); // w1 (on_the_way), w3 (in_progress)
    assert.equal(data.summary.liveTracked, 2);
    assert.equal(data.summary.upcomingCount, 1); // w2
    assert.equal(data.summary.enRouteCount, 1);
    assert.equal(data.summary.onSiteCount, 1);
  });
});

describe('M12.4 Owner Live Map UI Mapping & Legend Consistency', () => {
  test('maps M9 lifecycle statuses accurately to human-readable UI labels', () => {
    assert.equal(getMapLifecycleStatusLabel('on_the_way'), 'Travelling');
    assert.equal(getMapLifecycleStatusLabel('arrived'), 'Arrived');
    assert.equal(getMapLifecycleStatusLabel('in_progress'), 'Working');
    assert.equal(getMapLifecycleStatusLabel('assigned'), 'Assigned');
    assert.equal(getMapLifecycleStatusLabel('accepted'), 'Accepted');
    assert.equal(getMapLifecycleStatusLabel('completed'), 'Completed');
    assert.equal(getMapLifecycleStatusLabel('cancelled'), 'Cancelled');
    assert.equal(getMapLifecycleStatusLabel('unassigned'), 'Unassigned');
    assert.equal(getMapLifecycleStatusLabel(null), 'Unknown');
  });

  test('provides restrained, accessible hex colors for live operational statuses', () => {
    assert.equal(MAP_STATUS_COLORS.on_the_way, '#1D4ED8'); // Blue (Travelling)
    assert.equal(MAP_STATUS_COLORS.arrived, '#0E7490');    // Teal (Arrived)
    assert.equal(MAP_STATUS_COLORS.in_progress, '#15803D'); // Green (Working)
  });

  test('marker filtering guarantees that stale or inaccurate coordinates are excluded from live map markers', () => {
    const rawItems = [
      {
        workerId: 'w-live',
        workerName: 'Bob Live',
        isLive: true,
        isStale: false,
        isInaccurate: false,
        workerLatitude: 37.7749,
        workerLongitude: -122.4194,
        jobStatus: 'on_the_way',
      },
      {
        workerId: 'w-stale',
        workerName: 'Sam Stale',
        isLive: false,
        isStale: true,
        isInaccurate: false,
        workerLatitude: 37.7849,
        workerLongitude: -122.4094,
        jobStatus: 'in_progress',
      },
      {
        workerId: 'w-nofix',
        workerName: 'Dan NoFix',
        isLive: false,
        isStale: false,
        isInaccurate: false,
        workerLatitude: null,
        workerLongitude: null,
        jobStatus: 'arrived',
      },
      {
        workerId: 'w-inaccurate',
        workerName: 'Ivy Inaccurate',
        isLive: false,
        isStale: false,
        isInaccurate: true,
        workerLatitude: 37.7949,
        workerLongitude: -122.3994,
        jobStatus: 'in_progress',
      },
    ];

    const liveMarkers = rawItems.filter(
      (m) =>
        m.isLive &&
        m.workerLatitude !== null &&
        m.workerLongitude !== null &&
        !isNaN(m.workerLatitude) &&
        !isNaN(m.workerLongitude)
    );

    assert.equal(liveMarkers.length, 1);
    assert.equal(liveMarkers[0].workerId, 'w-live');
    assert.equal(liveMarkers[0].workerName, 'Bob Live');

    // Untracked items (stale, no-fix, inaccurate) are excluded from liveMarkers
    const untracked = rawItems.filter((m) => !liveMarkers.includes(m));
    assert.equal(untracked.length, 3);
    assert.ok(untracked.some((u) => u.workerId === 'w-stale'));
    assert.ok(untracked.some((u) => u.workerId === 'w-nofix'));
    assert.ok(untracked.some((u) => u.workerId === 'w-inaccurate'));
  });
});

describe('M12.5 Marker Selection & Worker/Job Bottom Sheet Integration', () => {
  const items = [
    {
      workerId: 'worker-uuid-1',
      workerName: 'Alice Springs',
      workerAvatarUrl: 'https://example.com/avatar.jpg',
      workerPhone: '+15551234567',
      isActive: true,
      jobId: 'job-uuid-101',
      jobService: 'HVAC Diagnostics',
      jobAddress: '100 Main St, San Francisco, CA',
      customerName: 'Acme Corporation',
      jobStatus: 'on_the_way',
      destinationLatitude: 37.7749,
      destinationLongitude: -122.4194,
      locationId: 'loc-uuid-1',
      workerLatitude: 37.7849,
      workerLongitude: -122.4194,
      accuracy: 12.0,
      recordedAt: new Date(Date.now() - 30000).toISOString(), // 30s ago
      positionStatus: 'LIVE',
      isEligibleForLiveMarker: true,
      isLive: true,
      isStale: false,
      isInaccurate: false,
      distanceToDestinationMeters: 1100,
      freshnessLabel: 'Updated 30s ago',
    },
    {
      workerId: 'worker-uuid-2',
      workerName: 'Bob Builder',
      workerAvatarUrl: null,
      workerPhone: '+15559876543',
      isActive: true,
      jobId: 'job-uuid-102',
      jobService: 'Plumbing Repair',
      jobAddress: '200 Market St, San Francisco, CA',
      customerName: 'Jane Smith',
      jobStatus: 'arrived',
      destinationLatitude: 37.7949,
      destinationLongitude: -122.4094,
      locationId: 'loc-uuid-2',
      workerLatitude: 37.7949,
      workerLongitude: -122.4094,
      accuracy: 8.0,
      recordedAt: new Date(Date.now() - 400000).toISOString(), // ~6.6m ago
      positionStatus: 'STALE',
      isEligibleForLiveMarker: true,
      isLive: false,
      isStale: true,
      isInaccurate: false,
      distanceToDestinationMeters: 0,
      freshnessLabel: 'Stale',
    },
  ];

  test('matches worker and job using stable worker UUID, not array index or display name', () => {
    // Array index 0 is Alice, array index 1 is Bob
    const matched = findWorkerMapItemById(items, 'worker-uuid-2');
    assert.ok(matched !== null);
    assert.equal(matched.workerId, 'worker-uuid-2');
    assert.equal(matched.workerName, 'Bob Builder');
    assert.equal(matched.jobId, 'job-uuid-102');
    assert.equal(matched.customerName, 'Jane Smith');
    assert.equal(matched.jobService, 'Plumbing Repair');
  });

  test('returns null when worker ID is null, empty string, or not found in roster', () => {
    assert.equal(findWorkerMapItemById(items, null), null);
    assert.equal(findWorkerMapItemById(items, ''), null);
    assert.equal(findWorkerMapItemById(items, 'non-existent-worker-uuid'), null);
  });

  test('selected item provides all required bottom sheet fields without raw coordinates', () => {
    const selected = findWorkerMapItemById(items, 'worker-uuid-1');
    assert.ok(selected !== null);

    // Required fields:
    assert.equal(selected.workerName, 'Alice Springs');
    assert.equal(selected.jobService, 'HVAC Diagnostics');
    assert.equal(selected.customerName, 'Acme Corporation');
    assert.equal(selected.jobStatus, 'on_the_way');
    assert.equal(selected.jobAddress, '100 Main St, San Francisco, CA');
    assert.equal(selected.accuracy, 12.0);
    assert.equal(selected.jobId, 'job-uuid-101');
    assert.ok(selected.recordedAt !== null);

    // Verified: job ID is valid UUID for /owner/job-details deep link
    assert.match(selected.jobId, /^job-uuid-\d+$/);
  });

  test('dynamically evaluates location staleness while bottom sheet is open', () => {
    const nowMs = 1700000000000;
    const freshItem = {
      ...items[0],
      recordedAt: new Date(nowMs - 60000).toISOString(), // 1m ago
    };
    const staleItem = {
      ...items[1],
      recordedAt: new Date(nowMs - 360000).toISOString(), // 6m ago (>5m)
    };

    assert.equal(isWorkerLocationStale(freshItem, 300000, nowMs), false);
    assert.equal(isWorkerLocationStale(staleItem, 300000, nowMs), true);

    // Item without recorded timestamp is treated as stale/unavailable
    const noFixItem = {
      ...items[0],
      recordedAt: null,
    };
    assert.equal(isWorkerLocationStale(noFixItem, 300000, nowMs), true);
  });

  test('gracefully handles reassigned, completed, or cancelled jobs where jobId is null', () => {
    const completedOrUnassignedWorker = {
      ...items[0],
      jobId: null,
      jobService: null,
      jobAddress: null,
      customerName: null,
      jobStatus: null,
      positionStatus: 'NOT_TRACKABLE',
    };

    const matched = findWorkerMapItemById([completedOrUnassignedWorker], 'worker-uuid-1');
    assert.ok(matched !== null);
    assert.equal(matched.jobId, null);
    assert.equal(matched.jobStatus, null);
  });
});

describe('M12.6 Realtime Owner Live Map Reconciliation & Lifecycle Updates', () => {
  const nowMs = 1700000000000;
  const mockOwnerBizId = 'biz-uuid-1234';

  const workerProfiles = [
    { id: 'worker-1', full_name: 'Alice Springs', avatar_url: null, phone: null, is_active: true },
    { id: 'worker-2', full_name: 'Bob Builder', avatar_url: null, phone: null, is_active: true },
  ];

  test('new valid location update refreshes the matching marker coordinates and accuracy', () => {
    const rawJobs = [
      {
        id: 'job-1',
        worker_id: 'worker-1',
        service: 'Leak Repair',
        address: '100 Main St',
        status: 'on_the_way',
        latitude: 37.77,
        longitude: -122.41,
        scheduled_at: '2026-10-25T14:00:00Z',
      },
    ];

    // Initial position
    const initialLocations = [
      {
        id: 'loc-1',
        worker_id: 'worker-1',
        job_id: 'job-1',
        latitude: 37.7710,
        longitude: -122.4120,
        accuracy: 25.0,
        created_at: new Date(nowMs - 30000).toISOString(), // 30s ago
      },
    ];

    const initialData = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs,
      rawLocations: initialLocations,
      options: { nowMs },
    });
    assert.equal(initialData.activeMarkers.length, 1);
    assert.equal(initialData.activeMarkers[0].workerLatitude, 37.7710);
    assert.equal(initialData.activeMarkers[0].accuracy, 25.0);

    // Incoming Realtime location update: worker moved closer
    const updatedLocations = [
      {
        id: 'loc-1',
        worker_id: 'worker-1',
        job_id: 'job-1',
        latitude: 37.7735,
        longitude: -122.4150,
        accuracy: 8.0,
        created_at: new Date(nowMs - 5000).toISOString(), // 5s ago
      },
    ];

    const reconciledData = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs,
      rawLocations: updatedLocations,
      options: { nowMs },
    });
    assert.equal(reconciledData.activeMarkers.length, 1);
    assert.equal(reconciledData.activeMarkers[0].workerId, 'worker-1'); // Stable ID preserved
    assert.equal(reconciledData.activeMarkers[0].workerLatitude, 37.7735);
    assert.equal(reconciledData.activeMarkers[0].workerLongitude, -122.4150);
    assert.equal(reconciledData.activeMarkers[0].accuracy, 8.0);
    assert.equal(reconciledData.activeMarkers[0].freshnessLabel, 'Updated Just now');
  });

  test('status transition from travelling to arrived or working updates status label and badge', () => {
    const rawLocations = [
      {
        id: 'loc-1',
        worker_id: 'worker-1',
        job_id: 'job-1',
        latitude: 37.77,
        longitude: -122.41,
        accuracy: 10.0,
        created_at: new Date(nowMs - 10000).toISOString(),
      },
    ];

    // Step 1: Travelling (on_the_way)
    const jobTravelling = [
      {
        id: 'job-1',
        worker_id: 'worker-1',
        service: 'Electrical Repair',
        address: '200 Oak St',
        status: 'on_the_way',
        latitude: 37.77,
        longitude: -122.41,
        scheduled_at: '2026-10-25T14:00:00Z',
      },
    ];
    const dataTravelling = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs: jobTravelling,
      rawLocations,
      options: { nowMs },
    });
    assert.equal(dataTravelling.activeMarkers[0].jobStatus, 'on_the_way');
    assert.equal(getMapLifecycleStatusLabel(dataTravelling.activeMarkers[0].jobStatus), 'Travelling');
    assert.equal(dataTravelling.summary.enRouteCount, 1);
    assert.equal(dataTravelling.summary.onSiteCount, 0);

    // Step 2: Arrived (arrived)
    const jobArrived = [{ ...jobTravelling[0], status: 'arrived' }];
    const dataArrived = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs: jobArrived,
      rawLocations,
      options: { nowMs },
    });
    assert.equal(dataArrived.activeMarkers[0].jobStatus, 'arrived');
    assert.equal(getMapLifecycleStatusLabel(dataArrived.activeMarkers[0].jobStatus), 'Arrived');
    assert.equal(dataArrived.summary.enRouteCount, 0);
    assert.equal(dataArrived.summary.onSiteCount, 1);

    // Step 3: Working (in_progress)
    const jobWorking = [{ ...jobTravelling[0], status: 'in_progress' }];
    const dataWorking = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs: jobWorking,
      rawLocations,
      options: { nowMs },
    });
    assert.equal(dataWorking.activeMarkers[0].jobStatus, 'in_progress');
    assert.equal(getMapLifecycleStatusLabel(dataWorking.activeMarkers[0].jobStatus), 'Working');
    assert.equal(dataWorking.summary.enRouteCount, 0);
    assert.equal(dataWorking.summary.onSiteCount, 1);
  });

  test('completed or cancelled job is removed from actively tracked markers view', () => {
    const rawLocations = [
      {
        id: 'loc-1',
        worker_id: 'worker-1',
        job_id: 'job-1',
        latitude: 37.77,
        longitude: -122.41,
        accuracy: 10.0,
        created_at: new Date(nowMs - 10000).toISOString(),
      },
    ];

    // In-progress job
    const activeJobs = [
      {
        id: 'job-1',
        worker_id: 'worker-1',
        service: 'Pipe Replacement',
        address: '500 Pine St',
        status: 'in_progress',
        latitude: 37.77,
        longitude: -122.41,
        scheduled_at: '2026-10-25T14:00:00Z',
      },
    ];

    const activeMap = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs: activeJobs,
      rawLocations,
      options: { nowMs },
    });
    assert.equal(activeMap.activeMarkers.length, 1);

    // Realtime update: Job completed (terminal status, excluded from operational jobs query)
    const completedJobs = []; // Query for active statuses ('on_the_way', 'arrived', 'in_progress') returns empty
    const completedMap = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs: completedJobs,
      rawLocations,
      options: { nowMs },
    });

    // Marker is immediately evicted from activeMarkers
    assert.equal(completedMap.activeMarkers.length, 0);
    // Worker is gracefully classified as NOT_TRACKABLE in untrackedWorkers
    assert.equal(completedMap.untrackedWorkers.length, 2);
    const worker1 = completedMap.untrackedWorkers.find((w) => w.workerId === 'worker-1');
    assert.ok(worker1);
    assert.equal(worker1.isLive, false);
    assert.equal(worker1.jobId, null);
    assert.equal(worker1.positionStatus, 'NOT_TRACKABLE');
  });

  test('unassigned or reassigned job reconciles worker eligibility and marker removal', () => {
    const rawLocations = [
      {
        id: 'loc-1',
        worker_id: 'worker-1',
        job_id: 'job-1',
        latitude: 37.77,
        longitude: -122.41,
        accuracy: 10.0,
        created_at: new Date(nowMs - 10000).toISOString(),
      },
    ];

    // Job initially assigned to Worker 1 in Travelling
    const jobBefore = [
      {
        id: 'job-1',
        worker_id: 'worker-1',
        service: 'HVAC Inspection',
        address: '100 Main St',
        status: 'on_the_way',
        latitude: 37.77,
        longitude: -122.41,
        scheduled_at: '2026-10-25T14:00:00Z',
      },
    ];

    const mapBefore = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs: jobBefore,
      rawLocations,
      options: { nowMs },
    });
    assert.equal(mapBefore.activeMarkers.length, 1);
    assert.equal(mapBefore.activeMarkers[0].workerId, 'worker-1');

    // Case A: Owner unassigns job (status -> unassigned, worker_id -> null)
    // Operational field visit query returns 0 jobs assigned to worker-1
    const mapUnassigned = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs: [],
      rawLocations,
      options: { nowMs },
    });
    assert.equal(mapUnassigned.activeMarkers.length, 0);

    // Case B: Owner reassigns job to Worker 2 (status -> assigned)
    const jobReassigned = [
      {
        id: 'job-1',
        worker_id: 'worker-2',
        service: 'HVAC Inspection',
        address: '100 Main St',
        status: 'assigned', // Reassigned worker has not started travel yet
        latitude: 37.77,
        longitude: -122.41,
        scheduled_at: '2026-10-25T14:00:00Z',
      },
    ];

    const mapReassigned = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs: jobReassigned,
      rawLocations,
      options: { nowMs },
    });
    // Neither worker has active field travel coordinates
    assert.equal(mapReassigned.activeMarkers.length, 0);
    // Worker 1 is NOT_TRACKABLE (idle); Worker 2 is SCHEDULED
    const w1 = mapReassigned.untrackedWorkers.find((w) => w.workerId === 'worker-1');
    const w2 = mapReassigned.untrackedWorkers.find((w) => w.workerId === 'worker-2');
    assert.equal(w1?.positionStatus, 'NOT_TRACKABLE');
    assert.equal(w2?.jobStatus, 'assigned');
  });

  test('stale location (>5m) or low accuracy (>200m) is honestly evicted from active markers', () => {
    const rawJobs = [
      {
        id: 'job-1',
        worker_id: 'worker-1',
        service: 'Roof Leak',
        address: '777 Broadway',
        status: 'on_the_way',
        latitude: 37.77,
        longitude: -122.41,
        scheduled_at: '2026-10-25T14:00:00Z',
      },
    ];

    // Location older than 5 minutes (6 minutes old)
    const staleLocations = [
      {
        id: 'loc-1',
        worker_id: 'worker-1',
        job_id: 'job-1',
        latitude: 37.77,
        longitude: -122.41,
        accuracy: 15.0,
        created_at: new Date(nowMs - 360000).toISOString(),
      },
    ];

    const mapStale = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs,
      rawLocations: staleLocations,
      options: { nowMs },
    });
    // Active markers contains it with isLive: false, so live map view strictly filters it out
    const liveMarkers = mapStale.activeMarkers.filter((m) => m.isLive);
    assert.equal(liveMarkers.length, 0);
    assert.equal(mapStale.summary.staleTracked, 1);
    assert.equal(mapStale.activeMarkers[0].positionStatus, 'STALE');
    assert.equal(mapStale.activeMarkers[0].isLive, false);
    assert.equal(mapStale.activeMarkers[0].isStale, true);

    // Location with low accuracy (250m > 200m threshold)
    const inaccurateLocations = [
      {
        id: 'loc-1',
        worker_id: 'worker-1',
        job_id: 'job-1',
        latitude: 37.77,
        longitude: -122.41,
        accuracy: 250.0,
        created_at: new Date(nowMs - 10000).toISOString(), // fresh time, but low accuracy
      },
    ];

    const mapInaccurate = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs,
      rawLocations: inaccurateLocations,
      options: { nowMs },
    });
    const liveMarkersInacc = mapInaccurate.activeMarkers.filter((m) => m.isLive);
    assert.equal(liveMarkersInacc.length, 0);
    assert.equal(mapInaccurate.summary.lowAccuracyCount, 1);
    assert.equal(mapInaccurate.activeMarkers[0].positionStatus, 'LOW_ACCURACY');
    assert.equal(mapInaccurate.activeMarkers[0].isLive, false);
    assert.equal(mapInaccurate.activeMarkers[0].isInaccurate, true);
  });

  test('selected bottom sheet item preserves worker selection across Realtime reconciliations', () => {
    const rawJobs = [
      {
        id: 'job-1',
        worker_id: 'worker-1',
        service: 'Emergency AC Fix',
        address: '100 Main St',
        status: 'on_the_way',
        latitude: 37.77,
        longitude: -122.41,
        scheduled_at: '2026-10-25T14:00:00Z',
      },
    ];

    const loc1 = [
      {
        id: 'loc-1',
        worker_id: 'worker-1',
        job_id: 'job-1',
        latitude: 37.771,
        longitude: -122.412,
        accuracy: 15.0,
        created_at: new Date(nowMs - 60000).toISOString(),
      },
    ];

    const initialData = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs,
      rawLocations: loc1,
      options: { nowMs },
    });
    const selectedWorkerId = 'worker-1';

    // Lookup selected item before Realtime event
    const selectedBefore = findWorkerMapItemById(initialData.workers, selectedWorkerId);
    assert.ok(selectedBefore);
    assert.equal(selectedBefore.jobStatus, 'on_the_way');
    assert.equal(selectedBefore.workerLatitude, 37.771);

    // Realtime update: technician arrived and sent fresh location
    const loc2 = [
      {
        id: 'loc-1',
        worker_id: 'worker-1',
        job_id: 'job-1',
        latitude: 37.775,
        longitude: -122.416,
        accuracy: 5.0,
        created_at: new Date(nowMs - 2000).toISOString(),
      },
    ];
    const jobsArrived = [{ ...rawJobs[0], status: 'arrived' }];

    const updatedData = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs: jobsArrived,
      rawLocations: loc2,
      options: { nowMs },
    });

    // Selected item looked up with the SAME stable selectedWorkerId
    const selectedAfter = findWorkerMapItemById(updatedData.workers, selectedWorkerId);
    assert.ok(selectedAfter);
    assert.equal(selectedAfter.workerId, 'worker-1');
    assert.equal(selectedAfter.jobStatus, 'arrived');
    assert.equal(selectedAfter.workerLatitude, 37.775);
    assert.equal(selectedAfter.accuracy, 5.0);
    // Selection was never lost or reset to null
    assert.equal(selectedAfter.workerId, selectedBefore.workerId);
  });
});


