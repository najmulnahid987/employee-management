/**
 * Dispatcher Foreground Location Tracker Core
 *
 * Authoritative Specifications:
 * - docs/product-specification.md
 * - AGENTS.md (M4 & M11 Architecture)
 * - M11.4 Foreground GPS Tracking
 *
 * Implements pure, platform-independent algorithms for:
 * 1. Haversine distance calculations between GPS coordinates.
 * 2. Position evaluation (filtering invalid coordinates, excessive inaccuracy, and unchanged duplicates).
 * 3. Concurrency-safe write coalescing queue preventing unbounded write buffers.
 * 4. Frequency & distance target profiles for travel vs on-site stages.
 */

// =============================================================================
// 1. Target Configurations
// =============================================================================

export interface TrackingProfile {
  /** Target time interval between OS location samples in milliseconds */
  timeIntervalMs: number;
  /** Target distance movement in meters before OS produces a new fix */
  distanceIntervalMeters: number;
  /** High vs Balanced accuracy level label */
  accuracyLabel: 'High' | 'Balanced';
}

/**
 * Travel Mode (on_the_way):
 * Target of ~30 seconds between updates or 50 meters of movement.
 */
export const TRAVEL_TRACKING_PROFILE: TrackingProfile = {
  timeIntervalMs: 30000,
  distanceIntervalMeters: 50,
  accuracyLabel: 'High',
};

/**
 * On-Site Mode (arrived, in_progress):
 * Reduced frequency while working on-site: ~3 minutes or 150 meters.
 */
export const ONSITE_TRACKING_PROFILE: TrackingProfile = {
  timeIntervalMs: 180000,
  distanceIntervalMeters: 150,
  accuracyLabel: 'Balanced',
};

/**
 * Maximum acceptable accuracy threshold in meters.
 * Positions with accuracy worse than 200m (e.g. cellular tower triangulation)
 * are rejected as too inaccurate for active dispatch.
 */
export const MAX_ACCURACY_THRESHOLD_METERS = 200.0;

/**
 * Minimum movement in meters required to consider a position changed.
 */
export const MIN_SIGNIFICANT_MOVEMENT_METERS = 10.0;

/**
 * Minimum time in milliseconds before sending a stationary update
 * (prevents duplicate spam when technician is waiting at a red light or stationary).
 */
export const MIN_STATIONARY_INTERVAL_MS = 60000;

// =============================================================================
// 2. Pure Calculations & Geometry
// =============================================================================

export interface RawCoordinates {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp?: number;
}

/**
 * Calculates great-circle distance between two GPS points using the Haversine formula.
 * Returns distance in meters.
 */
export function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  if (lat1 === lat2 && lon1 === lon2) return 0;

  const EARTH_RADIUS_METERS = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export interface PositionEvaluationParams {
  candidate: RawCoordinates;
  lastSubmitted: RawCoordinates | null;
  lastSubmittedTimestampMs: number;
  nowTimestampMs?: number;
}

export interface PositionEvaluationResult {
  shouldSubmit: boolean;
  reason: string;
}

/**
 * Evaluates whether a candidate GPS fix should be submitted to Supabase.
 * Enforces range validation, accuracy threshold, and stationary deduplication.
 */
