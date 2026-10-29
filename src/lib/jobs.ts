/**
 * Dispatcher Job Data Access Layer
 *
 * Implements real Supabase queries for jobs and workers.
 * Strictly adheres to single-business tenancy, RLS, and the frozen 8-status lifecycle:
 * - unassigned | assigned | accepted | on_the_way | arrived | in_progress | completed | cancelled
 *
 * Query Strategy:
 * - 1 query to public.jobs scoped strictly to the authenticated business_id and local day boundaries
 * - 1 batched query to public.profiles for assigned workers (zero N+1 queries)
 */

import {
  canTransitionJob,
  isTerminalJobStatus,
  JobActorRole,
  JobStatus,
  WORKER_STATUS_PRIORITY,
} from '@/lib/lifecycle';
import { logger, sanitizeString, toUserFacingErrorMessage } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export type { JobStatus, JobActorRole };
export { WORKER_STATUS_PRIORITY };

export type Job = Database['public']['Tables']['jobs']['Row'];
export type Profile = Database['public']['Tables']['profiles']['Row'];

export interface WorkerSummary {
  id: string;
  full_name: string;
  avatar_url: string | null;
  phone: string | null;
}

export interface JobEventRecord {
  id: string;
  job_id: string;
  actor_id: string | null;
  actor_role: string;
  event_type: string;
  previous_status: string | null;
  new_status: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  actor_name?: string | null;
  actor_avatar_url?: string | null;
  target_worker_name?: string | null;
  previous_worker_name?: string | null;
}

export type JobWithWorker = Job & {
  worker: WorkerSummary | null;
  events?: JobEventRecord[];
  eventsError?: string | null;
};

export interface DashboardSummary {
  total: number;
  upcoming: number;
  active: number;
  completed: number;
  cancelled: number;
  unassigned: number;
}

export interface DashboardSections {
  active: JobWithWorker[];
  upcoming: JobWithWorker[];
  completed: JobWithWorker[];
}

export interface OwnerDashboardData {
  jobs: JobWithWorker[];
  sections: DashboardSections;
  summary: DashboardSummary;
  error: string | null;
}

/**
 * Returns ISO strings defining the start (inclusive) and end (exclusive)
 * of a local calendar day for the user's current environment.
 * Prevents UTC string comparison discrepancies.
 */
export function getLocalDayBoundaries(date: Date = new Date()): {
  startISO: string;
  endISO: string;
} {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const nextDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  return {
    startISO: start.toISOString(),
    endISO: nextDay.toISOString(),
  };
}

/**
 * Checks whether two dates represent the same calendar day in the local timezone.
 */
