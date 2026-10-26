/**
 * Dispatcher Supabase Realtime Subscription Manager
 *
 * Implements the shared, role-scoped Realtime subscription manager for jobs.
 * Reuses the singleton Supabase client, enforces multi-tenant business isolation,
 * and bridges remote change signals to the local invalidation bus.
 *
 * Key Invariants:
 * - Exactly one managed channel per authenticated context.
 * - Narrowly scoped to public.jobs table (INSERT and UPDATE only).
 * - Events are treated as signals to reconcile, never as authoritative objects.
 * - Old channels are cleanly removed via supabase.removeChannel(channel).
 */

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import { notifyJobTransition } from '@/lib/jobs';
import {
  buildJobsChannelTopic,
  buildJobsSubscriptionFilter,
  createManagedJobsSubscriptionCore,
  createReconcileSignal,
  createSignalDebouncer,
  JobRealtimeSignal,
  ManagedJobsSubscription,
  ManagedJobsSubscriptionCallbacks,
  notifyJobSignal,
  parseLocationPostgresPayload,
  parsePostgresChangePayload,
  parseProfilePostgresPayload,
  RealtimeConnectionStatus,
  RealtimeSubscriptionConfig,
  subscribeToJobSignals,
  validateSubscriptionContext,
} from '@/lib/realtime-core';
import { supabase as defaultSupabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export * from '@/lib/realtime-core';

/**
 * Creates and registers a managed Realtime subscription for service jobs.
 *
 * Binds strictly to:
 * - Table: `jobs` (INSERT & UPDATE, filtered by business_id for owner or worker_id for worker)
 * - Table: `locations` (INSERT & UPDATE, filtered by worker_id for worker, RLS-enforced for owner)
 * - Table: `profiles` (UPDATE, filtered by business_id for owner)
 *
 * Automatically debounces burst events and notifies the existing
 * `notifyJobTransition` bus to keep all subscribed screens fresh.
 */
export function createManagedJobsSubscription(
  config: RealtimeSubscriptionConfig,
  callbacks: ManagedJobsSubscriptionCallbacks,
  client: SupabaseClient<Database> = defaultSupabase
): ManagedJobsSubscription {
  return createManagedJobsSubscriptionCore(
    config,
    callbacks,
    client as any,
    notifyJobTransition
  );
}

/**
 * Checks whether the Supabase Realtime WebSocket client and specific channel are healthy.
 * Uses only documented properties of the official Supabase SDK.
 */
export function checkRealtimeHealth(
  client: SupabaseClient<Database> = defaultSupabase,
  channel?: RealtimeChannel | null
): { isSocketConnected: boolean; isChannelSubscribed: boolean; isHealthy: boolean } {
  const isSocketConnected =
    typeof client.realtime?.isConnected === 'function' ? client.realtime.isConnected() : false;

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
export function ensureRealtimeSocketConnected(
  client: SupabaseClient<Database> = defaultSupabase
): void {
  try {
    if (typeof client.realtime?.isConnected === 'function' && !client.realtime.isConnected()) {
      client.realtime.connect();
    }
  } catch (err) {
    if (__DEV__) {
      console.warn('[RealtimeManager] Socket connect error:', err);
    }
  }
}

let lastReconcileTimestamp = 0;
const RECONCILIATION_THROTTLE_MS = 250;

/**
 * Triggers an authoritative reconciliation signal across all active listeners and screens.
 * Throttles rapid bursts (e.g. concurrent foreground + focus + network events) within 250ms
 * to prevent flooding the database with identical overlapping requests.
 */
export function triggerJobsReconciliation(reason: string = 'manual', force: boolean = false): void {
  const now = Date.now();
  if (!force && now - lastReconcileTimestamp < RECONCILIATION_THROTTLE_MS) {
    return;
  }
  lastReconcileTimestamp = now;

  const signal = createReconcileSignal(reason);
  notifyJobSignal(signal);
  // Also signal wildcard on transition bus
  notifyJobTransition('*', 'unassigned');
}
