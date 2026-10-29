/**
 * Dispatcher Realtime Core & Channel Utilities
 *
 * Implements pure logic, topic naming, filter generation, payload parsing,
 * signal bus, debouncing, and architectural edge-case documentation for
 * Supabase Realtime subscriptions.
 *
 * Scoped strictly to:
 * - public.jobs table
 * - INSERT and UPDATE events
 * - Role-appropriate filters (owner: business_id=eq, worker: worker_id=eq)
 *
 * Architectural Invariant:
 * Realtime events are change/invalidation SIGNALS, never trusted as complete
 * authoritative data objects. Receipt of a signal triggers authoritative,
 * RLS-validated queries from the Supabase database.
 */

/**
 * Frozen 8-status lifecycle inventory (aligned with product spec & lifecycle.ts)
 */
export type JobStatus =
  | 'unassigned'
  | 'assigned'
  | 'accepted'
  | 'on_the_way'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

const FROZEN_JOB_STATUSES = new Set<string>([
  'unassigned',
  'assigned',
  'accepted',
  'on_the_way',
  'arrived',
  'in_progress',
  'completed',
  'cancelled',
]);

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && FROZEN_JOB_STATUSES.has(value);
}

export type OwnerJobFilter = 'all' | 'unassigned' | 'active' | 'completed' | 'cancelled';

export interface FilterableJobItem {
  id: string;
  status: string;
  worker_id: string | null;
  customer_name: string;
  service: string;
  address: string;
  worker?: { full_name: string } | null;
}

/**
 * Filters owner jobs by lifecycle stage and optional text search.
 */
