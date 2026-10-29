import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { fetchWorkerTodayJobs, Job, subscribeToJobTransitions } from '@/lib/jobs';
import { subscribeToJobSignals } from '@/lib/realtime';

export interface UseWorkerTodayReturn {
  heroJob: Job | null;
  queue: Job[];
  todayCompletedCount: number;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

/**
 * Hook providing real operations data for the Worker Today screen.
 * Scoped strictly to the authenticated worker's assigned jobs.
 */
export function useWorkerToday(): UseWorkerTodayReturn {
  const { businessId, user, role } = useAuth();
  const [heroJob, setHeroJob] = useState<Job | null>(null);
  const [queue, setQueue] = useState<Job[]>([]);
  const [todayCompletedCount, setTodayCompletedCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const activeRequestRef = useRef<number>(0);

  const loadData = useCallback(
    async (isPullRefresh: boolean = false) => {
      if (!businessId || !user?.id || role !== 'worker') {
        ++activeRequestRef.current;
        setHeroJob(null);
        setQueue([]);
        setTodayCompletedCount(0);
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
        const result = await fetchWorkerTodayJobs(businessId, user.id);

        if (activeRequestRef.current === requestId) {
          if (result.error) {
            setError(result.error);
          } else {
            setHeroJob(result.heroJob);
            setQueue(result.queue);
            setTodayCompletedCount(result.todayCompletedCount);
            setError(null);
          }
        }
      } catch (err) {
        if (activeRequestRef.current === requestId) {
          setError(err instanceof Error ? err.message : 'Failed to retrieve today assignments.');
        }
      } finally {
        if (activeRequestRef.current === requestId) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [businessId, user?.id, role]
  );

  useEffect(() => {
    loadData(false);
  }, [loadData]);

  // Clean unmount token invalidation
  useEffect(() => {
    const reqRef = activeRequestRef;
    return () => {
      reqRef.current++;
    };
  }, []);

  // Invalidate and reload operations automatically whenever a job transition occurs or Realtime signal arrives
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

  return {
    heroJob,
    queue,
    todayCompletedCount,
    isLoading,
    isRefreshing,
    error,
    refetch,
    onRefresh,
  };
}
