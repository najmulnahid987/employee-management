/**
 * Dispatcher Owner Live Map Data Service
 *
 * Implements M12.3 Owner Live Map Data Service:
 * - Obtains the owner's business context authoritatively from the authenticated profile.
 * - Respects PostgreSQL RLS and uses verified relational schemas (profiles, jobs, locations).
 * - Executes small, batched queries: zero N+1 loops, never queries workers in a loop.
 * - Safely handles potential historical location rows by selecting the single latest row per worker/job.
 * - Matches each location strictly to its active, assigned job according to M9/M11 lifecycle rules.
 * - Renders truthful, non-fabricated telemetry: workers without valid GPS appear in untracked lists.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isTrackingEligibleStatus } from './location-rules';
import {
  buildOwnerLiveMapData,
  buildOwnerLiveMapWorkerItem,
  composeOwnerLiveMapData,
  OwnerLiveMapData,
  MAX_ACCURACY_THRESHOLD_METERS,
  STALE_TELEMETRY_THRESHOLD_MS,
} from './owner-locations-core';
import { supabase as defaultSupabase } from './supabase';
import type { Database } from '../types/database';

export * from './owner-locations-core';

export interface FetchOwnerLiveMapOptions {
  /** Maximum telemetry age before marked stale (defaults to 5 minutes: 300,000ms) */
  staleThresholdMs?: number;
  /** Maximum acceptable accuracy in meters before marked inaccurate (defaults to 200m) */
  maxAccuracyMeters?: number;
  /** Current time in ms for deterministic testing and freshness calculations */
  nowMs?: number;
}

export interface FetchOwnerLiveMapResult {
  data: OwnerLiveMapData | null;
  error: string | null;
}

/**
 * Priority rank for multiple jobs assigned to the same worker:
 * Active field visits (in_progress > arrived > on_the_way) take top priority,
 * followed by scheduled upcoming jobs (accepted > assigned).
 */
const STATUS_FIELD_PRIORITY: Record<string, number> = {
  in_progress: 1,
  arrived: 2,
  on_the_way: 3,
  accepted: 4,
  assigned: 5,
};

type JobRow = {
  id: string;
  worker_id: string | null;
  customer_name: string;
  service: string;
  address: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
  scheduled_at: string | null;
  updated_at: string;
};

type LocationRow = {
  id: string;
  worker_id: string;
  job_id: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  created_at: string;
};

/**
 * Authoritatively fetches and composes the complete Owner Live Map dataset.
 *
 * Query Strategy:
 * 1. Resolves caller's authenticated profile from public.profiles to verify owner role
 *    and obtain tenant business_id. Never trusts client-supplied business IDs.
 * 2. Batched Query 1: SELECT all worker profiles for this business (ORDER BY full_name).
 * 3. Batched Query 2: SELECT all non-terminal assigned jobs for this business.
 * 4. Batched Query 3: SELECT latest locations for eligible active field jobs (ordered by created_at DESC).
 * 5. In-memory composition into strongly-typed OwnerLiveMapData.
 *
 * Guaranteed: Max 3 queries total. Zero N+1 query loops.
 */