export function filterOwnerJobs<T extends FilterableJobItem>(
  jobs: T[],
  filter: OwnerJobFilter,
  searchQuery: string = ''
): T[] {
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

export type RealtimeConnectionStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'SUBSCRIBED'
  | 'TIMED_OUT'
  | 'CLOSED'
  | 'CHANNEL_ERROR';

export type JobRealtimeEventType = 'INSERT' | 'UPDATE' | 'RECONCILE';

export type RealtimeSignalTable = 'jobs' | 'locations' | 'profiles';

export interface JobRealtimeSignal {
  /** Identifier of the affected job, or '*' for a broadcast reconciliation signal */
  jobId: string;
  /** Postgres change event type or reconciliation trigger */
  eventType: JobRealtimeEventType;
  /** Validated new status, if available in the event payload */
  newStatus: JobStatus | null;
  /** Unix timestamp in milliseconds when the signal was generated */
  timestamp: number;
  /** Origin of the signal: remote server event or local reconciliation trigger */
  source: 'remote' | 'local_reconcile';
  /** Target table that triggered the change signal */
  table?: RealtimeSignalTable;
  /** Associated worker profile identifier if present in the event */
  workerId?: string | null;
}

export interface RealtimeSubscriptionConfig {
  /** User role derived authoritatively from public.profiles */
  role: 'owner' | 'worker';
  /** Business ID derived authoritatively from public.profiles.business_id */
  businessId: string;
  /** Worker profile ID derived authoritatively from auth.uid() */
  workerId?: string | null;
}

export type JobSignalListener = (signal: JobRealtimeSignal) => void;

/**
 * =============================================================================
 * IMPORTANT ARCHITECTURAL EDGE CASE: Worker Assignment Revocation
 * =============================================================================
 *
 * In Supabase Realtime (Postgres Changes CDC with Row Level Security):
 *
 * 1. Filter Limitation:
 *    A field worker's subscription is filtered by `worker_id=eq.<worker_id>`.
 *    When an owner unassigns a job (setting `worker_id = NULL`) or reassigns it
 *    to another technician, the `new` record has `worker_id != <worker_id>`.
 *    Consequently, the Realtime client-side filter drops the event because `new`
 *    does not match the subscription filter.
 *
 * 2. RLS Limitation:
 *    Under policy `jobs_select`, a worker can only SELECT jobs where
 *    `worker_id = auth.uid()`. When a job is unassigned, the worker no longer
 *    passes RLS for the `new` record. Supabase Realtime evaluates RLS on the
 *    server and will not broadcast `new` to an unauthorized client.
 *
 * 3. Safe Reconciliation Strategy in Dispatcher:
 *    Because Realtime cannot guarantee row-exit delivery without broad table
 *    access or complex trigger workarounds (both forbidden in MVP):
 *    - The Realtime Manager exposes `reconcile()`.
 *    - Reconcile is triggered automatically on AppState resume (foregrounding).
 *    - Screen focus (`useFocusEffect`) always queries authoritative Supabase state.
 *    - Attempting an action on an unassigned job triggers backend rejection and
 *      authoritative recovery via `requestJobTransition`.
 *
 * 4. Future Architecture Prerequisite:
 *    If instant push notifications for unassignment are required in a future phase,
 *    a dedicated append-only notification table (e.g. `worker_notifications`)
 *    with worker-scoped RLS is required. Bypassing RLS or using permissive public
 *    channels is strictly prohibited.
 * =============================================================================
 */
export const WORKER_ASSIGNMENT_EDGE_CASE_DOC = {
  limitation:
    'Realtime filter worker_id=eq.<id> drops UPDATE events when worker_id changes to NULL or another worker.',
  mitigation:
    'Focus and foreground reconciliation via authoritative Supabase queries evicts stale unassigned jobs.',
  prerequisiteForInstantPush:
    'Requires an append-only worker_notifications ledger with worker-scoped RLS. Bypassing RLS is forbidden.',
};

/**
 * Validates the authenticated subscription configuration.
 * Ensures untrusted or partial identities cannot initialize subscriptions.
 */
export function validateSubscriptionContext(config: RealtimeSubscriptionConfig): {
  valid: boolean;
  reason?: string;
} {
  if (!config) {
    return { valid: false, reason: 'Missing subscription configuration.' };
  }
  if (config.role !== 'owner' && config.role !== 'worker') {
    return { valid: false, reason: `Invalid role: "${config.role}". Must be "owner" or "worker".` };
  }

  const trimmedBusinessId = config.businessId?.trim();
  if (!trimmedBusinessId) {
    return { valid: false, reason: 'Business ID is required for Realtime subscriptions.' };
  }

  if (config.role === 'worker') {
    const trimmedWorkerId = config.workerId?.trim();
    if (!trimmedWorkerId) {
      return { valid: false, reason: 'Worker ID is required for technician Realtime subscriptions.' };
    }
  }

  return { valid: true };
}

/**
 * Builds a non-guessable, privacy-safe channel topic name.
 * Uses opaque UUIDs. Never exposes customer names, phone numbers, or addresses in topics.
 */
export function buildJobsChannelTopic(role: 'owner' | 'worker', entityId: string): string {
  if (!role || (role !== 'owner' && role !== 'worker')) {
    throw new Error(`Invalid role for channel topic: "${role}". Must be "owner" or "worker".`);
  }
  const trimmed = entityId?.trim();
  if (!trimmed) {
    throw new Error('Entity ID is required to build a Realtime channel topic.');
  }

  return role === 'owner' ? `business:${trimmed}:jobs` : `worker:${trimmed}:jobs`;
}

/**
 * Builds the verified PostgreSQL Realtime CDC filter string.
 * - Owner: scopes to all jobs in the trusted business (`business_id=eq.<id>`).
 * - Worker: scopes to jobs assigned to the authenticated technician (`worker_id=eq.<id>`).
 */
export function buildJobsSubscriptionFilter(role: 'owner' | 'worker', entityId: string): string {
  const trimmed = entityId?.trim();
  if (!trimmed) {
    throw new Error('Entity ID is required to build a Realtime subscription filter.');
  }

  return role === 'owner' ? `business_id=eq.${trimmed}` : `worker_id=eq.${trimmed}`;
}

/**
 * Computes a deterministic identity key for deduplicating active subscriptions.
 */
export function computeSubscriptionKey(config: RealtimeSubscriptionConfig | null): string {
  if (!config) return 'none';
  const { valid } = validateSubscriptionContext(config);
  if (!valid) return 'invalid';

  const role = config.role;
  const businessId = config.businessId.trim();
  const workerId = config.workerId?.trim() || '';

  return `${role}:${businessId}:${workerId}`;
}

/**
 * Parses raw Postgres Change records into a typed `JobRealtimeSignal`.
 * Safely validates `id` and `status` without assuming joined worker or event data.
 */
export function parsePostgresChangePayload(
  eventType: 'INSERT' | 'UPDATE',
  record: Record<string, unknown> | null | undefined
): JobRealtimeSignal | null {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const id = typeof record.id === 'string' ? record.id.trim() : null;
  if (!id) {
    return null;
  }

  const rawStatus = typeof record.status === 'string' ? record.status.trim() : null;
  const newStatus = rawStatus && isJobStatus(rawStatus) ? rawStatus : null;
  const workerId = typeof record.worker_id === 'string' ? record.worker_id.trim() : null;

  return {
    jobId: id,
    eventType,
    newStatus,
    timestamp: Date.now(),
    source: 'remote',
    table: 'jobs',
    workerId: workerId || null,
  };
}

/**
 * Parses raw Postgres Change records for public.locations into a typed `JobRealtimeSignal`.
 * Safely extracts worker_id and job_id without assuming coordinates are valid.
 */
export function parseLocationPostgresPayload(
  eventType: 'INSERT' | 'UPDATE',
  record: Record<string, unknown> | null | undefined
): JobRealtimeSignal | null {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const workerId = typeof record.worker_id === 'string' ? record.worker_id.trim() : null;
  const rawJobId = typeof record.job_id === 'string' ? record.job_id.trim() : null;
  const jobId = rawJobId || '*';

  // If both worker_id and job_id are missing, payload is invalid
  if (!workerId && jobId === '*') {
    return null;
  }

  return {
    jobId,
    eventType,
    newStatus: null,
    timestamp: Date.now(),
    source: 'remote',
    table: 'locations',
    workerId: workerId || null,
  };
}

/**
 * Parses raw Postgres Change records for public.profiles into a typed `JobRealtimeSignal`.
 * Scoped to worker profile updates (e.g. full_name, is_active).
 */
export function parseProfilePostgresPayload(
  eventType: 'UPDATE',
  record: Record<string, unknown> | null | undefined
): JobRealtimeSignal | null {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const workerId = typeof record.id === 'string' ? record.id.trim() : null;
  if (!workerId) {
    return null;
  }

  return {
    jobId: '*',
    eventType,
    newStatus: null,
    timestamp: Date.now(),
    source: 'remote',
    table: 'profiles',
    workerId,
  };
}

/**
 * Creates a broadcast reconciliation signal to prompt all active screens/hooks
 * to refetch authorized Supabase queries (e.g. on focus or reconnect).
 */
export function createReconcileSignal(reason: string = 'reconcile'): JobRealtimeSignal {
  return {
    jobId: '*',
    eventType: 'RECONCILE',
    newStatus: null,
    timestamp: Date.now(),
    source: 'local_reconcile',
  };
}

/**
 * In-memory signal bus for Realtime change events.
 */
const signalListeners = new Set<JobSignalListener>();

export function subscribeToJobSignals(listener: JobSignalListener): () => void {
  signalListeners.add(listener);
  return () => {
    signalListeners.delete(listener);
  };
}

export function notifyJobSignal(signal: JobRealtimeSignal): void {
  signalListeners.forEach((listener) => {
    try {
      listener(signal);
    } catch (err) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[RealtimeCore] Signal listener threw an exception:', msg);
      }
    }
  });
}

