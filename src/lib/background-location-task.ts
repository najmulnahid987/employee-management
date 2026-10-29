/**
 * Dispatcher Background Location Task Manager
 *
 * Implements M11.5 Background Location for Active Jobs:
 * - Module-scope TaskManager.defineTask registration (required by Expo).
 * - Persistent active background job context in AsyncStorage.
 * - Platform-compliant configuration:
 *   - Android: Foreground service with ongoing persistent system notification.
 *   - iOS: showsBackgroundLocationIndicator (blue status bar pill) & UIBackgroundModes.
 *   - Conservative intervals matching M11.4 (30s / 50m travel; 3m / 150m on-site).
 * - Exact same validation and authorization path via evaluateCandidatePosition & record_worker_location RPC.
 * - Automatic teardown on job completion, cancellation, unassignment, decline, or sign-out.
 * - App launch state reconciliation to clean up orphaned/stale background tasks.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import {
  ActiveBackgroundJobContext,
  BACKGROUND_TRACKING_STORAGE_KEY,
  buildBackgroundLocationOptionsConfig,
  DISPATCHER_BACKGROUND_LOCATION_TASK,
  isEligibleForBackgroundTracking,
  validateBackgroundJobContext,
} from '@/lib/background-location-core';
import { JobStatus } from '@/lib/location-rules';
import {
  evaluateCandidatePosition,
  RawCoordinates,
} from '@/lib/location-tracker-core';
import { foregroundLocationTracker } from '@/lib/location-tracker';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';

export * from '@/lib/background-location-core';

// =============================================================================
// 1. Persistent Storage Helpers
// =============================================================================

export async function saveActiveBackgroundTrackingJob(
  context: ActiveBackgroundJobContext
): Promise<void> {
  try {
    await AsyncStorage.setItem(BACKGROUND_TRACKING_STORAGE_KEY, JSON.stringify(context));
  } catch (err) {
    logger.warn('BackgroundLocationTask', 'Failed to save active context:', err);
  }
}

export async function getActiveBackgroundTrackingJob(): Promise<ActiveBackgroundJobContext | null> {
  try {
    const raw = await AsyncStorage.getItem(BACKGROUND_TRACKING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const validation = validateBackgroundJobContext(parsed);
    return validation.isValid ? validation.context : null;
  } catch (err) {
    logger.warn('BackgroundLocationTask', 'Failed to read active context:', err);
    return null;
  }
}

export async function clearActiveBackgroundTrackingJob(): Promise<void> {
  try {
    await AsyncStorage.removeItem(BACKGROUND_TRACKING_STORAGE_KEY);
  } catch (err) {
    logger.warn('BackgroundLocationTask', 'Failed to clear active context:', err);
  }
}

// =============================================================================
// 2. Headless Location Fix Processing
// =============================================================================

export async function handleBackgroundLocationFixes(
  locations: Location.LocationObject[]
): Promise<void> {
  if (!locations || locations.length === 0) return;

  const context = await getActiveBackgroundTrackingJob();
  if (!context || !isEligibleForBackgroundTracking(context.status)) {
    // Orphaned or stale background task: stop immediately
    logger.info('BackgroundLocationTask', 'Stale background task fix received without active context. Stopping.');
    await stopBackgroundTrackingAsync();
    foregroundLocationTracker.stopTracking();
    return;
  }

  // Find single freshest location fix; discard older buffered fixes
  const latest = locations[locations.length - 1];
  if (!latest?.coords) return;

  const candidate: RawCoordinates = {
    latitude: latest.coords.latitude,
    longitude: latest.coords.longitude,
    accuracy: latest.coords.accuracy ?? null,
    timestamp: latest.timestamp,
  };

  // Evaluate candidate fix using the approved M11.4 core rules
  const evaluation = evaluateCandidatePosition({
    candidate,
    lastSubmitted: context.lastRecordedCoords ?? null,
    lastSubmittedTimestampMs: context.lastRecordedTimestampMs ?? 0,
    nowTimestampMs: Date.now(),
  });

  if (!evaluation.shouldSubmit) {
    logger.info('BackgroundLocationTask', `Fix skipped: ${evaluation.reason}`);
    return;
  }

  // Transmit location to Supabase via the approved record_worker_location RPC
  try {
    const { error } = await supabase.rpc('record_worker_location', {
      p_job_id: context.jobId,
      p_latitude: candidate.latitude,
      p_longitude: candidate.longitude,
      p_accuracy: candidate.accuracy,
    });

    if (error) {
      logger.warn('BackgroundLocationTask', 'RPC rejected:', error.message);

      // If the job transitioned or authorization ended, stop background updates immediately
      if (
        error.message.includes('not in status') ||
        error.message.includes('not assigned') ||
        error.code === '42501' ||
        error.code === 'P0001'
      ) {
        await stopBackgroundTrackingAsync();
        foregroundLocationTracker.stopTracking();
      }
      return;
    }

    // Update stored coordinates for deduplication
    context.lastRecordedTimestampMs = Date.now();
    context.lastRecordedCoords = candidate;
    await saveActiveBackgroundTrackingJob(context);

    logger.info('BackgroundLocationTask', `Location recorded in background for job ${context.jobId}`);
  } catch (netErr) {
    logger.warn('BackgroundLocationTask', 'Network error in background:', netErr);
  }
}

// =============================================================================
// 3. Module-Scope Task Registration (Required by TaskManager)
// =============================================================================

if (!TaskManager.isTaskDefined(DISPATCHER_BACKGROUND_LOCATION_TASK)) {
  TaskManager.defineTask(
    DISPATCHER_BACKGROUND_LOCATION_TASK,
    async ({ data, error }: TaskManager.TaskManagerTaskBody<{ locations?: Location.LocationObject[] }>) => {
      if (error) {
        logger.warn('BackgroundLocationTask', 'Task error:', error);
        return;
      }

      if (data?.locations) {
        await handleBackgroundLocationFixes(data.locations);
      }
    }
  );
}

// =============================================================================
// 4. Background Tracking Lifecycle API
// =============================================================================

/**
 * Checks whether background location permission is currently granted.
 */
