/**
 * Dispatcher Owner Live Map Hook
 *
 * Implements M12.6 Realtime Owner Live Map Updates:
 * - Loads authoritative live map data via fetchOwnerLiveMapData().
 * - Scoped strictly to the authenticated owner's business tenancy.
 * - Categorizes workers into activeMarkers (valid, fresh coordinates on operational jobs)
 *   and untrackedWorkers (stale telemetry, awaiting fix, scheduled, or idle).
 * - Connected directly to centralized M10 Realtime manager (subscribeToJobSignals & subscribeToJobTransitions).
 * - Reacts to location changes, job status/assignment changes, worker profile updates, and reconnect/foreground.
 * - Concurrency control with active request token to prevent out-of-order or stale responses.
 * - Background updates do not set isLoading: true when data is present, preserving camera and marker focus.
 * - Supports pull-to-refresh, focus reconciliation, and manual retry.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { subscribeToJobTransitions } from '@/lib/jobs';
import {
  fetchOwnerLiveMapData,
  OwnerLiveMapData,
  OwnerLiveMapSummary,
} from '@/lib/owner-live-map-service';
import { subscribeToJobSignals } from '@/lib/realtime';

export interface UseOwnerLiveMapResult {
  data: OwnerLiveMapData | null;
  summary: OwnerLiveMapSummary;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  lastFetchedAt: string | null;
  refetch: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

const INITIAL_SUMMARY: OwnerLiveMapSummary = {
  totalWorkers: 0,
  activeOnDuty: 0,
  liveTracked: 0,
  staleTracked: 0,
  lowAccuracyCount: 0,
  awaitingFixCount: 0,
  enRouteCount: 0,
  onSiteCount: 0,
  upcomingCount: 0,
  idleCount: 0,
};

export function useOwnerLiveMap(): UseOwnerLiveMapResult {
  const { businessId, role } = useAuth();
  const [data, setData] = useState<OwnerLiveMapData | null>(null);
  const [summary, setSummary] = useState<OwnerLiveMapSummary>(INITIAL_SUMMARY);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);

  const activeRequestRef = useRef<number>(0);
  const dataRef = useRef<OwnerLiveMapData | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const loadData = useCallback(
    async (isPullRefresh: boolean = false, isBackground: boolean = false) => {
      if (!businessId || role !== 'owner') {
        setIsLoading(false);
        setIsRefreshing(false);
        return;
      }

      if (isPullRefresh) {
        setIsRefreshing(true);
      } else if (!isBackground || !dataRef.current) {
        setIsLoading(true);
      }
      setError(null);

      const requestId = ++activeRequestRef.current;

      try {
        const result = await fetchOwnerLiveMapData();

        if (activeRequestRef.current !== requestId) return;

        if (result.error) {
          setError(result.error);
          return;
        }

        if (result.data) {
          setData(result.data);
          setSummary(result.data.summary);
          setLastFetchedAt(result.data.fetchedAt);
          setError(null);
        }
      } catch (err) {
        if (activeRequestRef.current === requestId) {
          setError(err instanceof Error ? err.message : 'Failed to load live map data.');
        }
      } finally {
        if (activeRequestRef.current === requestId) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [businessId, role]
  );

  // Initial load
  useEffect(() => {
    loadData(false, false);
  }, [loadData]);

  // Reconcile on Realtime change signals (jobs, locations, profiles, reconnect, foreground)
  useEffect(() => {
    if (!businessId || role !== 'owner') return;

    // 1. Subscribe to centralized Realtime change bus (locations, jobs, profiles CDC signals)
    const unsubSignals = subscribeToJobSignals(() => {
      loadData(false, true);
    });

    // 2. Subscribe to local/remote transition invalidation bus
    const unsubTransitions = subscribeToJobTransitions(() => {
      loadData(false, true);
    });

    return () => {
      unsubSignals();
      unsubTransitions();
    };
  }, [businessId, role, loadData]);

  // Clean teardown: invalidate in-flight network requests on unmount
  useEffect(() => {
    const reqRef = activeRequestRef;
    return () => {
      reqRef.current++;
    };
  }, []);

  return {
    data,
    summary,
    isLoading,
    isRefreshing,
    error,
    lastFetchedAt,
    refetch: () => loadData(false, true),
    onRefresh: () => loadData(true, false),
  };
}
