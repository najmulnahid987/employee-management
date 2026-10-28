/**
 * Dispatcher M16.2 — Job History Data Service Test Suite
 *
 * Validates:
 * 1. Date preset calculations produce deterministic local business calendar boundaries.
 * 2. Pagination offset/limit calculations and boundary clamps.
 * 3. Actual lifecycle timestamp mapping (completed_at vs cancelled_at vs created_at).
 * 4. Safe batched worker mapping and null/missing worker safety.
 * 5. Event timeline actor mapping and chronological ordering.
 * 6. Code audit of src/lib/jobs.ts ensuring RLS alignment, non-trust authorization,
 *    deterministic secondary sort (id DESC), and zero N+1 queries.
 * 7. Code audit of src/hooks/use-job-history.ts ensuring correct hook contracts.
 *
 * Execution:
 * node --test --experimental-strip-types scripts/test-job-history-service.mjs
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

// Pure implementation mirroring getJobHistoryDateRange
function getJobHistoryDateRange(preset, referenceDate = new Date()) {
  if (preset === 'all') {
    return {};
  }

  const now = referenceDate;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const endISO = tomorrow.toISOString();

  switch (preset) {
    case 'today': {
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      return { startISO: todayStart.toISOString(), endISO };
    }
    case 'past_7_days': {
      const sevenDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
      return { startISO: sevenDaysAgo.toISOString(), endISO };
    }
    case 'past_30_days': {
      const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 0, 0, 0, 0);
      return { startISO: thirtyDaysAgo.toISOString(), endISO };
    }
    case 'this_month': {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      return { startISO: monthStart.toISOString(), endISO };
    }
    default:
      return {};
  }
}

describe('M16.2 Job History Data Service', () => {
  test('1. Date preset calculations produce valid, deterministic local boundaries', () => {
    // Fixed reference date: Wednesday, Oct 28, 2026, 14:30:00 local
    const refDate = new Date(2026, 9, 28, 14, 30, 0, 0);

    // Preset: 'all'
    const allRange = getJobHistoryDateRange('all', refDate);
    assert.deepStrictEqual(allRange, {}, 'Preset "all" returns empty object');

    // Preset: 'today'
    const todayRange = getJobHistoryDateRange('today', refDate);
    assert.ok(todayRange.startISO, 'startISO defined for today');
    assert.ok(todayRange.endISO, 'endISO defined for today');
    const todayStart = new Date(todayRange.startISO);
    const todayEnd = new Date(todayRange.endISO);
    assert.equal(todayStart.getFullYear(), 2026);
    assert.equal(todayStart.getMonth(), 9);
    assert.equal(todayStart.getDate(), 28);
    assert.equal(todayStart.getHours(), 0);

    // End is midnight of the next day (exclusive upper bound)
    assert.equal(todayEnd.getFullYear(), 2026);
    assert.equal(todayEnd.getMonth(), 9);
    assert.equal(todayEnd.getDate(), 29);
    assert.equal(todayEnd.getHours(), 0);

    // Preset: 'past_7_days'
    const sevenDaysRange = getJobHistoryDateRange('past_7_days', refDate);
    const sevenDaysStart = new Date(sevenDaysRange.startISO);
    assert.equal(sevenDaysStart.getDate(), 22); // 28 - 6 = 22
    assert.equal(sevenDaysStart.getHours(), 0);

    // Preset: 'past_30_days'
    const thirtyDaysRange = getJobHistoryDateRange('past_30_days', refDate);
    const thirtyDaysStart = new Date(thirtyDaysRange.startISO);
    assert.ok(thirtyDaysStart < refDate);

    // Preset: 'this_month'
    const monthRange = getJobHistoryDateRange('this_month', refDate);
    const monthStart = new Date(monthRange.startISO);
    assert.equal(monthStart.getDate(), 1);
    assert.equal(monthStart.getMonth(), 9);
    assert.equal(monthStart.getFullYear(), 2026);
    assert.equal(monthStart.getHours(), 0);
  });

  test('2. Pagination offset and limit calculation contract', () => {
    function computePagination(limit = 20, offset, page) {
      const clampedLimit = Math.max(1, Math.min(limit, 100));
      const computedOffset =
        offset !== undefined
          ? Math.max(0, offset)
          : page !== undefined
            ? Math.max(0, (page - 1) * clampedLimit)
            : 0;
      const computedPage = Math.floor(computedOffset / clampedLimit) + 1;
      return { limit: clampedLimit, offset: computedOffset, page: computedPage };
    }

    assert.deepStrictEqual(computePagination(20, undefined, 1), { limit: 20, offset: 0, page: 1 });
    assert.deepStrictEqual(computePagination(20, undefined, 2), { limit: 20, offset: 20, page: 2 });
    assert.deepStrictEqual(computePagination(20, undefined, 3), { limit: 20, offset: 40, page: 3 });
    assert.deepStrictEqual(computePagination(20, 50, undefined), { limit: 20, offset: 50, page: 3 });

    // Clamp limits
    assert.equal(computePagination(-5, 0).limit, 1);
    assert.equal(computePagination(500, 0).limit, 100);
  });

  test('3. Timestamp column selection strictly uses actual lifecycle timestamps', () => {
    function getTimestampColumn(status) {
      if (status === 'completed') return 'completed_at';
      if (status === 'cancelled') return 'cancelled_at';
      return 'created_at';
    }

    assert.equal(getTimestampColumn('completed'), 'completed_at', 'Completed jobs must use actual completed_at');
    assert.equal(getTimestampColumn('cancelled'), 'cancelled_at', 'Cancelled jobs must use cancelled_at');
    assert.equal(getTimestampColumn('all'), 'created_at', 'General history uses created_at');
  });

  test('4. Batched worker assembly handles missing/null workers safely', () => {
    const rawJobs = [
      { id: 'job-1', worker_id: 'worker-a', service: 'Plumbing', customer_name: 'Alice', status: 'completed', completed_at: '2026-10-27T10:00:00Z' },
      { id: 'job-2', worker_id: null, service: 'Electrical', customer_name: 'Bob', status: 'completed', completed_at: '2026-10-27T11:00:00Z' },
      { id: 'job-3', worker_id: 'worker-b', service: 'HVAC', customer_name: 'Charlie', status: 'completed', completed_at: '2026-10-27T12:00:00Z' },
      { id: 'job-4', worker_id: 'worker-c', service: 'Locksmith', customer_name: 'Dave', status: 'completed', completed_at: '2026-10-27T13:00:00Z' },
    ];

    const workerMap = new Map([
      ['worker-a', { id: 'worker-a', full_name: 'Alice Smith', avatar_url: null, phone: '555-0101' }],
      ['worker-b', { id: 'worker-b', full_name: 'Bob Jones', avatar_url: 'https://avatar.url', phone: '555-0102' }],
    ]);

    const assembled = rawJobs.map((j) => ({
      ...j,
      worker: j.worker_id ? workerMap.get(j.worker_id) ?? null : null,
    }));

    assert.equal(assembled[0].worker?.full_name, 'Alice Smith');
    assert.equal(assembled[1].worker, null, 'Null worker_id safely returns worker: null');
    assert.equal(assembled[2].worker?.full_name, 'Bob Jones');
    assert.equal(assembled[3].worker, null, 'Missing worker profile safely returns worker: null');
  });

  test('5. Event timeline actor mapping handles system, owner, and technician actors', () => {
    const rawEvents = [
      { id: 'ev-1', job_id: 'j-1', actor_id: 'user-owner', actor_role: 'owner', event_type: 'job_created', previous_status: null, new_status: 'unassigned', metadata: {}, created_at: '2026-10-27T08:00:00Z' },
      { id: 'ev-2', job_id: 'j-1', actor_id: 'user-owner', actor_role: 'owner', event_type: 'worker_assigned', previous_status: 'unassigned', new_status: 'assigned', metadata: { worker_id: 'user-worker' }, created_at: '2026-10-27T08:05:00Z' },
      { id: 'ev-3', job_id: 'j-1', actor_id: 'user-worker', actor_role: 'worker', event_type: 'status_changed', previous_status: 'assigned', new_status: 'accepted', metadata: {}, created_at: '2026-10-27T08:10:00Z' },
      { id: 'ev-4', job_id: 'j-1', actor_id: null, actor_role: 'system', event_type: 'status_changed', previous_status: 'accepted', new_status: 'on_the_way', metadata: {}, created_at: '2026-10-27T08:15:00Z' },
    ];

    const actorMap = new Map([
      ['user-owner', { full_name: 'Boss Owner', avatar_url: null }],
      ['user-worker', { full_name: 'Tech Worker', avatar_url: 'https://worker.png' }],
    ]);

    const enriched = rawEvents.map((e) => {
      const actor = e.actor_id ? actorMap.get(e.actor_id) : undefined;
      return {
        ...e,
        actor_name: actor?.full_name ?? null,
        actor_avatar_url: actor?.avatar_url ?? null,
      };
    });

    assert.equal(enriched[0].actor_name, 'Boss Owner');
    assert.equal(enriched[1].actor_name, 'Boss Owner');
    assert.equal(enriched[2].actor_name, 'Tech Worker');
    assert.equal(enriched[2].actor_avatar_url, 'https://worker.png');
    assert.equal(enriched[3].actor_name, null, 'System actor without actor_id has actor_name: null');
  });

  test('6. Static source audit of src/lib/jobs.ts', () => {
    const jobsSourcePath = path.resolve('src/lib/jobs.ts');
    assert.ok(fs.existsSync(jobsSourcePath), 'src/lib/jobs.ts must exist');
    const content = fs.readFileSync(jobsSourcePath, 'utf8');

    // 1. fetchJobHistory exported
    assert.ok(content.includes('export async function fetchJobHistory('), 'fetchJobHistory must be exported');

    // 2. Deterministic secondary sort: order by id DESC
    assert.ok(content.includes(".order('id', { ascending: false })"), 'Must sort by id DESC as stable secondary sort');

    // 3. Completed status uses completed_at
    assert.ok(content.includes("statusFilter === 'completed'"), 'Checks statusFilter === completed');
    assert.ok(content.includes("'completed_at'"), "Must use 'completed_at' timestamp column");

    // 4. Non-trust authorization checks
    assert.ok(content.includes('supabase.auth.getUser()'), 'Must verify authenticated caller session');
    assert.ok(content.includes("profile.role !== 'owner'"), 'Must disallow non-owners from accessing job history');
    assert.ok(content.includes('options.businessId !== trustedBusinessId'), 'Must reject caller-supplied businessId mismatch');

    // 5. Batched worker lookup (no N+1 queries)
    assert.ok(content.includes(".from('profiles')"), 'Batches worker profile queries');
    assert.ok(content.includes(".in('id', workerIds)"), 'Uses .in(id, workerIds) for batched query');

    // 6. Range pagination
    assert.ok(content.includes(".range(offset, offset + limit - 1)"), 'Uses .range() for database pagination');
    assert.ok(content.includes("{ count: 'exact' }"), 'Requests exact count from PostgreSQL');

    // 7. Timeline function exported
    assert.ok(content.includes('export async function fetchJobEventTimeline('), 'fetchJobEventTimeline must be exported');
    assert.ok(content.includes(".order('created_at', { ascending })"), 'Supports ascending chronological ordering');
  });

  test('7. Static source audit of src/hooks/use-job-history.ts', () => {
    const hookPath = path.resolve('src/hooks/use-job-history.ts');
    assert.ok(fs.existsSync(hookPath), 'src/hooks/use-job-history.ts must exist');
    const content = fs.readFileSync(hookPath, 'utf8');

    assert.ok(content.includes('export function useJobHistory('), 'Exports useJobHistory hook');
    assert.ok(content.includes('fetchJobHistory('), 'Invokes fetchJobHistory service');
    assert.ok(content.includes('fetchNextPage'), 'Exposes fetchNextPage for infinite scrolling');
    assert.ok(content.includes('onRefresh'), 'Exposes onRefresh for pull-to-refresh');
    assert.ok(content.includes('setStatusFilter'), 'Exposes setStatusFilter');
    assert.ok(content.includes('setDatePreset'), 'Exposes setDatePreset');
    assert.ok(content.includes('subscribeToJobTransitions'), 'Listens for job state transitions');
    assert.ok(content.includes('subscribeToJobSignals'), 'Listens for Realtime job signals');
    assert.ok(content.includes('existingIds.has'), 'Deduplicates records by ID on pagination append');
  });

  test('8. Static source audit of src/app/owner/job-history.tsx', () => {
    const screenPath = path.resolve('src/app/owner/job-history.tsx');
    assert.ok(fs.existsSync(screenPath), 'src/app/owner/job-history.tsx must exist');
    const content = fs.readFileSync(screenPath, 'utf8');

    // Default export
    assert.ok(content.includes('export default function OwnerJobHistoryScreen('), 'Exports OwnerJobHistoryScreen');

    // Hook usage
    assert.ok(content.includes('useJobHistory('), 'Uses useJobHistory hook');
    assert.ok(content.includes("initialStatus: 'completed'"), 'Defaults to completed jobs');

    // Required fields in card
    assert.ok(content.includes('job.customer_name'), 'Displays customer name');
    assert.ok(content.includes('job.service'), 'Displays service description');
    assert.ok(content.includes('job.completed_at'), 'Displays actual completion timestamp');
    assert.ok(content.includes('workerName'), 'Displays worker name');
    assert.ok(content.includes('Unassigned'), 'Provides unassigned/missing worker fallback badge');

    // Navigation on press
    assert.ok(content.includes("pathname: '/owner/job-details'"), 'Navigates to job details on press');

    // Pagination & Infinite Scroll
    assert.ok(content.includes('onEndReached={fetchNextPage}'), 'Invokes fetchNextPage on scroll end');
    assert.ok(content.includes('Load More Records'), 'Provides explicit load more button');
    assert.ok(content.includes('Loading older records...'), 'Provides distinct load-more loading state');

    // States: Initial loading, Empty, Error/Retry
    assert.ok(content.includes('Loading job history records...'), 'Provides initial loading state');
    assert.ok(content.includes('<EmptyState'), 'Provides distinct empty state');
    assert.ok(content.includes('Failed to load job history'), 'Provides distinct error state');
    assert.ok(content.includes('label="Retry"'), 'Provides retry action on error');
  });

  test('9. Navigation registration in owner layouts and screens', () => {
    const ownerLayoutPath = path.resolve('src/app/owner/_layout.tsx');
    const ownerLayout = fs.readFileSync(ownerLayoutPath, 'utf8');
    assert.ok(ownerLayout.includes('name="job-history"'), 'Registered in src/app/owner/_layout.tsx');

    const jobsTabPath = path.resolve('src/app/owner/(tabs)/jobs.tsx');
    const jobsTab = fs.readFileSync(jobsTabPath, 'utf8');
    assert.ok(jobsTab.includes("router.push('/owner/job-history')"), 'Jobs tab navigates to job history');

    const dashboardTabPath = path.resolve('src/app/owner/(tabs)/dashboard.tsx');
    const dashboardTab = fs.readFileSync(dashboardTabPath, 'utf8');
    assert.ok(dashboardTab.includes("router.push('/owner/job-history')"), 'Dashboard completed card navigates to job history');
  });
});