export function isSameLocalDay(d1: Date, d2: Date = new Date()): boolean {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

/**
 * Formats a scheduled ISO timestamp into a localized, user-friendly time string.
 */
export function formatScheduledTime(scheduledAt: string | null): string {
  if (!scheduledAt) return 'Time not set';
  try {
    const d = new Date(scheduledAt);
    if (isNaN(d.getTime())) return 'Scheduled';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return 'Scheduled';
  }
}

/**
 * Formats the selected date for display in the dashboard header.
 */
export function formatHeaderDate(date: Date = new Date()): string {
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Partitions jobs into operational categories and calculates summary metrics.
 *
 * Operational Category Rules:
 * - Upcoming: ['unassigned', 'assigned', 'accepted']
 *   Jobs scheduled for today that have not begun field travel or on-site work.
 * - Active: ['on_the_way', 'arrived', 'in_progress']
 *   Jobs currently underway with a technician travelling, arrived on-site, or performing work.
 * - Completed: ['completed']
 *   Jobs marked completed today.
 * - Cancelled: ['cancelled']
 *   Excluded from operational sections but tracked in summary metrics.
 *
 * Invariant: Every non-cancelled job belongs to exactly one category.
 */
export function partitionDashboardJobs(jobs: JobWithWorker[]): {
  sections: DashboardSections;
  summary: DashboardSummary;
} {
  const active: JobWithWorker[] = [];
  const upcoming: JobWithWorker[] = [];
  const completed: JobWithWorker[] = [];
  let cancelledCount = 0;
  let unassignedCount = 0;

  for (const job of jobs) {
    if (job.status === 'unassigned' || !job.worker_id) {
      unassignedCount++;
    }

    switch (job.status) {
      case 'on_the_way':
      case 'arrived':
      case 'in_progress':
        active.push(job);
        break;

      case 'unassigned':
      case 'assigned':
      case 'accepted':
        upcoming.push(job);
        break;

      case 'completed':
        completed.push(job);
        break;

      case 'cancelled':
        cancelledCount++;
        break;

      default:
        // Defensive fallback for unexpected status values
        upcoming.push(job);
        break;
    }
  }

  // Active jobs: ordered by arrival/start/updated timestamp (most active on top)
  active.sort((a, b) => {
    const timeA = new Date(a.started_at || a.arrived_at || a.travelling_at || a.updated_at).getTime();
    const timeB = new Date(b.started_at || b.arrived_at || b.travelling_at || b.updated_at).getTime();
    return timeB - timeA;
  });

  // Upcoming jobs: ordered by scheduled_at ascending (earliest scheduled first)
  upcoming.sort((a, b) => {
    if (!a.scheduled_at && !b.scheduled_at) return 0;
    if (!a.scheduled_at) return 1;
    if (!b.scheduled_at) return -1;
    return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
  });

  // Completed jobs: ordered by completed_at descending (most recently completed on top)
  completed.sort((a, b) => {
    const timeA = new Date(a.completed_at || a.updated_at).getTime();
    const timeB = new Date(b.completed_at || b.updated_at).getTime();
    return timeB - timeA;
  });

  const summary: DashboardSummary = {
    total: jobs.length,
    upcoming: upcoming.length,
    active: active.length,
    completed: completed.length,
    cancelled: cancelledCount,
    unassigned: unassignedCount,
  };

  return {
    sections: { active, upcoming, completed },
    summary,
  };
}

/**
 * Fetches today's jobs for the given business using a 2-step batched query.
 * Never executes N+1 queries for workers.
 *
 * @param businessId Trusted business ID of the authenticated owner
 * @param selectedDay Calendar day to query (defaults to current device date)
 */
export async function fetchOwnerDashboardJobs(
  businessId: string,
  selectedDay: Date = new Date()
): Promise<OwnerDashboardData> {
  const emptyResult: OwnerDashboardData = {
    jobs: [],
    sections: { active: [], upcoming: [], completed: [] },
    summary: { total: 0, upcoming: 0, active: 0, completed: 0, cancelled: 0, unassigned: 0 },
    error: null,
  };

  if (!businessId) {
    return { ...emptyResult, error: 'No active business association found.' };
  }

  try {
    const { startISO, endISO } = getLocalDayBoundaries(selectedDay);
    const isToday = isSameLocalDay(selectedDay);

    // 1. Primary Query:
    // When viewing "Today":
    //   - All field active jobs underway right now (on_the_way, arrived, in_progress)
    //   - All pending jobs scheduled for today or overdue from the past (unassigned, assigned, accepted)
    //   - All unscheduled pending jobs needing dispatch/assignment
    //   - Jobs completed today
    //   - Jobs cancelled today (for summary counts)
    // When viewing a historical or future calendar day:
    //   - Jobs scheduled for that specific day
    //   - Jobs completed on that day
    //   - Jobs cancelled on that day
    //   - Unscheduled jobs created on that day
    const orFilter = isToday
      ? [
          'status.in.("on_the_way","arrived","in_progress")',
          `and(status.in.("unassigned","assigned","accepted"),scheduled_at.lt.${endISO})`,
          'and(status.in.("unassigned","assigned","accepted"),scheduled_at.is.null)',
          `and(status.eq.completed,completed_at.gte.${startISO},completed_at.lt.${endISO})`,
          `and(status.eq.cancelled,cancelled_at.gte.${startISO},cancelled_at.lt.${endISO})`,
        ].join(',')
      : [
          `and(scheduled_at.gte.${startISO},scheduled_at.lt.${endISO})`,
          `and(status.eq.completed,completed_at.gte.${startISO},completed_at.lt.${endISO})`,
          `and(status.eq.cancelled,cancelled_at.gte.${startISO},cancelled_at.lt.${endISO})`,
          `and(scheduled_at.is.null,created_at.gte.${startISO},created_at.lt.${endISO})`,
        ].join(',');

    const { data: rawJobs, error: jobsError } = await supabase
      .from('jobs')
      .select('*')
      .eq('business_id', businessId)
      .or(orFilter)
      .order('scheduled_at', { ascending: true, nullsFirst: false });

    if (jobsError) {
      logger.warn('DashboardService', 'Failed to load jobs:', jobsError.message);
      return { ...emptyResult, error: toUserFacingErrorMessage(jobsError) };
    }

    if (!rawJobs || rawJobs.length === 0) {
      return emptyResult;
    }

    // 2. Batched Worker Query: Extract unique non-null worker IDs
    const workerIds = Array.from(
      new Set(rawJobs.map((j) => j.worker_id).filter((id): id is string => Boolean(id)))
    );

    const workerMap = new Map<string, WorkerSummary>();

    if (workerIds.length > 0) {
      const { data: workers, error: workersError } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url, phone')
        .in('id', workerIds);

      if (workersError) {
        logger.warn('DashboardService', 'Batched worker lookup warning:', workersError.message);
      } else if (workers) {
        for (const worker of workers) {
          workerMap.set(worker.id, {
            id: worker.id,
            full_name: worker.full_name,
            avatar_url: worker.avatar_url,
            phone: worker.phone,
          });
        }
      }
    }

    // 3. In-memory assembly
    const jobsWithWorker: JobWithWorker[] = rawJobs.map((job) => ({
      ...job,
      worker: job.worker_id ? workerMap.get(job.worker_id) ?? null : null,
    }));

    const { sections, summary } = partitionDashboardJobs(jobsWithWorker);

    return {
      jobs: jobsWithWorker,
      sections,
      summary,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred while loading operations.';
    logger.warn('DashboardService', 'Exception loading dashboard:', message);
    return { ...emptyResult, error: toUserFacingErrorMessage(err, message) };
  }
}

export type OwnerJobFilter = 'all' | 'unassigned' | 'active' | 'completed' | 'cancelled';

export interface OwnerJobsListData {
  jobs: JobWithWorker[];
  error: string | null;
}

/**
 * Fetches all service jobs for the authenticated business using a 2-step batched query.
 * Scoped strictly to the authenticated business_id and validated by PostgreSQL RLS.
 * Zero N+1 queries for worker details.
 */
export async function fetchOwnerJobsList(
  businessId: string,
  limit: number = 100
): Promise<OwnerJobsListData> {
  const emptyResult: OwnerJobsListData = {
    jobs: [],
    error: null,
  };

  if (!businessId) {
    return { ...emptyResult, error: 'No active business association found.' };
  }

  try {
    // 1. Primary Query: All jobs for this business ordered with most recently created on top (bounded)
    const { data: rawJobs, error: jobsError } = await supabase
      .from('jobs')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(1, limit), 250));

    if (jobsError) {
      logger.warn('JobsService', 'fetchOwnerJobsList error:', jobsError.message);
      return { ...emptyResult, error: toUserFacingErrorMessage(jobsError) };
    }

    if (!rawJobs || rawJobs.length === 0) {
      return emptyResult;
    }

    // 2. Batched Worker Query: Extract unique assigned worker IDs
    const workerIds = Array.from(
      new Set(rawJobs.map((j) => j.worker_id).filter((id): id is string => Boolean(id)))
    );

    const workerMap = new Map<string, WorkerSummary>();

    if (workerIds.length > 0) {
      const { data: workers, error: workersError } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url, phone')
        .in('id', workerIds);

      if (workersError) {
        logger.warn('JobsService', 'Batched worker lookup warning:', workersError.message);
      } else if (workers) {
        for (const worker of workers) {
          workerMap.set(worker.id, {
            id: worker.id,
            full_name: worker.full_name,
            avatar_url: worker.avatar_url,
            phone: worker.phone,
          });
        }
      }
    }

    // 3. In-memory assembly
    const jobsWithWorker: JobWithWorker[] = rawJobs.map((job) => ({
      ...job,
      worker: job.worker_id ? workerMap.get(job.worker_id) ?? null : null,
    }));

    return {
      jobs: jobsWithWorker,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred while loading jobs.';
    logger.warn('JobsService', 'Exception loading owner jobs list:', message);
    return { ...emptyResult, error: toUserFacingErrorMessage(err, message) };
  }
}

/**
 * Filters the list of owner jobs by lifecycle category and optional text search.
 */
export function filterOwnerJobs(
  jobs: JobWithWorker[],
  filter: OwnerJobFilter,
  searchQuery: string = ''
): JobWithWorker[] {
  let filtered = jobs;

  switch (filter) {
    case 'unassigned':
      filtered = jobs.filter(
        (j) => j.status === 'unassigned' || (!j.worker_id && j.status !== 'completed' && j.status !== 'cancelled')
      );
      break;
    case 'active':
      filtered = jobs.filter(
        (j) =>
          j.status === 'assigned' ||
          j.status === 'accepted' ||
          j.status === 'on_the_way' ||
          j.status === 'arrived' ||
          j.status === 'in_progress'
      );
      break;
    case 'completed':
      filtered = jobs.filter((j) => j.status === 'completed');
      break;
    case 'cancelled':
      filtered = jobs.filter((j) => j.status === 'cancelled');
      break;
    case 'all':
    default:
      filtered = jobs;
      break;
  }

  const query = searchQuery.trim().toLowerCase();
  if (!query) {
    return filtered;
  }

  return filtered.filter((j) => {
    const customer = (j.customer_name || '').toLowerCase();
    const service = (j.service || '').toLowerCase();
    const address = (j.address || '').toLowerCase();
    const worker = (j.worker?.full_name || '').toLowerCase();
    return (
      customer.includes(query) ||
      service.includes(query) ||
      address.includes(query) ||
      worker.includes(query)
    );
  });
}

// =============================================================================
// Owner Job History & Paginated Records (Phase M16)
// =============================================================================

export type JobHistoryStatusFilter = 'completed' | 'cancelled' | 'all' | JobStatus;

export type JobHistoryDatePreset = 'all' | 'today' | 'past_7_days' | 'past_30_days' | 'this_month';

export interface JobHistoryDateRange {
  startISO?: string;
  endISO?: string;
}

export interface FetchJobHistoryOptions {
  /** Optional business ID; strictly validated against the caller's authenticated profile */
  businessId?: string;
  /** Filter by status. Defaults to 'completed' as preferred historical view */
  status?: JobHistoryStatusFilter;
  /** Predefined date filter preset calculated relative to local business calendar */
  datePreset?: JobHistoryDatePreset;
  /** Custom ISO timestamp boundaries (takes precedence over datePreset if provided) */
  customDateRange?: JobHistoryDateRange;
  /** Maximum number of records per page (default: 20, max: 100) */
  limit?: number;
  /** Offset for pagination (default: 0) */
  offset?: number;
  /** 1-based page number (alternative to offset; offset = (page - 1) * limit) */
  page?: number;
  /** Reference date for local timezone calendar calculation (defaults to device now) */
  referenceDate?: Date;
}

export interface JobHistoryResult {
  jobs: JobWithWorker[];
  totalCount: number;
  offset: number;
  limit: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  error: string | null;
}

/**
 * Calculates start and end ISO timestamps for job history date presets
 * using local business calendar day boundaries.
 */
export function getJobHistoryDateRange(
  preset: JobHistoryDatePreset,
  referenceDate: Date = new Date()
): JobHistoryDateRange {
  if (preset === 'all') {
    return {};
  }

  const now = referenceDate;
  // Local end-of-day boundary: start of tomorrow (exclusive upper bound)
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const endISO = tomorrow.toISOString();

  switch (preset) {
    case 'today': {
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      return { startISO: todayStart.toISOString(), endISO };
    }
    case 'past_7_days': {
      // Past 7 days including today: 6 days before today at 00:00:00.000 local
      const sevenDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
      return { startISO: sevenDaysAgo.toISOString(), endISO };
    }
    case 'past_30_days': {
      // Past 30 days including today: 29 days before today at 00:00:00.000 local
      const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 0, 0, 0, 0);
      return { startISO: thirtyDaysAgo.toISOString(), endISO };
    }
    case 'this_month': {
      // 1st of current month at 00:00:00.000 local
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      return { startISO: monthStart.toISOString(), endISO };
    }
    default:
      return {};
  }
}

/**
 * Fetches paginated job history records strictly scoped to the authenticated owner's business.
 *
 * Guarantees:
 * - Authorization: Derives business_id strictly from caller's trusted profile (never trusts client param).
 * - Deterministic Ordering: Primary sort on relevant timestamp DESC, stable secondary sort on unique id DESC.
 * - Timestamp Integrity: Completed jobs query and sort authoritatively by actual `completed_at` timestamp.
 * - Zero N+1 Queries: 1 paginated slice from jobs + 1 batched profile lookup for unique worker IDs.
 * - Safety: Safely handles null worker_id and optional fields.
 */
export async function fetchJobHistory(
  options: FetchJobHistoryOptions = {}
): Promise<JobHistoryResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const offset = options.offset !== undefined
    ? Math.max(0, options.offset)
    : options.page !== undefined
      ? Math.max(0, (options.page - 1) * limit)
      : 0;
  const page = Math.floor(offset / limit) + 1;

  const emptyResult: JobHistoryResult = {
    jobs: [],
    totalCount: 0,
    offset,
    limit,
    page,
    pageSize: limit,
    hasMore: false,
    error: null,
  };

  try {
    // 1. Authoritative Session & Profile Verification (Zero client-supplied trust)
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return {
        ...emptyResult,
        error: 'Authentication required to access job history.',
      };
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, business_id, role, is_active')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return {
        ...emptyResult,
        error: 'Active profile not found for authenticated user.',
      };
    }

    if (profile.role !== 'owner') {
      return {
        ...emptyResult,
        error: 'Only business owners can access job history records.',
      };
    }

    if (!profile.is_active) {
      return {
        ...emptyResult,
        error: 'Your user profile is inactive.',
      };
    }

    const trustedBusinessId = profile.business_id;

    // Disallow cross-tenant spoofing: if caller explicitly passes a businessId, assert it matches
    if (options.businessId && options.businessId !== trustedBusinessId) {
      return {
        ...emptyResult,
        error: 'Unauthorized: Business ID does not match authenticated profile.',
      };
    }

    // 2. Query Construction
    const statusFilter = options.status ?? 'completed';

    // Primary timestamp column determination:
    // - 'completed' uses the actual completion timestamp (completed_at)
    // - 'cancelled' uses cancelled_at
    // - other / 'all' uses created_at
    const timestampCol =
      statusFilter === 'completed'
        ? 'completed_at'
        : statusFilter === 'cancelled'
          ? 'cancelled_at'
          : 'created_at';

    let query = supabase
      .from('jobs')
      .select('*', { count: 'exact' })
      .eq('business_id', trustedBusinessId);

    if (statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }

    // Date range filtering
    let dateRange: JobHistoryDateRange = {};
    if (options.customDateRange?.startISO || options.customDateRange?.endISO) {
      dateRange = options.customDateRange;
    } else if (options.datePreset && options.datePreset !== 'all') {
      dateRange = getJobHistoryDateRange(options.datePreset, options.referenceDate);
    }

    if (dateRange.startISO) {
      query = query.gte(timestampCol, dateRange.startISO);
    }
    if (dateRange.endISO) {
      query = query.lt(timestampCol, dateRange.endISO);
    }

    // Deterministic ordering:
    // Primary sort on the timestamp column (descending, nulls last)
    // Secondary sort on unique job id (descending) to ensure 100% deterministic pagination
    query = query
      .order(timestampCol, { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: rawJobs, error: jobsError, count } = await query;

    if (jobsError) {
      logger.warn('JobsService', 'fetchJobHistory query error:', jobsError.message);
      return { ...emptyResult, error: toUserFacingErrorMessage(jobsError) };
    }

    const totalCount = count ?? 0;

    if (!rawJobs || rawJobs.length === 0) {
      return {
        ...emptyResult,
        totalCount,
        hasMore: false,
      };
    }

    // 3. Batched Worker Query: Extract unique assigned worker IDs (Zero N+1 queries)
    const workerIds = Array.from(
      new Set(rawJobs.map((j) => j.worker_id).filter((id): id is string => Boolean(id)))
    );

    const workerMap = new Map<string, WorkerSummary>();

    if (workerIds.length > 0) {
      const { data: workers, error: workersError } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url, phone')
        .in('id', workerIds);

      if (workersError) {
        logger.warn('JobsService', 'Batched worker lookup warning:', workersError.message);
      } else if (workers) {
        for (const worker of workers) {
          workerMap.set(worker.id, {
            id: worker.id,
            full_name: worker.full_name,
            avatar_url: worker.avatar_url,
            phone: worker.phone,
          });
        }
      }
    }

    // 4. In-memory assembly
    const jobsWithWorker: JobWithWorker[] = rawJobs.map((job) => ({
      ...job,
      worker: job.worker_id ? workerMap.get(job.worker_id) ?? null : null,
    }));

    const hasMore = offset + rawJobs.length < totalCount;

    return {
      jobs: jobsWithWorker,
      totalCount,
      offset,
      limit,
      page,
      pageSize: limit,
      hasMore,
      error: null,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'An unexpected error occurred while loading job history.';
    logger.warn('JobsService', 'fetchJobHistory exception:', message);
    return { ...emptyResult, error: toUserFacingErrorMessage(err, message) };
  }
}

