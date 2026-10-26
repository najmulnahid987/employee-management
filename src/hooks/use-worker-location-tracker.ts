/**
 * Dispatcher Worker Foreground & Background Location Tracker Hook
 *
 * Synchronizes the location tracking service with the active job lifecycle.
 *
 * Responsibilities:
 * - Starts foreground tracking when assigned job enters 'on_the_way'.
 * - Reconfigures to lower frequency upon 'arrived' or 'in_progress'.
 * - Coordinates background tracking via startBackgroundTrackingAsync if background permission is granted.
 * - Cleanly stops tracking on 'completed', 'cancelled', unassignment, decline, or sign-out.
 * - Exposes real-time tracking status, background active flag, and errors for honest UI display.
 */

import { useEffect, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';

import {
  isBackgroundTrackingActiveAsync,
  reconcileActiveTrackingSession,
  startBackgroundTrackingAsync,
  stopBackgroundTrackingAsync,
} from '@/lib/background-location-task';
import {
  foregroundLocationTracker,
  RawCoordinates,
  TrackerState,
} from '@/lib/location-tracker';
import { LocationPermissionState } from '@/lib/location-policy';
import { JobStatus } from '@/lib/location-rules';
import { subscribeToJobSignals } from '@/lib/realtime';

export interface UseWorkerLocationTrackerProps {
  jobId: string | null | undefined;
  workerId?: string | null | undefined;
  jobStatus: JobStatus | null | undefined;
  isAssignedToCurrentWorker: boolean;
  permissionState: LocationPermissionState;
  backgroundPermissionState?: LocationPermissionState;
}

export interface UseWorkerLocationTrackerResult {
  isTracking: boolean;
  isBackgroundActive: boolean;
  trackingMode: 'INACTIVE' | 'HIGH_FREQUENCY' | 'LOW_FREQUENCY';
  lastPosition: RawCoordinates | null;
  lastSubmittedAt: string | null;
  isWriting: boolean;
  trackingError: string | null;
}

export function useWorkerLocationTracker({
  jobId,
  workerId,
  jobStatus,
  isAssignedToCurrentWorker,
  permissionState,
}: UseWorkerLocationTrackerProps): UseWorkerLocationTrackerResult {
  const [state, setState] = useState<TrackerState>(foregroundLocationTracker.getState());
  const [isBackgroundActive, setIsBackgroundActive] = useState<boolean>(false);

  // 1. Subscribe to foreground tracker updates
  useEffect(() => {
    const unsubscribe = foregroundLocationTracker.subscribe((newState) => {
      setState(newState);
    });
    return unsubscribe;
  }, []);

  // 2. Synchronize lifecycle transitions for both foreground and background
  useEffect(() => {
    let isCancelled = false;

    const syncTracking = async () => {
      const isPermissionOk = permissionState === 'GRANTED' || permissionState === 'APPROXIMATE';
      const isEligibleStatus =
        jobStatus === 'on_the_way' || jobStatus === 'arrived' || jobStatus === 'in_progress';

      if (jobId && isAssignedToCurrentWorker && isEligibleStatus && isPermissionOk) {
        // Start/reconfigure foreground tracking
        await foregroundLocationTracker.startTracking(jobId, jobStatus as JobStatus);

        // Start/reconfigure background tracking if worker ID is present
        if (workerId) {
          const bgStarted = await startBackgroundTrackingAsync(
            jobId,
            workerId,
            jobStatus as JobStatus
          );
          if (!isCancelled) {
            setIsBackgroundActive(bgStarted);
          }
        }
      } else {
        // If job completed, cancelled, unassigned, or permission missing: stop both
        if (foregroundLocationTracker.getState().isTracking) {
          foregroundLocationTracker.stopTracking();
        }
        await stopBackgroundTrackingAsync();
        if (!isCancelled) {
          setIsBackgroundActive(false);
        }
      }
    };

    syncTracking();

    return () => {
      isCancelled = true;
    };
  }, [jobId, workerId, jobStatus, isAssignedToCurrentWorker, permissionState]);

  // 3. Reconcile current tracking session on AppState return to foreground
  useEffect(() => {
    let isMounted = true;

    const handleAppStateChange = async (nextState: AppStateStatus) => {
      if (nextState === 'active' && workerId) {
        const result = await reconcileActiveTrackingSession(workerId, 'worker');
        const active = await isBackgroundTrackingActiveAsync();
        if (isMounted) {
          setIsBackgroundActive(active);
        }
        if (result.wasStopped && foregroundLocationTracker.getState().isTracking) {
          foregroundLocationTracker.stopTracking();
        }
      }
    };

    const sub = AppState.addEventListener('change', handleAppStateChange);

    return () => {
      isMounted = false;
      sub.remove();
    };
  }, [workerId]);

  // 4. Reconcile on Realtime change signals
  useEffect(() => {
    let isMounted = true;

    const unsubscribe = subscribeToJobSignals((signal) => {
      if (signal.jobId === jobId || signal.jobId === '*') {
        // If a terminal status is signaled, immediately stop local foreground tracker
        if (signal.newStatus === 'completed' || signal.newStatus === 'cancelled') {
          foregroundLocationTracker.stopTracking();
          stopBackgroundTrackingAsync();
          if (isMounted) {
            setIsBackgroundActive(false);
          }
        }
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [jobId]);

  // 5. Periodic check of background tracking status
  useEffect(() => {
    let isMounted = true;
    const checkBgStatus = async () => {
      const active = await isBackgroundTrackingActiveAsync();
      if (isMounted) {
        setIsBackgroundActive(active);
      }
    };
    checkBgStatus();
    return () => {
      isMounted = false;
    };
  }, [jobId, jobStatus]);

  // 6. Foreground cleanup on screen unmount
  useEffect(() => {
    return () => {
      foregroundLocationTracker.stopTracking();
    };
  }, []);

  return {
    isTracking: state.isTracking,
    isBackgroundActive,
    trackingMode: state.trackingMode,
    lastPosition: state.lastPosition,
    lastSubmittedAt: state.lastSubmittedAt,
    isWriting: state.isWriting,
    trackingError: state.error,
  };
}