export async function fetchOwnerLiveMapData(
  options?: FetchOwnerLiveMapOptions,
  client: SupabaseClient<Database> = defaultSupabase
): Promise<FetchOwnerLiveMapResult> {
  const nowMs = options?.nowMs ?? Date.now();
  const staleThresholdMs = options?.staleThresholdMs ?? STALE_TELEMETRY_THRESHOLD_MS;
  const maxAccuracyMeters = options?.maxAccuracyMeters ?? MAX_ACCURACY_THRESHOLD_METERS;

  try {
    // -------------------------------------------------------------------------
    // 1. Authoritative Identity & Tenancy Verification
    // -------------------------------------------------------------------------
    const {
      data: { user },
      error: userErr,
    } = await client.auth.getUser();

    if (userErr || !user) {
      return {
        data: null,
        error: 'Authentication required to access live territory map.',
      };
    }

    const { data: ownerProfile, error: profileErr } = await client
      .from('profiles')
      .select('id, business_id, role, is_active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileErr) {
      return { data: null, error: profileErr.message };
    }

    if (!ownerProfile) {
      return { data: null, error: 'User profile not found.' };
    }

    if (ownerProfile.role !== 'owner') {
      return {
        data: null,
        error: 'Unauthorized: only business owners can access the territory live map.',
      };
    }

    const businessId = ownerProfile.business_id;
    if (!businessId) {
      return {
        data: null,
        error: 'Owner profile is not linked to an active business.',
      };
    }

    // -------------------------------------------------------------------------
    // 2. Batched Query 1: All Worker Profiles in this Business
    // -------------------------------------------------------------------------
    const { data: workerProfiles, error: workersErr } = await client
      .from('profiles')
      .select('id, full_name, avatar_url, phone, is_active')
      .eq('business_id', businessId)
      .eq('role', 'worker')
      .order('full_name', { ascending: true });

    if (workersErr) {
      return { data: null, error: workersErr.message };
    }

    if (!workerProfiles || workerProfiles.length === 0) {
      return {
        data: buildOwnerLiveMapData([], new Date(nowMs).toISOString()),
        error: null,
      };
    }

    // -------------------------------------------------------------------------
    // 3. Batched Query 2: All Non-Terminal Assigned Jobs in this Business
    // -------------------------------------------------------------------------
    const { data: rawJobs, error: jobsErr } = await client
      .from('jobs')
      .select('id, worker_id, customer_name, service, address, status, latitude, longitude, scheduled_at, updated_at')
      .eq('business_id', businessId)
      .not('worker_id', 'is', null)
      .not('status', 'in', '("completed","cancelled")');

    if (jobsErr) {
      return { data: null, error: jobsErr.message };
    }

    const nonTerminalJobs = (rawJobs || []) as JobRow[];

    // In-memory: map each worker to their single highest-priority current job
    const jobByWorkerId = new Map<string, JobRow>();

    for (const job of nonTerminalJobs) {
      if (!job.worker_id) continue;
      const existing = jobByWorkerId.get(job.worker_id);
      if (!existing) {
        jobByWorkerId.set(job.worker_id, job);
      } else {
        const priorityExisting = STATUS_FIELD_PRIORITY[existing.status] ?? 99;
        const priorityCurrent = STATUS_FIELD_PRIORITY[job.status] ?? 99;

        if (priorityCurrent < priorityExisting) {
          jobByWorkerId.set(job.worker_id, job);
        } else if (priorityCurrent === priorityExisting) {
          const timeExisting = existing.scheduled_at ? new Date(existing.scheduled_at).getTime() : 0;
          const timeCurrent = job.scheduled_at ? new Date(job.scheduled_at).getTime() : 0;
          if (timeCurrent < timeExisting) {
            jobByWorkerId.set(job.worker_id, job);
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 4. Batched Query 3: Locations for Eligible Active Field Jobs
    // -------------------------------------------------------------------------
    const eligibleJobIds: string[] = [];
    for (const [, job] of jobByWorkerId.entries()) {
      if (isTrackingEligibleStatus(job.status)) {
        eligibleJobIds.push(job.id);
      }
    }

    const latestLocationByWorkerId = new Map<string, LocationRow>();

    let rawLocations: LocationRow[] = [];

    if (eligibleJobIds.length > 0) {
      const { data: fetchedLocations, error: locationsErr } = await client
        .from('locations')
        .select('id, worker_id, job_id, latitude, longitude, accuracy, created_at')
        .in('job_id', eligibleJobIds)
        .order('created_at', { ascending: false });

      if (locationsErr) {
        return { data: null, error: locationsErr.message };
      }

      if (fetchedLocations) {
        rawLocations = fetchedLocations as LocationRow[];
        for (const loc of rawLocations) {
          // Because results are ordered by created_at DESC, the first row
          // encountered for each worker_id is strictly the latest sample.
          if (!latestLocationByWorkerId.has(loc.worker_id)) {
            latestLocationByWorkerId.set(loc.worker_id, loc);
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 5. In-Memory Composition of Unified View Model
    // -------------------------------------------------------------------------
    const compositeData = composeOwnerLiveMapData({
      workerProfiles,
      rawJobs: nonTerminalJobs,
      rawLocations: (rawLocations || []) as LocationRow[],
      options,
    });

    return { data: compositeData, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Failed to load live map data.',
    };
  }
}
