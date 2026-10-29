import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { fetchWorkerAssignedJobs, Job, subscribeToJobTransitions } from '@/lib/jobs';
import { subscribeToJobSignals } from '@/lib/realtime';

export type WorkerJobTab = 'active' | 'completed';

export interface UseWorkerJobsReturn {
  activeAndUpcoming: Job[];
  completed: Job[];
  displayedJobs: Job[];
  selectedTab: WorkerJobTab;
  setSelectedTab: (tab: WorkerJobTab) => void;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

/**
 * Hook providing real assigned jobs for the Worker Jobs list screen.
 * Partitioned into Active/Upcoming and Completed service visits.
 */
export function useWorkerJobs(): UseWorkerJobsReturn {
  const { businessId, user, role } = useAuth();
  const [activeAndUpcoming, setActiveAndUpcoming] = useState<Job[]>([]);
  const [completed, setCompleted] = useState<Job[]>([]);
  const [selectedTab, setSelectedTab] = useState<WorkerJobTab>('active');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const activeRequestRef = useRef<number>(0);

  const loadData = useCallback(
    async (isPullRefresh: boolean = false) => {
      if (!businessId || !user?.id || role !== 'worker') {
        ++activeRequestRef.current;
        setActiveAndUpcoming([]);
        setCompleted([]);
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
        const result = await fetchWorkerAssignedJobs(businessId, user.id);

        if (activeRequestRef.current === requestId) {
          if (result.error) {
            setError(result.error);
          } else {
            setActiveAndUpcoming(result.activeAndUpcoming);
            setCompleted(result.completed);
            setError(null);
          }
        }
      } catch (err) {
        if (activeRequestRef.current === requestId) {
          setError(err instanceof Error ? err.message : 'Failed to retrieve assigned jobs.');
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

  const displayedJobs = selectedTab === 'active' ? activeAndUpcoming : completed;

  return {
    activeAndUpcoming,
    completed,
    displayedJobs,
    selectedTab,
    setSelectedTab,
    isLoading,
    isRefreshing,
    error,
    refetch,
    onRefresh,
  };
}
