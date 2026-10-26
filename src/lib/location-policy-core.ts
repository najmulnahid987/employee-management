/**
 * Dispatcher Location Tracking Policy Core
 *
 * Authoritative Specifications:
 * - docs/product-specification.md
 * - AGENTS.md (M4 & M11 Location Architecture)
 * - M9 Lifecycle State Machine
 *
 * Pure, platform-agnostic business logic and state machine rules for location tracking:
 * 1. Tracking policy engine governed strictly by the M9 state machine.
 * 2. Exact user-facing permission explanation and privacy contract.
 * 3. Permission state definitions and non-blocking notification strings.
 * 4. In-session dismissal state tracking to avoid repeated prompts.
 */

import type { JobStatus } from './location-rules.ts';

// =============================================================================
// 1. Authoritative Tracking Policy Engine
// =============================================================================

export type TrackingFrequencyMode = 'INACTIVE' | 'HIGH_FREQUENCY' | 'LOW_FREQUENCY';

export type TrackingAction = 'START' | 'THROTTLE' | 'STOP' | 'NONE';

export interface TrackingContext {
  /** Authenticated worker ID from session (profiles.id) */
  workerId: string | null;
  /** Whether the worker profile is active */
  isActiveWorker: boolean;
  /** Currently active or selected job */
  activeJob: {
    id: string;
    workerId: string | null;
    status: JobStatus;
  } | null;
  /** Job ID currently being tracked, if any */
  currentTrackingJobId: string | null;
  /** Current operating tracking mode */
  currentMode?: TrackingFrequencyMode;
}

export interface TrackingPolicyDecision {
  /** Action the tracking coordinator should execute */
  action: TrackingAction;
  /** Target job ID to track, or null if inactive */
  targetJobId: string | null;
  /** Resulting tracking frequency mode */
  trackingMode: TrackingFrequencyMode;
  /** Human-readable explanation of why this decision was reached */
  reason: string;
}

/**
 * Pure evaluation function implementing the M9-governed Dispatcher Location Tracking Policy.
 *
 * Invariants:
 * - `accepted`: do not start continuous location collection yet.
 * - `on_the_way`: start high-frequency tracking for this job.
 * - `arrived` / `in_progress`: continue with low-frequency updates while assigned and active.
 * - `completed` / `cancelled`: stop tracking immediately.
 * - Assignment cleared, job reassigned, worker declines, or worker signs out: stop tracking old job.
 * - If worker switches to another job: never reuse previous job ID; switch immediately.
 */
