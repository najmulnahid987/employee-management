import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import {
  FetchJobHistoryOptions,
  fetchJobHistory,
  JobHistoryDatePreset,
  JobHistoryDateRange,
  JobHistoryStatusFilter,
  JobWithWorker,
  subscribeToJobTransitions,
} from '@/lib/jobs';
import { subscribeToJobSignals } from '@/lib/realtime';

export interface UseJobHistoryOptions {
  initialStatus?: JobHistoryStatusFilter;
  initialDatePreset?: JobHistoryDatePreset;
  customDateRange?: JobHistoryDateRange;
  pageSize?: number;
}

export interface UseJobHistoryReturn {
  jobs: JobWithWorker[];
  totalCount: number;
  isLoading: boolean;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  statusFilter: JobHistoryStatusFilter;
  datePreset: JobHistoryDatePreset;
  customDateRange?: JobHistoryDateRange;
  setStatusFilter: (status: JobHistoryStatusFilter) => void;
  setDatePreset: (preset: JobHistoryDatePreset) => void;
  setCustomDateRange: (range?: JobHistoryDateRange) => void;
  refetch: () => Promise<void>;
  onRefresh: () => Promise<void>;
  fetchNextPage: () => Promise<void>;
}

/**
 * Hook managing data loading, pagination, and filters for owner job history.
 * Keeps all Supabase querying out of presentational components.
 */
export function useJobHistory(options: UseJobHistoryOptions = {}): UseJobHistoryReturn {
  const { businessId, role } = useAuth();
  const pageSize = options.pageSize ?? 20;

  const [statusFilter, setStatusFilterState] = useState<JobHistoryStatusFilter>(
    options.initialStatus ?? 'completed'
  );
  const [datePreset, setDatePresetState] = useState<JobHistoryDatePreset>(
    options.initialDatePreset ?? 'all'
  );
  const [customDateRange, setCustomDateRangeState] = useState<JobHistoryDateRange | undefined>(
    options.customDateRange
  );

  const [jobs, setJobs] = useState<JobWithWorker[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [offset, setOffset] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Concurrency guard to discard out-of-order responses
  const activeRequestRef = useRef<number>(0);

  const loadData = useCallback(
    async (isPullRefresh: boolean = false) => {
      if (!businessId || role !== 'owner') {
        ++activeRequestRef.current;
        setJobs([]);
        setTotalCount(0);
        setHasMore(false);
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
        const result = await fetchJobHistory({
          businessId,
          status: statusFilter,
          datePreset,
          customDateRange,
          limit: pageSize,
          offset: 0,
        });

        if (activeRequestRef.current === requestId) {
          if (result.error) {
            setError(result.error);
          } else {
            setJobs(result.jobs);
            setTotalCount(result.totalCount);
            setOffset(result.jobs.length);
            setHasMore(result.hasMore);
            setError(null);
          }
        }
      } catch (err) {
        if (activeRequestRef.current === requestId) {
          setError(
            err instanceof Error ? err.message : 'Failed to retrieve job history.'
          );
        }
      } finally {
        if (activeRequestRef.current === requestId) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [businessId, role, statusFilter, datePreset, customDateRange, pageSize]
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

  // Listen to remote realtime signals and local state transitions
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

  const fetchNextPage = useCallback(async () => {
    if (!hasMore || isLoadingMore || isLoading || isRefreshing) {
      return;
    }

    if (!businessId || role !== 'owner') {
      return;
    }

    setIsLoadingMore(true);
    const requestId = activeRequestRef.current;

    try {
      const result = await fetchJobHistory({
        businessId,
        status: statusFilter,
        datePreset,
        customDateRange,
        limit: pageSize,
        offset,
      });

      if (activeRequestRef.current === requestId) {
        if (result.error) {
          setError(result.error);
        } else {
          setJobs((prev) => {
            const existingIds = new Set(prev.map((j) => j.id));
            const freshItems = result.jobs.filter((j) => !existingIds.has(j.id));
            return [...prev, ...freshItems];
          });
          setTotalCount(result.totalCount);
          setOffset((prev) => prev + result.jobs.length);
          setHasMore(result.hasMore);
        }
      }
    } catch (err) {
      if (activeRequestRef.current === requestId) {
        setError(
          err instanceof Error ? err.message : 'Failed to retrieve older job history.'
        );
      }
    } finally {
      if (activeRequestRef.current === requestId) {
        setIsLoadingMore(false);
      }
    }
  }, [hasMore, isLoadingMore, isLoading, isRefreshing, businessId, role, statusFilter, datePreset, customDateRange, pageSize, offset]);

  const setStatusFilter = useCallback((newStatus: JobHistoryStatusFilter) => {
    setStatusFilterState(newStatus);
  }, []);

  const setDatePreset = useCallback((newPreset: JobHistoryDatePreset) => {
    setDatePresetState(newPreset);
    setCustomDateRangeState(undefined);
  }, []);

  const setCustomDateRange = useCallback((range?: JobHistoryDateRange) => {
    setCustomDateRangeState(range);
    if (range) {
      setDatePresetState('all');
    }
  }, []);

  return {
    jobs,
    totalCount,
    isLoading,
    isRefreshing,
    isLoadingMore,
    hasMore,
    error,
    statusFilter,
    datePreset,
    customDateRange,
    setStatusFilter,
    setDatePreset,
    setCustomDateRange,
    refetch,
    onRefresh,
    fetchNextPage,
  };
}
