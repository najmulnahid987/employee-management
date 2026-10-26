/**
 * Dispatcher Location Security & Business Rules
 *
 * Authoritative Specifications:
 * - docs/product-specification.md
 * - AGENTS.md (M4 & M11 Location Architecture)
 *
 * Implements pure client-side validation parity for M11.2 database rules:
 * - Location tracking is permitted ONLY for approved field visit statuses:
 *   ['on_the_way', 'arrived', 'in_progress']
 * - No tracking allowed for upcoming stages: ['unassigned', 'assigned', 'accepted']
 * - No tracking allowed for terminal stages: ['completed', 'cancelled']
 * - Strict coordinate bounds validation [-90, 90] / [-180, 180]
 * - Stale telemetry detection
 */

export type JobStatus =
  | 'unassigned'
  | 'assigned'
  | 'accepted'
  | 'on_the_way'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

/**
 * The only 3 job lifecycle statuses where worker location tracking is permitted.
 */
export const APPROVED_TRACKING_STATUSES: readonly JobStatus[] = [
  'on_the_way',
  'arrived',
  'in_progress',
] as const;

export type ApprovedTrackingStatus = (typeof APPROVED_TRACKING_STATUSES)[number];

/**
 * Checks whether a job status permits worker location tracking.
 */
export function isTrackingEligibleStatus(status: unknown): status is ApprovedTrackingStatus {
  return typeof status === 'string' && (APPROVED_TRACKING_STATUSES as readonly string[]).includes(status);
}

export interface CoordinateValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates coordinate bounds and accuracy.
 */
export function validateCoordinates(
  latitude: number,
  longitude: number,
  accuracy?: number | null
): CoordinateValidationResult {
  if (typeof latitude !== 'number' || isNaN(latitude)) {
    return { valid: false, error: 'Latitude must be a valid number.' };
  }
  if (latitude < -90.0 || latitude > 90.0) {
    return { valid: false, error: 'Latitude must be between -90.0 and 90.0 degrees.' };
  }

  if (typeof longitude !== 'number' || isNaN(longitude)) {
    return { valid: false, error: 'Longitude must be a valid number.' };
  }
  if (longitude < -180.0 || longitude > 180.0) {
    return { valid: false, error: 'Longitude must be between -180.0 and 180.0 degrees.' };
  }

  if (accuracy !== undefined && accuracy !== null) {
    if (typeof accuracy !== 'number' || isNaN(accuracy)) {
      return { valid: false, error: 'Accuracy must be a valid number or null.' };
    }
    if (accuracy < 0.0) {
      return { valid: false, error: 'Accuracy cannot be negative.' };
    }
  }

  return { valid: true };
}

/**
 * Telemetry freshness threshold in milliseconds (5 minutes).
 * Position fixes older than this are considered stale.
 */
export const STALE_TELEMETRY_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Determines whether a location timestamp is stale based on a freshness threshold.
 */
export function isTelemetryStale(
  recordedAtISO: string | null | undefined,
  maxAgeMs: number = STALE_TELEMETRY_THRESHOLD_MS,
  nowMs: number = Date.now()
): boolean {
  if (!recordedAtISO) return true;
  const recorded = new Date(recordedAtISO).getTime();
  if (isNaN(recorded)) return true;
  return nowMs - recorded > maxAgeMs;
}
