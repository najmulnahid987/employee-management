import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import {
  DashboardSections,
  DashboardSummary,
  fetchOwnerDashboardJobs,
  JobWithWorker,
  subscribeToJobTransitions,
} from '@/lib/jobs';
import { subscribeToJobSignals } from '@/lib/realtime';

export interface UseOwnerDashboardReturn {
  jobs: JobWithWorker[];
  sections: DashboardSections;
  summary: DashboardSummary;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  selectedDay: Date;
  businessName: string | null;
  setSelectedDay: (date: Date) => void;
  refetch: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

const INITIAL_SUMMARY: DashboardSummary = {
  total: 0,
  upcoming: 0,
  active: 0,
  completed: 0,
  cancelled: 0,
  unassigned: 0,
};

const INITIAL_SECTIONS: DashboardSections = {
  active: [],
  upcoming: [],
  completed: [],
};

/**
 * Hook providing data, sections, summary counts, and refresh state
 * for the Owner Operations Dashboard.
 */
export function useOwnerDashboard(initialDate: Date = new Date()): UseOwnerDashboardReturn {
  const { businessId, business, role } = useAuth();
  const [selectedDay, setSelectedDay] = useState<Date>(initialDate);
  const [jobs, setJobs] = useState<JobWithWorker[]>([]);
  const [sections, setSections] = useState<DashboardSections>(INITIAL_SECTIONS);
  const [summary, setSummary] = useState<DashboardSummary>(INITIAL_SUMMARY);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Tracks active request to ignore race conditions when day/business changes rapidly
  const activeRequestRef = useRef<number>(0);

  const loadData = useCallback(
    async (isPullRefresh: boolean = false) => {
      if (!businessId || role !== 'owner') {
        ++activeRequestRef.current;
        setJobs([]);
        setSections(INITIAL_SECTIONS);
        setSummary(INITIAL_SUMMARY);
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
        const result = await fetchOwnerDashboardJobs(businessId, selectedDay);

        if (activeRequestRef.current === requestId) {
          if (result.error) {
            setError(result.error);
          } else {
            setJobs(result.jobs);
            setSections(result.sections);
            setSummary(result.summary);
            setError(null);
          }
        }
      } catch (err) {
        if (activeRequestRef.current === requestId) {
          setError(
            err instanceof Error ? err.message : 'Failed to retrieve operations data.'
          );
        }
      } finally {
        if (activeRequestRef.current === requestId) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [businessId, role, selectedDay]
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
    jobs,
    sections,
    summary,
    isLoading,
    isRefreshing,
    error,
    selectedDay,
    businessName: business?.name ?? null,
    setSelectedDay,
    refetch,
    onRefresh,
  };
}