export function evaluateCandidatePosition(
  params: PositionEvaluationParams
): PositionEvaluationResult {
  const {
    candidate,
    lastSubmitted,
    lastSubmittedTimestampMs,
    nowTimestampMs = Date.now(),
  } = params;

  // 1. Boundary & Finite Number Validation
  if (
    typeof candidate.latitude !== 'number' ||
    typeof candidate.longitude !== 'number' ||
    !isFinite(candidate.latitude) ||
    !isFinite(candidate.longitude)
  ) {
    return { shouldSubmit: false, reason: 'Coordinates contain non-finite numbers.' };
  }

  if (candidate.latitude < -90.0 || candidate.latitude > 90.0) {
    return { shouldSubmit: false, reason: 'Latitude is out of valid bounds [-90, 90].' };
  }

  if (candidate.longitude < -180.0 || candidate.longitude > 180.0) {
    return { shouldSubmit: false, reason: 'Longitude is out of valid bounds [-180, 180].' };
  }

  // 2. Accuracy Threshold Validation
  if (candidate.accuracy !== null && candidate.accuracy !== undefined) {
    if (typeof candidate.accuracy !== 'number' || !isFinite(candidate.accuracy) || candidate.accuracy < 0) {
      return { shouldSubmit: false, reason: 'Accuracy is not a valid non-negative number.' };
    }
    if (candidate.accuracy > MAX_ACCURACY_THRESHOLD_METERS) {
      return {
        shouldSubmit: false,
        reason: `GPS accuracy (±${Math.round(candidate.accuracy)}m) exceeds threshold of ${MAX_ACCURACY_THRESHOLD_METERS}m.`,
      };
    }
  }

  // 3. First Submission Guard
  if (!lastSubmitted || lastSubmittedTimestampMs === 0) {
    return { shouldSubmit: true, reason: 'Initial position fix for active job.' };
  }

  // 4. Duplicate / Stationary Deduplication
  const distanceMoved = calculateHaversineDistance(
    lastSubmitted.latitude,
    lastSubmitted.longitude,
    candidate.latitude,
    candidate.longitude
  );

  const timeElapsedMs = nowTimestampMs - lastSubmittedTimestampMs;

  // If movement is under 10 meters and time elapsed is under 60 seconds, skip duplicate
  if (distanceMoved < MIN_SIGNIFICANT_MOVEMENT_METERS && timeElapsedMs < MIN_STATIONARY_INTERVAL_MS) {
    return {
      shouldSubmit: false,
      reason: `Stationary position fix (moved ${distanceMoved.toFixed(1)}m < ${MIN_SIGNIFICANT_MOVEMENT_METERS}m in ${Math.round(timeElapsedMs / 1000)}s).`,
    };
  }

  return {
    shouldSubmit: true,
    reason: `Position changed by ${distanceMoved.toFixed(1)}m (${Math.round(timeElapsedMs / 1000)}s since last write).`,
  };
}

// =============================================================================
// 3. Concurrency-Safe Coalescing Buffer
// =============================================================================

export type WriteExecutor = (coords: RawCoordinates) => Promise<boolean>;

/**
 * Concurrency manager preventing overlapping writes and bounded queue overflow.
 * Guarantees at most ONE network mutation in flight.
 * If multiple fixes arrive while a write is in progress, only the single freshest fix is retained.
 */
export class LocationCoalescingQueue {
  private isWriting = false;
  private pendingFix: RawCoordinates | null = null;
  private isStopped = false;
  private readonly writeExecutor: WriteExecutor;

  constructor(writeExecutor: WriteExecutor) {
    this.writeExecutor = writeExecutor;
  }

  public getIsWriting(): boolean {
    return this.isWriting;
  }

  public getHasPending(): boolean {
    return this.pendingFix !== null;
  }

  public getIsStopped(): boolean {
    return this.isStopped;
  }

  /**
   * Resets the stopped state when starting a new tracking session.
   */
  public reset(): void {
    this.pendingFix = null;
    this.isWriting = false;
    this.isStopped = false;
  }

  /**
   * Immediately clears pending fixes and marks the queue as stopped.
   * Any in-flight write completing afterwards will discard its pending buffer
   * and will not trigger subsequent submissions.
   */
  public clear(): void {
    this.pendingFix = null;
    this.isStopped = true;
    this.isWriting = false;
  }

  /**
   * Enqueues a candidate coordinate fix.
   * If the queue is stopped, the fix is immediately discarded.
   * If a write is currently in progress, replaces the pending buffer with this freshest fix.
   * Otherwise, immediately starts the write.
   */
  public async submit(fix: RawCoordinates): Promise<void> {
    if (this.isStopped) {
      return;
    }

    if (this.isWriting) {
      // Coalesce: keep only the single newest fix
      this.pendingFix = fix;
      return;
    }

    this.isWriting = true;
    try {
      await this.writeExecutor(fix);
    } finally {
      this.isWriting = false;
      // Drain pending buffer if a newer fix arrived during the previous write
      // and queue has not been stopped in the meantime
      if (this.isStopped) {
        this.pendingFix = null;
      } else if (this.pendingFix) {
        const nextFix = this.pendingFix;
        this.pendingFix = null;
        await this.submit(nextFix);
      }
    }
  }
}