export async function checkHasBackgroundPermission(): Promise<boolean> {
  try {
    const perm = await Location.getBackgroundPermissionsAsync();
    return perm.status === Location.PermissionStatus.GRANTED;
  } catch {
    return false;
  }
}

/**
 * Starts or reconfigures background location tracking for an active job.
 * Enforces pre-flight database validation to guarantee that old persisted tasks
 * cannot resume for terminal, reassigned, or unauthorized jobs.
 */
export async function startBackgroundTrackingAsync(
  jobId: string,
  workerId: string,
  status: JobStatus
): Promise<boolean> {
  if (!jobId || !workerId || !isEligibleForBackgroundTracking(status)) {
    await stopBackgroundTrackingAsync();
    return false;
  }

  // 1. Check background permission
  const hasBgPerm = await checkHasBackgroundPermission();
  if (!hasBgPerm) {
    logger.info('BackgroundLocationTask', 'Background location permission not granted.');
    return false;
  }

  // 2. Check location services
  const isServicesEnabled = await Location.hasServicesEnabledAsync();
  if (!isServicesEnabled) {
    logger.info('BackgroundLocationTask', 'Location services are disabled on device.');
    return false;
  }

  // 3. Pre-flight check: verify actual database state before starting background task
  try {
    const { data: job, error: jobErr } = await supabase
      .from('jobs')
      .select('id, status, worker_id')
      .eq('id', jobId)
      .maybeSingle();

    if (
      jobErr ||
      !job ||
      job.worker_id !== workerId ||
      !isEligibleForBackgroundTracking(job.status)
    ) {
      logger.warn(
        'BackgroundLocationTask',
        `Pre-flight failed: job ${jobId} is not active/assigned in database.`
      );
      await stopBackgroundTrackingAsync();
      return false;
    }
  } catch (err) {
    logger.warn('BackgroundLocationTask', 'Pre-flight database check error:', err);
  }

  // 4. Check if already configured for the exact same job and status
  const isRegistered = await TaskManager.isTaskRegisteredAsync(DISPATCHER_BACKGROUND_LOCATION_TASK);
  const activeContext = await getActiveBackgroundTrackingJob();

  if (isRegistered && activeContext?.jobId === jobId && activeContext?.status === status) {
    return true;
  }

  // 5. Stop any existing background task before reconfiguring
  if (isRegistered) {
    try {
      await Location.stopLocationUpdatesAsync(DISPATCHER_BACKGROUND_LOCATION_TASK);
    } catch {
      // Ignore teardown error
    }
  }

  // 6. Build platform-compliant options
  const config = buildBackgroundLocationOptionsConfig(status);
  const options: Location.LocationTaskOptions = {
    accuracy:
      config.accuracyLevel === 'High' ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: config.timeIntervalMs,
    distanceInterval: config.distanceIntervalMeters,
    deferredUpdatesInterval: config.deferredUpdatesIntervalMs,
    deferredUpdatesDistance: config.deferredUpdatesDistanceMeters,
    showsBackgroundLocationIndicator: config.showsBackgroundLocationIndicator,
    pausesUpdatesAutomatically: config.pausesUpdatesAutomatically,
    foregroundService: config.foregroundService,
  };

  try {
    // 7. Persist active job context before launching background listener
    await saveActiveBackgroundTrackingJob({
      jobId,
      workerId,
      status,
      startedAtMs: Date.now(),
      lastRecordedCoords: activeContext?.jobId === jobId ? activeContext?.lastRecordedCoords : undefined,
      lastRecordedTimestampMs: activeContext?.jobId === jobId ? activeContext?.lastRecordedTimestampMs : undefined,
    });

    // 8. Register background location task with OS
    await Location.startLocationUpdatesAsync(DISPATCHER_BACKGROUND_LOCATION_TASK, options);

    logger.info('BackgroundLocationTask', `Started background tracking for ${jobId} (${status})`);
    return true;
  } catch (err) {
    logger.warn('BackgroundLocationTask', 'Failed to start background location updates:', err);
    await clearActiveBackgroundTrackingJob();
    return false;
  }
}