export function clearAllSignalListeners(): void {
  signalListeners.clear();
}

/**
 * Creates a debounce queue to coalesce rapid bursts of trigger events.
 * - Broadcast reconciliation signals (jobId === '*' and no workerId) are dispatched immediately.
 * - Locations signals are coalesced per worker (`locations:<workerId>`).
 * - Profiles signals are coalesced per worker (`profiles:<workerId>`).
 * - Jobs signals are coalesced per job (`jobs:<jobId>`).
 */
export function createSignalDebouncer(
  delayMs: number,
  onDispatch: (signal: JobRealtimeSignal) => void
): {
  dispatch: (signal: JobRealtimeSignal) => void;
  cancelAll: () => void;
} {
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    dispatch: (signal: JobRealtimeSignal) => {
      // Reconcile broadcast signals without specific worker entity are dispatched immediately
      if (signal.jobId === '*' && !signal.workerId) {
        onDispatch(signal);
        return;
      }

      // Determine debounce key:
      let debounceKey = signal.jobId;
      if (signal.table === 'locations' && signal.workerId) {
        debounceKey = `locations:${signal.workerId}`;
      } else if (signal.table === 'profiles' && signal.workerId) {
        debounceKey = `profiles:${signal.workerId}`;
      } else if (signal.jobId && signal.jobId !== '*') {
        debounceKey = `jobs:${signal.jobId}`;
      }

      const existingTimer = pendingTimers.get(debounceKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        pendingTimers.delete(debounceKey);
        onDispatch(signal);
      }, delayMs);

      pendingTimers.set(debounceKey, timer);
    },

    cancelAll: () => {
      pendingTimers.forEach((timer) => clearTimeout(timer));
      pendingTimers.clear();
    },
  };
}