export interface AssignableWorker {
  id: string;
  full_name: string;
  avatar_url: string | null;
  phone: string | null;
  is_active: boolean;
  workloadBadge: {
    label: string;
    variant: 'available' | 'active' | 'upcoming' | 'ineligible';
  };
  activeJobCount: number;
}

/**
 * Sanitizes job creation and assignment errors to prevent exposing internal SQL or server internals.
 */
function sanitizeJobError(error: unknown): string {
  if (!error) return 'An unexpected error occurred while creating the job.';

  let msg = '';
  if (typeof error === 'string') {
    msg = error;
  } else if (error instanceof Error) {
    msg = error.message;
  } else if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, unknown>;
    msg = typeof errObj.message === 'string' ? errObj.message : JSON.stringify(error);
  }

  if (msg.includes('Only business owners')) {
    return 'Only business owners are authorized to create and dispatch jobs.';
  }
  if (msg.includes('same business')) {
    return 'The selected technician belongs to another business and cannot be assigned.';
  }
  if (msg.includes('inactive worker')) {
    return 'The selected technician is currently inactive and cannot be assigned.';
  }
  if (msg.includes('Customer name is required')) {
    return 'Customer name is required.';
  }
  if (msg.includes('Customer phone is required')) {
    return 'Customer phone number is required.';
  }
  if (msg.includes('Service description is required')) {
    return 'Service description is required.';
  }
  if (msg.includes('Service site address is required')) {
    return 'Service site address is required.';
  }
  if (msg.includes('PGRST') || msg.includes('42501')) {
    return 'Server authorization error. Please verify your business profile.';
  }
  if (msg.includes('Network') || msg.includes('Failed to fetch')) {
    return 'Network connection error. Please check your connection and retry.';
  }

  // Prevent leaking internal SQL syntax or database errors to users
  if (
    msg.includes('relation "') ||
    msg.includes('constraint "') ||
    msg.includes('syntax error') ||
    msg.includes('column "')
  ) {
    return 'Failed to save job due to a server validation error. Please try again.';
  }

  return sanitizeString(msg) || 'Failed to save job. Please try again.';
}