/**
 * Stops background location updates and cleans up persistent storage.
 * Idempotent: safe to invoke repeatedly.
 */
export async function stopBackgroundTrackingAsync(): Promise<void> {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(
      DISPATCHER_BACKGROUND_LOCATION_TASK
    );
    if (isRegistered) {
      await Location.stopLocationUpdatesAsync(DISPATCHER_BACKGROUND_LOCATION_TASK);
      logger.info('BackgroundLocationTask', 'Background location updates stopped.');
    }
  } catch (err) {
    logger.warn('BackgroundLocationTask', 'Error stopping location updates:', err);
  } finally {
    await clearActiveBackgroundTrackingJob();
  }
}

/**
 * Checks whether background location updates are currently running.
 */
export async function isBackgroundTrackingActiveAsync(): Promise<boolean> {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(
      DISPATCHER_BACKGROUND_LOCATION_TASK
    );
    if (!isRegistered) return false;
    const context = await getActiveBackgroundTrackingJob();
    return context !== null && isEligibleForBackgroundTracking(context.status);
  } catch {
    return false;
  }
}

/**
 * Authoritatively reconciles active foreground and background tracking sessions against database state.
 *
 * Called on:
 * 1. App launch
 * 2. App foreground return (AppState -> 'active')
 * 3. Network / Realtime reconnection
 * 4. User sign-in / account switch
 *
 * If the session is invalid, unauthenticated, non-worker, or the job has reached
 * a terminal state ('completed', 'cancelled') or was reassigned/unassigned,
 * this function immediately and idempotently shuts down both background and
 * foreground tracking and purges persistent context storage.
 */
export async function reconcileActiveTrackingSession(
  currentUserId?: string | null,
  currentUserRole?: string | null
): Promise<{ wasStopped: boolean; reason?: string }> {
  try {
    const isBgRegistered = await TaskManager.isTaskRegisteredAsync(
      DISPATCHER_BACKGROUND_LOCATION_TASK
    );
    const bgContext = await getActiveBackgroundTrackingJob();
    const fgState = foregroundLocationTracker.getState();

    // 1. If nothing is tracking or registered, ensure persistent context is clean
    if (!isBgRegistered && !bgContext && !fgState.isTracking) {
      return { wasStopped: false };
    }

    // 2. If unauthenticated or role is not worker: terminate all tracking immediately
    if (!currentUserId || currentUserRole !== 'worker') {
      logger.info('TrackingReconciliation', 'Stopping tracking: unauthenticated or non-worker.');
      foregroundLocationTracker.stopTracking();
      await stopBackgroundTrackingAsync();
      return { wasStopped: true, reason: 'Unauthenticated or non-worker session' };
    }

    // 3. Resolve active job ID being tracked across foreground and background
    const activeJobId = bgContext?.jobId ?? fgState.activeJobId;
    if (!activeJobId) {
      if (isBgRegistered || bgContext) {
        await stopBackgroundTrackingAsync();
      }
      if (fgState.isTracking) {
        foregroundLocationTracker.stopTracking();
      }
      return { wasStopped: true, reason: 'No active job ID found in tracking state' };
    }

    // 4. Verify context worker matches current authenticated worker
    if (bgContext && bgContext.workerId !== currentUserId) {
      logger.info('TrackingReconciliation', 'Stopping tracking: worker mismatch.');
      foregroundLocationTracker.stopTracking();
      await stopBackgroundTrackingAsync();
      return { wasStopped: true, reason: 'Worker ID mismatch in tracking context' };
    }

    // 5. Query Supabase for authoritative database job state
    const { data: job, error } = await supabase
      .from('jobs')
      .select('id, status, worker_id')
      .eq('id', activeJobId)
      .maybeSingle();

    if (
      error ||
      !job ||
      job.worker_id !== currentUserId ||
      !isEligibleForBackgroundTracking(job.status)
    ) {
      logger.info(
        'TrackingReconciliation',
        `Job ${activeJobId} no longer active or assigned (status: ${job?.status}). Stopping tracking.`
      );
      foregroundLocationTracker.stopTracking();
      await stopBackgroundTrackingAsync();
      return {
        wasStopped: true,
        reason: error?.message ?? `Job is not active (status: ${job?.status ?? 'not_found'})`,
      };
    }

    // 6. Job is still valid and assigned! If status changed, update background context
    if (bgContext && bgContext.status !== job.status) {
      bgContext.status = job.status as JobStatus;
      await saveActiveBackgroundTrackingJob(bgContext);
    }

    return { wasStopped: false };
  } catch (err) {
    logger.warn('TrackingReconciliation', 'Error during tracking reconciliation:', err);
    return { wasStopped: false, reason: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Reconciles background tracking tasks at app launch.
 * Cleans up stale or orphaned tasks from previous sessions, logouts, or completed jobs.
 */
export async function reconcileBackgroundTrackingOnLaunch(
  currentUserId: string | null | undefined,
  currentUserRole: string | null | undefined
): Promise<void> {
  await reconcileActiveTrackingSession(currentUserId, currentUserRole);
}
