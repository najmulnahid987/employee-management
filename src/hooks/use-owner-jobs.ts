import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import {
  fetchOwnerJobsList,
  filterOwnerJobs,
  JobWithWorker,
  OwnerJobFilter,
  subscribeToJobTransitions,
} from '@/lib/jobs';
import { subscribeToJobSignals } from '@/lib/realtime';

export interface UseOwnerJobsReturn {
  jobs: JobWithWorker[];
  filteredJobs: JobWithWorker[];
  filterCounts: Record<OwnerJobFilter, number>;
  selectedFilter: OwnerJobFilter;
  setSelectedFilter: (filter: OwnerJobFilter) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

const INITIAL_COUNTS: Record<OwnerJobFilter, number> = {
  all: 0,
  unassigned: 0,
  active: 0,
  completed: 0,
  cancelled: 0,
};

/**
 * Hook providing data, search, filtering, and real-time synchronization
 * for the Owner Jobs list screen.
 */
export function useOwnerJobs(): UseOwnerJobsReturn {
  const { businessId, role } = useAuth();
  const [jobs, setJobs] = useState<JobWithWorker[]>([]);
  const [selectedFilter, setSelectedFilter] = useState<OwnerJobFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Tracks active request ID to ignore race condition responses
  const activeRequestRef = useRef<number>(0);

  const loadData = useCallback(
    async (isPullRefresh: boolean = false) => {
      if (!businessId || role !== 'owner') {
        ++activeRequestRef.current;
        setJobs([]);
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
        const result = await fetchOwnerJobsList(businessId);
        if (activeRequestRef.current === requestId) {
          if (result.error) {
            setError(result.error);
          } else {
            setJobs(result.jobs);
            setError(null);
          }
        }
      } catch (err) {
        if (activeRequestRef.current === requestId) {
          setError(
            err instanceof Error ? err.message : 'Failed to retrieve jobs list.'
          );
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
    loadData(false);
  }, [loadData]);

  // Clean unmount token invalidation
  useEffect(() => {
    return () => {
      activeRequestRef.current++;
    };
  }, []);

  // Automatically invalidate and reload jobs whenever a local transition or remote Realtime event occurs
  useEffect(() => {
    const unsubTransitions = subscribeToJobTransitions(() => {
      loadData(false);
    });
    const unsubSignals = subscribeToJobSignals(() => {
      loadData(false);
    });
    return () => {
      unsubTransitions();
      unsubSignals();
    };
  }, [loadData]);

  const refetch = useCallback(async () => {
    await loadData(false);
  }, [loadData]);

  const onRefresh = useCallback(async () => {
    await loadData(true);
  }, [loadData]);

  const filterCounts = useMemo<Record<OwnerJobFilter, number>>(() => {
    if (!jobs || jobs.length === 0) {
      return INITIAL_COUNTS;
    }
    return {
      all: jobs.length,
      unassigned: jobs.filter(
        (j) => j.status === 'unassigned' || (!j.worker_id && j.status !== 'completed' && j.status !== 'cancelled')
      ).length,
      active: jobs.filter(
        (j) =>
          j.status === 'assigned' ||
          j.status === 'accepted' ||
          j.status === 'on_the_way' ||
          j.status === 'arrived' ||
          j.status === 'in_progress'
      ).length,
      completed: jobs.filter((j) => j.status === 'completed').length,
      cancelled: jobs.filter((j) => j.status === 'cancelled').length,
    };
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    return filterOwnerJobs(jobs, selectedFilter, searchQuery);
  }, [jobs, selectedFilter, searchQuery]);

  return {
    jobs,
    filteredJobs,
    filterCounts,
    selectedFilter,
    setSelectedFilter,
    searchQuery,
    setSearchQuery,
    isLoading,
    isRefreshing,
    error,
    refetch,
    onRefresh,
  };
}