/**
 * Fetches all active workers for the business and their current workload today
 * using a 2-step batched query (zero N+1 queries).
 */
export async function fetchAssignableWorkers(
  businessId: string,
  scheduledDate: Date = new Date()
): Promise<{ workers: AssignableWorker[]; error: string | null }> {
  if (!businessId) {
    return { workers: [], error: 'Business ID is required.' };
  }

  try {
    // 1. Query all worker profiles belonging to this business
    const { data: rawWorkers, error: workersErr } = await supabase
      .from('profiles')
      .select('id, full_name, avatar_url, phone, is_active')
      .eq('business_id', businessId)
      .eq('role', 'worker')
      .order('full_name', { ascending: true });

    if (workersErr) {
      return { workers: [], error: workersErr.message };
    }

    if (!rawWorkers || rawWorkers.length === 0) {
      return { workers: [], error: null };
    }

    // 2. Query today's active/scheduled assignments for this business
    const { startISO, endISO } = getLocalDayBoundaries(scheduledDate);
    const isToday = isSameLocalDay(scheduledDate);

    const orFilter = isToday
      ? [
          'status.in.("on_the_way","arrived","in_progress")',
          `and(scheduled_at.gte.${startISO},scheduled_at.lt.${endISO})`,
          `and(scheduled_at.is.null,created_at.gte.${startISO},created_at.lt.${endISO})`,
        ].join(',')
      : [
          `and(scheduled_at.gte.${startISO},scheduled_at.lt.${endISO})`,
          `and(scheduled_at.is.null,created_at.gte.${startISO},created_at.lt.${endISO})`,
        ].join(',');

    const { data: dayJobs, error: jobsErr } = await supabase
      .from('jobs')
      .select('id, worker_id, status, scheduled_at')
      .eq('business_id', businessId)
      .not('worker_id', 'is', null)
      .or(orFilter)
      .not('status', 'in', '("completed","cancelled")');

    if (jobsErr) {
      logger.warn('JobsService', 'Workload query warning:', jobsErr.message);
    }

    // 3. In-memory aggregation per worker
    const workerJobMap = new Map<string, { activeCount: number; upcomingCount: number; currentStatus: string | null }>();

    if (dayJobs) {
      for (const j of dayJobs) {
        if (!j.worker_id) continue;
        const current = workerJobMap.get(j.worker_id) ?? { activeCount: 0, upcomingCount: 0, currentStatus: null };

        if (j.status === 'on_the_way' || j.status === 'arrived' || j.status === 'in_progress') {
          current.activeCount++;
          current.currentStatus = j.status;
        } else if (j.status === 'assigned' || j.status === 'accepted') {
          current.upcomingCount++;
        }
        workerJobMap.set(j.worker_id, current);
      }
    }

    const assignableWorkers: AssignableWorker[] = rawWorkers.map((w) => {
      if (!w.is_active) {
        return {
          id: w.id,
          full_name: w.full_name,
          avatar_url: w.avatar_url,
          phone: w.phone,
          is_active: false,
          workloadBadge: {
            label: 'Inactive',
            variant: 'ineligible',
          },
          activeJobCount: 0,
        };
      }

      const workload = workerJobMap.get(w.id);
      if (workload && workload.activeCount > 0) {
        const stageLabel =
          workload.currentStatus === 'in_progress'
            ? 'In Progress'
            : workload.currentStatus === 'arrived'
            ? 'On-Site'
            : 'On The Way';
        return {
          id: w.id,
          full_name: w.full_name,
          avatar_url: w.avatar_url,
          phone: w.phone,
          is_active: true,
          workloadBadge: {
            label: `Active (${stageLabel})`,
            variant: 'active',
          },
          activeJobCount: workload.activeCount,
        };
      }

      if (workload && workload.upcomingCount > 0) {
        return {
          id: w.id,
          full_name: w.full_name,
          avatar_url: w.avatar_url,
          phone: w.phone,
          is_active: true,
          workloadBadge: {
            label: `${workload.upcomingCount} job${workload.upcomingCount > 1 ? 's' : ''} scheduled`,
            variant: 'upcoming',
          },
          activeJobCount: 0,
        };
      }

      return {
        id: w.id,
        full_name: w.full_name,
        avatar_url: w.avatar_url,
        phone: w.phone,
        is_active: true,
        workloadBadge: {
          label: 'Available',
          variant: 'available',
        },
        activeJobCount: 0,
      };
    });

    return { workers: assignableWorkers, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch workers';
    return { workers: [], error: msg };
  }
}

export interface CreateJobParams {
  businessId: string;
  customerName: string;
  customerPhone: string;
  service: string;
  address: string;
  scheduledAt: string; // ISO 8601 string
  notes?: string | null;
  workerId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface CreateJobResult {
  success: boolean;
  job?: Job;
  error?: string;
}

/**
 * Creates a new service job and optionally assigns a worker.
 *
 * Atomically executed via server-side create_job RPC with row validation,
 * role verification, and append-only event logging.
 */
export async function createJob(params: CreateJobParams): Promise<CreateJobResult> {
  const trimmedName = params.customerName.trim();
  const trimmedPhone = params.customerPhone.trim();
  const trimmedService = params.service.trim();
  const trimmedAddress = params.address.trim();
  const trimmedNotes = params.notes?.trim() ? params.notes.trim() : null;

  if (!trimmedName) return { success: false, error: 'Customer name is required.' };
  if (!trimmedPhone) return { success: false, error: 'Customer phone is required.' };
  if (!trimmedService) return { success: false, error: 'Service scope is required.' };
  if (!trimmedAddress) return { success: false, error: 'Service site address is required.' };
  if (!params.scheduledAt) return { success: false, error: 'Scheduled arrival time is required.' };

  try {
    // 1. Try atomic create_job RPC first
    const { data: rpcData, error: rpcError } = await supabase.rpc('create_job', {
      p_customer_name: trimmedName,
      p_customer_phone: trimmedPhone,
      p_service: trimmedService,
      p_address: trimmedAddress,
      p_scheduled_at: params.scheduledAt,
      p_notes: trimmedNotes,
      p_worker_id: params.workerId || null,
      p_latitude: params.latitude ?? null,
      p_longitude: params.longitude ?? null,
    });

    if (rpcError) {
      return { success: false, error: sanitizeJobError(rpcError) };
    }

    if (!rpcData) {
      return { success: false, error: 'Job creation failed: no data returned from server.' };
    }

    return { success: true, job: rpcData };
  } catch (err) {
    return { success: false, error: sanitizeJobError(err) };
  }
}

/**
 * Fetches a single job with its assigned worker details by job ID.
 */
export async function fetchJobDetails(
  jobId: string,
  businessId: string
): Promise<{ job: JobWithWorker | null; error: string | null }> {
  if (!jobId || !businessId) {
    return { job: null, error: 'Job ID and business ID are required.' };
  }

  try {
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .eq('business_id', businessId)
      .maybeSingle();

    if (jobError) {
      return { job: null, error: jobError.message };
    }

    if (!job) {
      return { job: null, error: 'Job not found in your business.' };
    }

    let worker: WorkerSummary | null = null;
    if (job.worker_id) {
      const { data: workerProfile } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url, phone')
        .eq('id', job.worker_id)
        .maybeSingle();

      if (workerProfile) {
        worker = {
          id: workerProfile.id,
          full_name: workerProfile.full_name,
          avatar_url: workerProfile.avatar_url,
          phone: workerProfile.phone,
        };
      }
    }

    let events: JobEventRecord[] = [];
    let eventsError: string | null = null;
    const { events: loadedEvents, error: timelineErr } = await fetchJobEventTimeline(jobId, {
      businessId,
      ascending: true,
    });
    if (timelineErr) {
      eventsError = timelineErr;
    } else if (loadedEvents) {
      events = loadedEvents;
    }

    return { job: { ...job, worker, events, eventsError }, error: null };
  } catch (err) {
    return {
      job: null,
      error: err instanceof Error ? err.message : 'Failed to fetch job details.',
    };
  }
}

export interface FetchJobEventTimelineOptions {
  businessId?: string;
  ascending?: boolean;
  limit?: number;
}

/**
 * Fetches the event timeline for a job with resolved actor profile details.
 * Ordered chronologically (created_at ASC) by default.
 * Batches profile lookups to eliminate N+1 queries.
 */
export async function fetchJobEventTimeline(
  jobId: string,
  options: FetchJobEventTimelineOptions = {}
): Promise<{ events: JobEventRecord[]; error: string | null }> {
  if (!jobId) {
    return { events: [], error: 'Job ID is required.' };
  }

  const ascending = options.ascending ?? true;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));

  try {
    // 1. Authoritative Session & Profile Verification (Do not trust client param or naked job ID)
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return {
        events: [],
        error: 'Authentication required to access job event history.',
      };
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, business_id, role, is_active')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return {
        events: [],
        error: 'Active profile not found for authenticated user.',
      };
    }

    if (profile.role !== 'owner') {
      return {
        events: [],
        error: 'Only business owners can access job audit timelines.',
      };
    }

    if (!profile.is_active) {
      return {
        events: [],
        error: 'Your user profile is inactive.',
      };
    }

    const trustedBusinessId = profile.business_id;

    if (options.businessId && options.businessId !== trustedBusinessId) {
      return {
        events: [],
        error: 'Unauthorized: Business ID does not match authenticated profile.',
      };
    }

    // 2. Verify that the job exists and belongs to this business
    const { data: jobCheck, error: jobCheckError } = await supabase
      .from('jobs')
      .select('id')
      .eq('id', jobId)
      .eq('business_id', trustedBusinessId)
      .maybeSingle();

    if (jobCheckError) {
      return { events: [], error: jobCheckError.message };
    }

    if (!jobCheck) {
      return { events: [], error: 'Job not found in your business.' };
    }

    // 3. Query job_events with business isolation & deterministic chronological ordering
    let query = supabase
      .from('job_events')
      .select('*')
      .eq('job_id', jobId)
      .eq('business_id', trustedBusinessId)
      .order('created_at', { ascending })
      .order('id', { ascending })
      .limit(limit);

    const { data: rawEvents, error: eventsError } = await query;

    if (eventsError) {
      logger.warn('JobsService', 'fetchJobEventTimeline error:', eventsError.message);
      return { events: [], error: toUserFacingErrorMessage(eventsError) };
    }

    if (!rawEvents || rawEvents.length === 0) {
      return { events: [], error: null };
    }

    // 4. Collect unique profile IDs for batched lookup (zero N+1 queries)
    const profileIdSet = new Set<string>();
    for (const e of rawEvents) {
      if (e.actor_id) profileIdSet.add(e.actor_id);
      if (e.metadata && typeof e.metadata === 'object') {
        const meta = e.metadata as Record<string, unknown>;
        if (typeof meta.worker_id === 'string' && meta.worker_id) profileIdSet.add(meta.worker_id);
        if (typeof meta.new_worker_id === 'string' && meta.new_worker_id) profileIdSet.add(meta.new_worker_id);
        if (typeof meta.previous_worker_id === 'string' && meta.previous_worker_id) profileIdSet.add(meta.previous_worker_id);
        if (typeof meta.initial_worker_id === 'string' && meta.initial_worker_id) profileIdSet.add(meta.initial_worker_id);
      }
    }

    const profileIds = Array.from(profileIdSet);
    const profileMap = new Map<string, { full_name: string; avatar_url: string | null }>();

    if (profileIds.length > 0) {
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', profileIds);

      if (profilesError) {
        logger.warn('JobsService', 'Batched profile lookup warning:', profilesError.message);
      } else if (profiles) {
        for (const p of profiles) {
          profileMap.set(p.id, {
            full_name: p.full_name,
            avatar_url: p.avatar_url,
          });
        }
      }
    }

    // 5. In-memory assembly
    const events: JobEventRecord[] = rawEvents.map((e) => {
      const actor = e.actor_id ? profileMap.get(e.actor_id) : undefined;
      const meta = (e.metadata as Record<string, unknown>) || {};

      const targetWorkerId =
        typeof meta.worker_id === 'string'
          ? meta.worker_id
          : typeof meta.new_worker_id === 'string'
          ? meta.new_worker_id
          : typeof meta.initial_worker_id === 'string'
          ? meta.initial_worker_id
          : null;
      const targetWorker = targetWorkerId ? profileMap.get(targetWorkerId) : undefined;

      const prevWorkerId =
        typeof meta.previous_worker_id === 'string' ? meta.previous_worker_id : null;
      const prevWorker = prevWorkerId ? profileMap.get(prevWorkerId) : undefined;

      return {
        id: e.id,
        job_id: e.job_id,
        actor_id: e.actor_id,
        actor_role: e.actor_role,
        event_type: e.event_type,
        previous_status: e.previous_status,
        new_status: e.new_status,
        metadata: meta,
        created_at: e.created_at,
        actor_name: actor?.full_name ?? null,
        actor_avatar_url: actor?.avatar_url ?? null,
        target_worker_name: targetWorker?.full_name ?? null,
        previous_worker_name: prevWorker?.full_name ?? null,
      };
    });

    return { events, error: null };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'An unexpected error occurred while loading event timeline.';
    return { events: [], error: message };
  }
}

