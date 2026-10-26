/**
 * Dispatcher Owner Live Locations Hook
 *
 * Implements M11.6 Owner Live Worker Location:
 * - Queries authorized active locations via get_owner_active_locations RPC.
 * - Strictly isolated to authenticated owner's business tenancy.
 * - Reconciles in real time via Supabase Realtime (locations CDC and jobs lifecycle signals).
 * - Accurately labels live vs stale vs low-accuracy fixes.
 * - Teardown on unmount and race-condition immunity via active request tokens.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import {
  calculateTerritorySummary,
  OwnerActiveLocation,
  processRawOwnerActiveLocation,
  RawOwnerActiveLocationRow,
  TerritorySummary,
} from '@/lib/owner-locations-core';
import { subscribeToJobTransitions } from '@/lib/jobs';
import { subscribeToJobSignals } from '@/lib/realtime';
import { supabase } from '@/lib/supabase';

export * from '@/lib/owner-locations-core';

export interface UseOwnerLocationsResult {
  locations: OwnerActiveLocation[];
  summary: TerritorySummary;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  lastFetchedAt: string | null;
  refetch: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

const INITIAL_SUMMARY: TerritorySummary = {
  totalActive: 0,
  enRouteCount: 0,
  onSiteCount: 0,
  staleCount: 0,
};

export function useOwnerLocations(): UseOwnerLocationsResult {
  const { businessId, role } = useAuth();
  const [locations, setLocations] = useState<OwnerActiveLocation[]>([]);
  const [summary, setSummary] = useState<TerritorySummary>(INITIAL_SUMMARY);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);

  // Concurrency token to ignore stale out-of-order responses
  const activeRequestRef = useRef<number>(0);

  const loadLocations = useCallback(
    async (isPullRefresh: boolean = false) => {
      if (!businessId || role !== 'owner') {
        setIsLoading(false);
        setIsRefreshing(false);
        return;
      }

      if (isPullRefresh) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      const requestId = ++activeRequestRef.current;

      try {
        const { data, error: rpcErr } = await supabase.rpc('get_owner_active_locations');

        if (activeRequestRef.current !== requestId) return;

        if (rpcErr) {
          setError(rpcErr.message);
          return;
        }

        const rows = (data || []) as RawOwnerActiveLocationRow[];
        const now = Date.now();
        const processed: OwnerActiveLocation[] = [];

        for (const row of rows) {
          const item = processRawOwnerActiveLocation(row, now);
          if (item) {
            processed.push(item);
          }
        }

        setLocations(processed);
        setSummary(calculateTerritorySummary(processed));
        setLastFetchedAt(new Date().toISOString());
        setError(null);
      } catch (err) {
        if (activeRequestRef.current === requestId) {
          setError(err instanceof Error ? err.message : 'Failed to load territory locations.');
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

  useEffect(() => {
    loadLocations(false);
  }, [loadLocations]);

  // Invalidate tokens on unmount
  useEffect(() => {
    return () => {
      activeRequestRef.current++;
    };
  }, []);

  // 1. Reconcile on Job Lifecycle & Location signals via centralized Realtime manager
  useEffect(() => {
    const unsubTransitions = subscribeToJobTransitions(() => {
      loadLocations(false);
    });
    const unsubSignals = subscribeToJobSignals(() => {
      loadLocations(false);
    });

    return () => {
      unsubTransitions();
      unsubSignals();
    };
  }, [loadLocations]);

  return {
    locations,
    summary,
    isLoading,
    isRefreshing,
    error,
    lastFetchedAt,
    refetch: () => loadLocations(false),
    onRefresh: () => loadLocations(true),
  };
}