export interface RealtimeHealthClient {
  realtime?: {
    isConnected?: () => boolean;
    connect?: () => void;
  };
}

export interface RealtimeHealthChannel {
  state?: string;
}

/**
 * Checks whether the Supabase Realtime WebSocket client and specific channel are healthy.
 * Uses only documented properties of the official Supabase SDK.
 */
export function checkRealtimeHealth(
  client?: RealtimeHealthClient | null,
  channel?: RealtimeHealthChannel | null
): { isSocketConnected: boolean; isChannelSubscribed: boolean; isHealthy: boolean } {
  const isSocketConnected =
    typeof client?.realtime?.isConnected === 'function' ? client.realtime.isConnected() : false;

  const isChannelSubscribed = channel ? channel.state === 'joined' : true;

  return {
    isSocketConnected,
    isChannelSubscribed,
    isHealthy: isSocketConnected && isChannelSubscribed,
  };
}

/**
 * Ensures the underlying Realtime socket client is actively connected using Supabase SDK APIs.
 */
export function ensureRealtimeSocketConnected(client?: RealtimeHealthClient | null): boolean {
  if (typeof client?.realtime?.isConnected === 'function' && !client.realtime.isConnected()) {
    if (typeof client.realtime.connect === 'function') {
      client.realtime.connect();
      return true;
    }
  }
  return false;
}

let lastCoreReconcileTimestamp = 0;
const CORE_RECONCILIATION_THROTTLE_MS = 250;

/**
 * Triggers an authoritative reconciliation signal across all active listeners and screens.
 * Throttles rapid bursts within 250ms unless force is specified.
 */
export function triggerCoreReconciliation(reason: string = 'manual', force: boolean = false): boolean {
  const now = Date.now();
  if (!force && now - lastCoreReconcileTimestamp < CORE_RECONCILIATION_THROTTLE_MS) {
    return false;
  }
  lastCoreReconcileTimestamp = now;

  const signal = createReconcileSignal(reason);
  notifyJobSignal(signal);
  return true;
}

export function resetReconciliationThrottle(): void {
  lastCoreReconcileTimestamp = 0;
}

export interface ManagedRealtimeChannel {
  state?: string;
  on: (type: string, options: any, callback: (payload: any) => void) => ManagedRealtimeChannel;
  subscribe: (statusCallback: (status: string, err?: any) => void) => ManagedRealtimeChannel;
}

export interface ManagedRealtimeClient {
  channel: (topic: string) => ManagedRealtimeChannel;
  removeChannel: (channel: any) => Promise<any>;
}

export interface ManagedJobsSubscription {
  /** The non-guessable, privacy-safe channel topic name */
  getTopic: () => string;
  /** The verified CDC filter applied to the channel */
  getFilter: () => string;
  /** Supported client cleanup handler */
  unsubscribe: () => Promise<void>;
  /** Reference to the underlying Realtime channel */
  getChannel: () => any;
}

export interface ManagedJobsSubscriptionCallbacks {
  /** Called whenever the channel connection status changes */
  onStatusChange: (status: RealtimeConnectionStatus, error?: string | null) => void;
  /** Called when a validated change signal is dispatched */
  onSignal?: (signal: JobRealtimeSignal) => void;
}

/**
 * Pure core subscription creator for service jobs, locations, and profiles.
 *
 * Scopes strictly to:
 * - Table: `jobs` (INSERT & UPDATE, filtered by business_id for owner or worker_id for worker)
 * - Table: `locations` (INSERT & UPDATE, filtered by worker_id for worker, RLS-enforced for owner)
 * - Table: `profiles` (UPDATE, filtered by business_id for owner)
 */