export function evaluateTrackingPolicy(context: TrackingContext): TrackingPolicyDecision {
  const { workerId, isActiveWorker, activeJob, currentTrackingJobId, currentMode = 'INACTIVE' } = context;

  // 1. Worker Authorization Guard
  if (!workerId || !isActiveWorker) {
    return {
      action: currentTrackingJobId ? 'STOP' : 'NONE',
      targetJobId: null,
      trackingMode: 'INACTIVE',
      reason: 'Worker is signed out or deactivated.',
    };
  }

  // 2. Active Job Presence Guard
  if (!activeJob) {
    return {
      action: currentTrackingJobId ? 'STOP' : 'NONE',
      targetJobId: null,
      trackingMode: 'INACTIVE',
      reason: 'No active job is assigned to this technician.',
    };
  }

  // 3. Worker Assignment Match Guard
  if (activeJob.workerId !== workerId) {
    return {
      action: currentTrackingJobId ? 'STOP' : 'NONE',
      targetJobId: null,
      trackingMode: 'INACTIVE',
      reason: 'Job is not assigned to the authenticated technician.',
    };
  }

  // 4. Job Lifecycle Status Gating
  switch (activeJob.status) {
    case 'on_the_way': {
      // Started travel: High-frequency tracking required
      const isSwitchingJob = currentTrackingJobId !== null && currentTrackingJobId !== activeJob.id;
      const isAlreadyHigh = currentTrackingJobId === activeJob.id && currentMode === 'HIGH_FREQUENCY';

      return {
        action: isAlreadyHigh ? 'NONE' : 'START',
        targetJobId: activeJob.id,
        trackingMode: 'HIGH_FREQUENCY',
        reason: isSwitchingJob
          ? `Switched active job from ${currentTrackingJobId} to ${activeJob.id} in on_the_way status.`
          : 'Technician is travelling to job site (high-frequency tracking active).',
      };
    }

    case 'arrived':
    case 'in_progress': {
      // On-site: Low-frequency tracking required
      const isSwitchingJob = currentTrackingJobId !== null && currentTrackingJobId !== activeJob.id;
      const isAlreadyLow = currentTrackingJobId === activeJob.id && currentMode === 'LOW_FREQUENCY';

      if (isSwitchingJob) {
        return {
          action: 'START',
          targetJobId: activeJob.id,
          trackingMode: 'LOW_FREQUENCY',
          reason: `Switched active job to ${activeJob.id} on-site visit.`,
        };
      }

      if (currentTrackingJobId === activeJob.id && isAlreadyLow) {
        return {
          action: 'NONE',
          targetJobId: activeJob.id,
          trackingMode: 'LOW_FREQUENCY',
          reason: 'Already tracking on-site visit with low-frequency heartbeat.',
        };
      }

      return {
        action: currentTrackingJobId === activeJob.id ? 'THROTTLE' : 'START',
        targetJobId: activeJob.id,
        trackingMode: 'LOW_FREQUENCY',
        reason: 'Technician is on-site (throttled to low-frequency heartbeat).',
      };
    }

    case 'unassigned':
    case 'assigned':
    case 'accepted': {
      // Pre-travel stages: Strictly NO continuous tracking
      return {
        action: currentTrackingJobId ? 'STOP' : 'NONE',
        targetJobId: null,
        trackingMode: 'INACTIVE',
        reason: `Job is in upcoming stage "${activeJob.status}"; location collection not permitted before field travel.`,
      };
    }

    case 'completed':
    case 'cancelled': {
      // Terminal stages: Must stop tracking immediately
      return {
        action: currentTrackingJobId ? 'STOP' : 'NONE',
        targetJobId: null,
        trackingMode: 'INACTIVE',
        reason: `Job is in terminal status "${activeJob.status}"; tracking stopped.`,
      };
    }

    default: {
      return {
        action: currentTrackingJobId ? 'STOP' : 'NONE',
        targetJobId: null,
        trackingMode: 'INACTIVE',
        reason: 'Unrecognized job status.',
      };
    }
  }
}

// =============================================================================
// 2. Permission States & Explanation Content
// =============================================================================

export type LocationPermissionState =
  | 'NOT_REQUESTED'
  | 'GRANTED'
  | 'APPROXIMATE'
  | 'DENIED'
  | 'BLOCKED'
  | 'RESTRICTED'
  | 'SERVICES_DISABLED';

export interface LocationPermissionStatusResult {
  state: LocationPermissionState;
  isLocationServicesEnabled: boolean;
  canAskAgain: boolean;
  details?: string;
}

/**
 * The frozen, authoritative user-facing location policy explanation.
 */
export const LOCATION_PERMISSION_EXPLANATION = {
  title: 'Location Sharing During Active Jobs',
  lead: 'Dispatcher shares your location with your business owner while you are handling an active job.',
  body: 'Location sharing starts when you begin travelling and stops when the job ends or is no longer assigned to you. Location is not tracked when you are off duty or have no eligible job.',
  bullets: [
    {
      title: 'Active Visits Only',
      text: "Sharing starts automatically when you tap 'Start Travel' (On The Way).",
    },
    {
      title: 'On-Site Reduced Frequency',
      text: 'Updates throttle to low-frequency heartbeats once you arrive at the job site.',
    },
    {
      title: 'Immediate Stop',
      text: 'Completely stops the instant a job is completed, cancelled, declined, or unassigned.',
    },
    {
      title: 'Zero Off-Duty Tracking',
      text: 'You are never tracked when off duty or without an active job.',
    },
  ],
  approximateNotice:
    'Approximate location was granted. Precise location provides the best dispatch accuracy, but you can continue using Dispatcher with approximate location.',
  deniedNotice:
    'Location access was not enabled. Live tracking will be unavailable to your dispatcher, but you can continue managing and updating your jobs.',
  servicesDisabledNotice:
    'Device location services are turned off. Enable GPS in your device settings to share live arrival updates.',
} as const;

// In-memory session tracker to prevent repetitive explanation popups in the same session
let hasDismissedExplanationInSession = false;

export function hasDismissedPermissionNotice(): boolean {
  return hasDismissedExplanationInSession;
}

export function setDismissedPermissionNotice(dismissed: boolean = true): void {
  hasDismissedExplanationInSession = dismissed;
}