// =============================================================================
// Worker App Data Access & Operations (Phase M8)
// =============================================================================



/**
 * Deterministically sorts jobs for the worker experience:
 * 1. Active jobs first (in_progress -> arrived -> on_the_way)
 * 2. Assigned jobs requiring worker response (accept/decline)
 * 3. Accepted upcoming jobs
 * 4. Completed / terminal jobs
 * Within the same status priority, orders by scheduled_at ascending.
 */
export function sortWorkerJobs(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => {
    const priorityA = WORKER_STATUS_PRIORITY[a.status as JobStatus] ?? 99;
    const priorityB = WORKER_STATUS_PRIORITY[b.status as JobStatus] ?? 99;
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    if (!a.scheduled_at && !b.scheduled_at) return 0;
    if (!a.scheduled_at) return 1;
    if (!b.scheduled_at) return -1;
    return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
  });
}

export interface WorkerTodayData {
  heroJob: Job | null;
  queue: Job[];
  todayCompletedCount: number;
  error: string | null;
}

export interface WorkerJobsData {
  activeAndUpcoming: Job[];
  completed: Job[];
  error: string | null;
}

/**
 * Sanitizes errors returned by transition and lifecycle operations to avoid leaking SQL or internal exceptions.
 */
export function sanitizeTransitionError(error: unknown): string {
  if (!error) return 'An unexpected error occurred.';
  let msg = '';
  if (typeof error === 'string') msg = error;
  else if (error instanceof Error) msg = error.message;
  else if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, unknown>;
    msg = typeof errObj.message === 'string' ? errObj.message : JSON.stringify(error);
  }

  if (msg.includes('Authentication required')) {
    return 'Your session has expired. Please sign in again.';
  }
  if (msg.includes('Only active field workers')) {
    return 'Your technician profile is inactive or unauthorized for this action.';
  }
  if (msg.includes('Only business owners can cancel')) {
    return 'Only business owners are authorized to cancel service jobs.';
  }
  if (msg.includes('Only business owners can assign')) {
    return 'Only business owners are authorized to assign or unassign jobs.';
  }
  if (msg.includes('Job not found or not assigned to you')) {
    return 'This job is no longer assigned to your account or has been reassigned.';
  }
  if (msg.includes('Job not found in your business')) {
    return 'Job not found in your business directory.';
  }
  if (msg.includes('Can only decline jobs in assigned status')) {
    return 'This job is no longer awaiting acceptance and cannot be declined.';
  }
  if (msg.includes('Can only unassign a job currently in assigned status')) {
    return 'Only jobs currently in assigned status can be unassigned.';
  }
  if (msg.includes('Jobs can only be assigned or reassigned while in unassigned or assigned status')) {
    return 'Jobs can only be assigned or reassigned while in unassigned or assigned status.';
  }
  if (
    msg.includes('Invalid sequential status transition') ||
    msg.includes('Illegal worker status transition') ||
    msg.includes('Invalid owner status transition')
  ) {
    return 'The job status has changed or is out of sync. Please refresh your screen.';
  }
  if (
    msg.includes('Cannot modify job in terminal status') ||
    msg.includes('already in a terminal status')
  ) {
    return 'This job has already reached a terminal status (completed or cancelled) and cannot be modified.';
  }
  if (msg.includes('Mandatory cancellation reason required')) {
    return 'A valid cancellation reason is required to cancel this job.';
  }
  if (msg.includes('Assigned worker must belong to the same business')) {
    return 'The assigned technician does not belong to your business.';
  }
  if (msg.includes('Cannot assign an inactive worker')) {
    return 'The selected technician is currently marked inactive.';
  }
  if (msg.includes('Assigned profile must have worker role')) {
    return 'The assigned user profile must have the field technician role.';
  }
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

  // Prevent leaking internal SQL syntax or database errors to users
  if (
    msg.includes('relation "') ||
    msg.includes('constraint "') ||
    msg.includes('syntax error') ||
    msg.includes('column "') ||
    msg.includes('PGRST') ||
    msg.includes('42501')
  ) {
    return 'Failed to update job status due to a server error. Please try again.';
  }

  return sanitizeString(msg) || 'Failed to update job status. Please try again.';
}