export function createManagedJobsSubscriptionCore(
  config: RealtimeSubscriptionConfig,
  callbacks: ManagedJobsSubscriptionCallbacks,
  client: ManagedRealtimeClient,
  notifyTransition?: (jobId: string, status: JobStatus) => void
): ManagedJobsSubscription {
  const { valid, reason } = validateSubscriptionContext(config);
  if (!valid) {
    throw new Error(`Cannot initialize Realtime subscription: ${reason}`);
  }

  const targetEntityId = config.role === 'owner' ? config.businessId : config.workerId!;
  const topic = buildJobsChannelTopic(config.role, targetEntityId);
  const filter = buildJobsSubscriptionFilter(config.role, targetEntityId);

  // Debounce incoming signals by 150ms to coalesce rapid database triggers
  const debouncer = createSignalDebouncer(150, (signal: JobRealtimeSignal) => {
    // 1. Notify Realtime signal bus
    notifyJobSignal(signal);

    // 2. Notify existing job transition invalidation bus if provided
    if (signal.jobId !== '*' && signal.newStatus && notifyTransition) {
      notifyTransition(signal.jobId, signal.newStatus);
    }

    // 3. Optional callback
    callbacks.onSignal?.(signal);
  });

  const channel = client.channel(topic);

  // 1. Bind narrowly to INSERT events on public.jobs
  channel.on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'jobs',
      filter,
    },
    (payload: any) => {
      const signal = parsePostgresChangePayload('INSERT', payload?.new as Record<string, unknown>);
      if (signal) {
        debouncer.dispatch(signal);
      }
    }
  );

  // 2. Bind narrowly to UPDATE events on public.jobs
  channel.on(
    'postgres_changes',
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'jobs',
      filter,
    },
    (payload: any) => {
      const signal = parsePostgresChangePayload('UPDATE', payload?.new as Record<string, unknown>);
      if (signal) {
        debouncer.dispatch(signal);
      }
    }
  );

  // 3. Bind to INSERT events on public.locations
  const locationFilter = config.role === 'worker' ? `worker_id=eq.${config.workerId!}` : undefined;

  channel.on(
    'postgres_changes',
    locationFilter
      ? {
          event: 'INSERT',
          schema: 'public',
          table: 'locations',
          filter: locationFilter,
        }
      : {
          event: 'INSERT',
          schema: 'public',
          table: 'locations',
        },
    (payload: any) => {
      const signal = parseLocationPostgresPayload('INSERT', payload?.new as Record<string, unknown>);
      if (signal) {
        debouncer.dispatch(signal);
      }
    }
  );

  // 4. Bind to UPDATE events on public.locations
  channel.on(
    'postgres_changes',
    locationFilter
      ? {
          event: 'UPDATE',
          schema: 'public',
          table: 'locations',
          filter: locationFilter,
        }
      : {
          event: 'UPDATE',
          schema: 'public',
          table: 'locations',
        },
    (payload: any) => {
      const signal = parseLocationPostgresPayload('UPDATE', payload?.new as Record<string, unknown>);
      if (signal) {
        debouncer.dispatch(signal);
      }
    }
  );

  // 5. Bind to UPDATE events on public.profiles (for owners to observe worker roster changes)
  if (config.role === 'owner') {
    channel.on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
        filter: `business_id=eq.${config.businessId}`,
      },
      (payload: any) => {
        const signal = parseProfilePostgresPayload('UPDATE', payload?.new as Record<string, unknown>);
        if (signal) {
          debouncer.dispatch(signal);
        }
      }
    );
  }

  // Connect and handle subscription state lifecycle
  channel.subscribe((status: string, err?: any) => {
    if (status === 'SUBSCRIBED') {
      callbacks.onStatusChange('SUBSCRIBED', null);
    } else if (status === 'TIMED_OUT') {
      callbacks.onStatusChange('TIMED_OUT', 'Realtime connection timed out.');
    } else if (status === 'CHANNEL_ERROR') {
      callbacks.onStatusChange('CHANNEL_ERROR', err?.message || 'Realtime channel error.');
    } else if (status === 'CLOSED') {
      callbacks.onStatusChange('CLOSED', null);
    }
  });

  return {
    getTopic: () => topic,
    getFilter: () => filter,
    getChannel: () => channel,
    unsubscribe: async () => {
      debouncer.cancelAll();
      try {
        await client.removeChannel(channel);
      } catch (err) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('[RealtimeManager] removeChannel error:', msg);
        }
      }
    },
  };
}

