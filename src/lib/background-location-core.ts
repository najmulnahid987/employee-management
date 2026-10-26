/**
 * Dispatcher Background Location Tracking Core
 *
 * Authoritative Specifications:
 * - docs/product-specification.md
 * - AGENTS.md (M4 & M11 Architecture)
 * - M11.5 Background Location for Active Jobs
 *
 * Platform-independent business logic and configuration builders for background location tracking:
 * 1. Background task name and storage keys.
 * 2. Active background job context models and serialization validation.
 * 3. Lifecycle status eligibility checks strictly aligned with M9 state machine.
 * 4. Configuration option builders for Android foreground service and iOS background modes.
 */

import type { RawCoordinates } from './location-tracker-core.ts';
import type { JobStatus } from './location-rules.ts';

export const DISPATCHER_BACKGROUND_LOCATION_TASK = 'dispatcher-background-location-task';
export const BACKGROUND_TRACKING_STORAGE_KEY = '@dispatcher/active_background_tracking';

export interface ActiveBackgroundJobContext {
  /** Active job identifier */
  jobId: string;
  /** Authenticated worker ID from session */
  workerId: string;
  /** Current lifecycle status */
  status: JobStatus;
  /** Epoch timestamp when tracking was initialized */
  startedAtMs: number;
  /** Epoch timestamp when the last successful upload occurred */
  lastRecordedTimestampMs?: number;
  /** Coordinates of the last successful upload */
  lastRecordedCoords?: RawCoordinates;
}

/**
 * Returns true if the status permits background location tracking.
 * Strictly permitted during active field stages: 'on_the_way', 'arrived', 'in_progress'.
 * Strictly forbidden during pre-travel ('unassigned', 'assigned', 'accepted')
 * and terminal statuses ('completed', 'cancelled').
 */
export function isEligibleForBackgroundTracking(status: string | null | undefined): boolean {
  if (!status) return false;
  return status === 'on_the_way' || status === 'arrived' || status === 'in_progress';
}

export interface ContextValidationResult {
  isValid: boolean;
  reason: string;
  context: ActiveBackgroundJobContext | null;
}

/**
 * Validates a candidate background tracking context from persistent storage.
 */
export function validateBackgroundJobContext(
  raw: unknown,
  expectedWorkerId?: string | null
): ContextValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { isValid: false, reason: 'Empty or non-object context.', context: null };
  }

  const obj = raw as Partial<ActiveBackgroundJobContext>;

  if (typeof obj.jobId !== 'string' || obj.jobId.trim().length === 0) {
    return { isValid: false, reason: 'Missing or empty jobId in context.', context: null };
  }

  if (typeof obj.workerId !== 'string' || obj.workerId.trim().length === 0) {
    return { isValid: false, reason: 'Missing or empty workerId in context.', context: null };
  }

  if (expectedWorkerId && obj.workerId !== expectedWorkerId) {
    return {
      isValid: false,
      reason: `Context worker ID (${obj.workerId}) does not match authenticated worker (${expectedWorkerId}).`,
      context: null,
    };
  }

  if (!isEligibleForBackgroundTracking(obj.status)) {
    return {
      isValid: false,
      reason: `Job status "${obj.status}" is not eligible for background tracking.`,
      context: null,
    };
  }

  return {
    isValid: true,
    reason: 'Valid background tracking context.',
    context: obj as ActiveBackgroundJobContext,
  };
}

export interface BackgroundServiceNotificationConfig {
  notificationTitle: string;
  notificationBody: string;
  notificationColor: string;
  killServiceOnDestroy: boolean;
}

export interface BackgroundLocationOptionsConfig {
  accuracyLevel: 'High' | 'Balanced';
  timeIntervalMs: number;
  distanceIntervalMeters: number;
  deferredUpdatesIntervalMs: number;
  deferredUpdatesDistanceMeters: number;
  showsBackgroundLocationIndicator: boolean;
  pausesUpdatesAutomatically: boolean;
  foregroundService: BackgroundServiceNotificationConfig;
}

/**
 * Builds platform-compliant background location options based on job status.
 */
export function buildBackgroundLocationOptionsConfig(
  status: JobStatus
): BackgroundLocationOptionsConfig {
  const isTravel = status === 'on_the_way';

  return {
    accuracyLevel: isTravel ? 'High' : 'Balanced',
    timeIntervalMs: isTravel ? 30000 : 180000,
    distanceIntervalMeters: isTravel ? 50 : 150,
    deferredUpdatesIntervalMs: isTravel ? 30000 : 180000,
    deferredUpdatesDistanceMeters: isTravel ? 50 : 150,
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: 'Dispatcher Active Visit',
      notificationBody: isTravel
        ? 'Sharing live travel location with dispatch'
        : 'Sharing on-site location with dispatch',
      notificationColor: '#000000',
      killServiceOnDestroy: false,
    },
  };
}