export const sanitizeWorkerActionError = sanitizeTransitionError;

/**
 * Fetches all relevant jobs for the Worker Today view.
 *
 * Query Strategy:
 * - Scoped strictly to the worker's business_id and worker_id (verified by RLS).
 * - Queries active jobs (on_the_way, arrived, in_progress) and any jobs scheduled today.
 * - If no active job exists, identifies the next assigned job awaiting action or next accepted visit.
 * - Single query, zero N+1 lookups.
 */
export async function fetchWorkerTodayJobs(
  businessId: string,
  workerId: string,
  selectedDay: Date = new Date()
): Promise<WorkerTodayData> {
  const emptyResult: WorkerTodayData = {
    heroJob: null,
    queue: [],
    todayCompletedCount: 0,
    error: null,
  };

  if (!businessId || !workerId) {
    return { ...emptyResult, error: 'User is not associated with an active business profile.' };
  }

  try {
    const { startISO, endISO } = getLocalDayBoundaries(selectedDay);

    // Query all non-terminal assigned jobs for this worker, plus any jobs completed today
    const { data: rawJobs, error } = await supabase
      .from('jobs')
      .select('*')
      .eq('business_id', businessId)
      .eq('worker_id', workerId)
      .or(
        `not.status.in.("completed","cancelled"),and(status.eq.completed,completed_at.gte.${startISO},completed_at.lt.${endISO})`
      );

    if (error) {
      logger.warn('JobsService', 'fetchWorkerTodayJobs error:', error.message);
      return { ...emptyResult, error: toUserFacingErrorMessage(error) };
    }

    if (!rawJobs || rawJobs.length === 0) {
      return emptyResult;
    }

    const nonTerminalJobs: Job[] = [];
    let completedCount = 0;

    for (const job of rawJobs) {
      if (job.status === 'completed') {
        completedCount++;
      } else if (job.status !== 'cancelled') {
        nonTerminalJobs.push(job);
      }
    }

    if (nonTerminalJobs.length === 0) {
      return {
        heroJob: null,
        queue: [],
        todayCompletedCount: completedCount,
        error: null,
      };
    }

    // Sort non-terminal jobs deterministically
    const sorted = sortWorkerJobs(nonTerminalJobs);
    const hero = sorted[0] ?? null;
    const remainingQueue = sorted.slice(1);

    return {
      heroJob: hero,
      queue: remainingQueue,
      todayCompletedCount: completedCount,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load today jobs.';
    return { ...emptyResult, error: message };
  }
}

/**
 * Fetches all assigned jobs for the worker inbox (active, upcoming, and completed).
 */
export async function fetchWorkerAssignedJobs(
  businessId: string,
  workerId: string
): Promise<WorkerJobsData> {
  const emptyResult: WorkerJobsData = {
    activeAndUpcoming: [],
    completed: [],
    error: null,
  };

  if (!businessId || !workerId) {
    return { ...emptyResult, error: 'User is not associated with an active business profile.' };
  }

  try {
    const { data: rawJobs, error } = await supabase
      .from('jobs')
      .select('*')
      .eq('business_id', businessId)
      .eq('worker_id', workerId)
      .order('scheduled_at', { ascending: true, nullsFirst: false });

    if (error) {
      logger.warn('JobsService', 'fetchWorkerAssignedJobs error:', error.message);
      return { ...emptyResult, error: toUserFacingErrorMessage(error) };
    }

    if (!rawJobs || rawJobs.length === 0) {
      return emptyResult;
    }

    const activeAndUpcoming: Job[] = [];
    const completed: Job[] = [];

    for (const job of rawJobs) {
      if (job.status === 'completed') {
        completed.push(job);
      } else if (job.status !== 'cancelled') {
        activeAndUpcoming.push(job);
      }
    }

    // Sort active & upcoming using deterministic priority
    const sortedActiveAndUpcoming = sortWorkerJobs(activeAndUpcoming);

    // Sort completed jobs with most recent completed_at on top
    completed.sort((a, b) => {
      const timeA = new Date(a.completed_at || a.updated_at).getTime();
      const timeB = new Date(b.completed_at || b.updated_at).getTime();
      return timeB - timeA;
    });

    return {
      activeAndUpcoming: sortedActiveAndUpcoming,
      completed,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load assigned jobs.';
    return { ...emptyResult, error: message };
  }
}

/**
 * Fetches a single job assigned to the authenticated worker.
 */
export async function fetchWorkerJobDetails(
  jobId: string,
  businessId: string,
  workerId: string
): Promise<{ job: Job | null; error: string | null }> {
  if (!jobId || !businessId || !workerId) {
    return { job: null, error: 'Job ID, business ID, and worker identity are required.' };
  }

  try {
    const { data: job, error } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .eq('business_id', businessId)
      .eq('worker_id', workerId)
      .maybeSingle();

    if (error) {
      return { job: null, error: error.message };
    }

    if (!job) {
      return { job: null, error: 'This job is not assigned to your account or does not exist.' };
    }

    return { job, error: null };
  } catch (err) {
    return {
      job: null,
      error: err instanceof Error ? err.message : 'Failed to fetch job details.',
    };
  }
}

// =============================================================================
// 7. Central Job Transition Service & Invalidation
// =============================================================================

export interface JobTransitionParams {
  jobId: string;
  targetStatus: JobStatus;
  currentStatus?: JobStatus;
  workerId?: string | null;
  reason?: string | null;
  role?: JobActorRole;
}

export interface JobTransitionResult {
  success: boolean;
  job?: Job;
  error?: string;
}

export type JobTransitionListener = (jobId: string, newStatus: JobStatus) => void;

const transitionListeners = new Set<JobTransitionListener>();
const inFlightTransitions = new Set<string>();

/**
 * Subscribes a listener to job lifecycle transition events.
 * Returns an unsubscription callback.
 */
export function subscribeToJobTransitions(listener: JobTransitionListener): () => void {
  transitionListeners.add(listener);
  return () => {
    transitionListeners.delete(listener);
  };
}

/**
 * Notifies all active transition listeners to invalidate and reload job queries.
 */
export function notifyJobTransition(jobId: string, newStatus: JobStatus): void {
  transitionListeners.forEach((listener) => {
    try {
      listener(jobId, newStatus);
    } catch (err) {
      logger.warn('JobsService', 'Invalidation listener error:', err);
    }
  });
}

/**
 * Centralized typed service function for requesting a job status transition.
 *
 * Adheres strictly to M9.2 lifecycle state machine and M9.3 secure database operations:
 * - Client-side state machine validation before network calls
 * - Deduplicates concurrent in-flight requests for the same job and target status
 * - Sends ONLY required transition arguments to backend (jobId, targetStatus, workerId, reason)
 * - Never sends trusted actor IDs, business IDs, timestamps, or authorization claims
 * - Catches and sanitizes backend rejections, stale data errors, and network failures
 * - Automatically notifies invalidation listeners to refresh relevant job views
 */
export async function requestJobTransition(
  params: JobTransitionParams
): Promise<JobTransitionResult> {
  const { jobId, targetStatus, currentStatus, workerId, reason, role } = params;

  if (!jobId) {
    return { success: false, error: 'Job ID is required.' };
  }

  // 1. Client-Side State Machine & Guard Validation (M9.2)
  if (currentStatus) {
    if (isTerminalJobStatus(currentStatus)) {
      return {
        success: false,
        error: `Job is already in terminal status "${currentStatus}" and cannot be modified.`,
      };
    }

    if (!canTransitionJob(currentStatus, targetStatus, role)) {
      return {
        success: false,
        error: `Invalid transition: Cannot transition job from "${currentStatus}" to "${targetStatus}".`,
      };
    }
  }

  // 2. Transition-Specific Parameter Requirements
  if (targetStatus === 'cancelled') {
    if (!reason || !reason.trim()) {
      return {
        success: false,
        error: 'A mandatory cancellation reason is required to cancel a service job.',
      };
    }
  }

  if (targetStatus === 'assigned') {
    if (!workerId) {
      return {
        success: false,
        error: 'A valid technician ID is required to assign or reassign a job.',
      };
    }
  }

  // 3. In-Flight Request Deduplication (Per-job mutex prevents concurrent double-actions)
  if (inFlightTransitions.has(jobId)) {
    return {
      success: false,
      error: 'A transition request is already in progress for this job. Please wait.',
    };
  }

  inFlightTransitions.add(jobId);

  try {
    let resultJob: Job | null = null;

    // 4. Dispatch to Approved Backend RPC with Conditional p_expected_current_status
    if (targetStatus === 'cancelled') {
      const { data, error } = await supabase.rpc('cancel_job', {
        p_job_id: jobId,
        p_cancellation_reason: reason!.trim(),
        p_expected_current_status: currentStatus || null,
      });
      if (error) throw error;
      resultJob = data as Job;
    } else if (targetStatus === 'assigned') {
      const { data, error } = await supabase.rpc('assign_job_worker', {
        p_job_id: jobId,
        p_worker_id: workerId!,
        p_expected_current_status: currentStatus || null,
      });
      if (error) throw error;
      resultJob = data as Job;
    } else if (targetStatus === 'unassigned') {
      // Unassign can be Owner unassign (assign_job_worker with null) or Worker decline (decline_job_assignment)
      if (role === 'owner' || (!reason && role !== 'worker')) {
        const { data, error } = await supabase.rpc('assign_job_worker', {
          p_job_id: jobId,
          p_worker_id: null,
          p_expected_current_status: currentStatus || null,
        });
        if (error) throw error;
        resultJob = data as Job;
      } else {
        const { data, error } = await supabase.rpc('decline_job_assignment', {
          p_job_id: jobId,
          p_decline_reason: reason || 'Declined by technician',
          p_expected_current_status: currentStatus || null,
        });
        if (error) throw error;
        resultJob = data as Job;
      }
    } else {
      // Field Worker sequential progression: accepted | on_the_way | arrived | in_progress | completed
      const { data, error } = await supabase.rpc('advance_job_status', {
        p_job_id: jobId,
        p_target_status: targetStatus,
        p_expected_current_status: currentStatus || null,
      });
      if (error) throw error;
      resultJob = data as Job;
    }

    // 5. Invalidate & Refresh Notification
    notifyJobTransition(jobId, targetStatus);

    return { success: true, job: resultJob ?? undefined };
  } catch (err) {
    // 6. Timeout & Network Failure Authoritative State Recovery (Requirement 5)
    // If the network call failed/timed out, check if the mutation actually committed on the server
    try {
      const { data: latestJob, error: checkError } = await supabase
        .from('jobs')
        .select('*')
        .eq('id', jobId)
        .maybeSingle();

      if (!checkError && latestJob) {
        if (latestJob.status === targetStatus) {
          // The operation actually succeeded on the backend before the client timed out/disconnected!
          notifyJobTransition(jobId, targetStatus);
          return {
            success: true,
            job: latestJob as Job,
          };
        } else if (currentStatus && latestJob.status !== currentStatus) {
          // The job changed to another status elsewhere
          notifyJobTransition(jobId, latestJob.status as JobStatus);
          return {
            success: false,
            error: `The job status has changed to "${latestJob.status}". Screen refreshed with authoritative state.`,
            job: latestJob as Job,
          };
        }
      }
    } catch {
      // Ignore query failure, proceed to sanitize original error
    }

    logger.warn('JobsService', 'requestJobTransition error:', err);
    return { success: false, error: sanitizeTransitionError(err) };
  } finally {
    inFlightTransitions.delete(jobId);
  }
}

/**
 * Accepts an assigned job (Field Worker).
 */
export async function acceptJobAssignment(
  jobId: string,
  currentStatus?: JobStatus
): Promise<JobTransitionResult> {
  return requestJobTransition({
    jobId,
    targetStatus: 'accepted',
    currentStatus,
    role: 'worker',
  });
}

/**
 * Declines an assigned job (Field Worker).
 */
export async function declineJobAssignment(
  jobId: string,
  declineReason: string = 'Declined by technician',
  currentStatus?: JobStatus
): Promise<JobTransitionResult> {
  return requestJobTransition({
    jobId,
    targetStatus: 'unassigned',
    currentStatus,
    reason: declineReason,
    role: 'worker',
  });
}

/**
 * Advances field worker sequential status.
 */
export async function advanceJobStatus(
  jobId: string,
  targetStatus: 'accepted' | 'on_the_way' | 'arrived' | 'in_progress' | 'completed',
  currentStatus?: JobStatus
): Promise<JobTransitionResult> {
  return requestJobTransition({
    jobId,
    targetStatus,
    currentStatus,
    role: 'worker',
  });
}

/**
 * Assigns or reassigns a job to a technician (Business Owner).
 */
export async function assignJobWorker(
  jobId: string,
  workerId: string,
  currentStatus?: JobStatus
): Promise<JobTransitionResult> {
  return requestJobTransition({
    jobId,
    targetStatus: 'assigned',
    workerId,
    currentStatus,
    role: 'owner',
  });
}

/**
 * Unassigns a technician from an assigned job (Business Owner).
 */
export async function unassignJobWorker(
  jobId: string,
  currentStatus?: JobStatus
): Promise<JobTransitionResult> {
  return requestJobTransition({
    jobId,
    targetStatus: 'unassigned',
    currentStatus,
    role: 'owner',
  });
}

/**
 * Cancels a job with a mandatory cancellation reason (Business Owner).
 */
export async function cancelJob(
  jobId: string,
  cancellationReason: string,
  currentStatus?: JobStatus
): Promise<JobTransitionResult> {
  return requestJobTransition({
    jobId,
    targetStatus: 'cancelled',
    reason: cancellationReason,
    currentStatus,
    role: 'owner',
  });
}



