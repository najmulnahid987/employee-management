/**
 * Dispatcher Owner Active Locations Core
 *
 * Authoritative Specifications:
 * - docs/product-specification.md
 * - AGENTS.md (M4 & M11 Architecture)
 * - M11.6 Owner Live Worker Location
 *
 * Platform-independent data structures, validation, freshness calculations,
 * and distance computation for owner live territory tracking.
 */

export const MAX_ACCURACY_THRESHOLD_METERS = 200.0;
export const STALE_TELEMETRY_THRESHOLD_MS = 5 * 60 * 1000;

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
 * Calculates great-circle distance between two coordinates using the Haversine formula.
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

/**
 * Validates coordinate bounds and non-negative accuracy.
 */
export function validateCoordinates(
  latitude: number,
  longitude: number,
  accuracy?: number | null
): { valid: boolean; error?: string } {
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

export interface RawOwnerActiveLocationRow {
  location_id: string;
  worker_id: string;
  worker_name: string;
  worker_avatar_url: string | null;
  job_id: string;
  job_service: string;
  job_address: string;
  job_status: string;
  destination_latitude: number | null;
  destination_longitude: number | null;
  worker_latitude: number;
  worker_longitude: number;
  accuracy: number | null;
  recorded_at: string;
}

export interface OwnerActiveLocation {
  locationId: string;
  workerId: string;
  workerName: string;
  workerAvatarUrl: string | null;
  jobId: string;
  jobService: string;
  jobAddress: string;
  jobStatus: JobStatus;
  destinationLatitude: number | null;
  destinationLongitude: number | null;
  workerLatitude: number;
  workerLongitude: number;
  accuracy: number | null;
  recordedAt: string;
  /** Distance in meters between worker and customer destination (null if destination coordinates missing) */
  distanceToDestinationMeters: number | null;
  /** True if telemetry was recorded more than 5 minutes ago */
  isStale: boolean;
  /** True if reported accuracy is worse than 200m */
  isInaccurate: boolean;
  /** Human-readable freshness label */
  freshnessLabel: string;
}

export interface TerritorySummary {
  totalActive: number;
  enRouteCount: number;
  onSiteCount: number;
  staleCount: number;
}

/**
 * Formats a distance in meters to a human-friendly string.
 */
export function formatDistance(meters: number | null): string {
  if (meters === null || isNaN(meters)) return 'Distance unavailable';
  if (meters < 1000) {
    return `${Math.round(meters)} m away`;
  }
  const km = (meters / 1000).toFixed(1);
  return `${km} km away`;
}

/**
 * Formats elapsed time since recorded timestamp.
 */
export function formatTimeAgo(isoTimestamp: string, nowMs: number = Date.now()): string {
  const recordedMs = new Date(isoTimestamp).getTime();
  if (isNaN(recordedMs)) return 'Unknown';

  const elapsedSec = Math.max(0, Math.floor((nowMs - recordedMs) / 1000));
  if (elapsedSec < 10) return 'Just now';
  if (elapsedSec < 60) return `${elapsedSec}s ago`;

  const elapsedMin = Math.floor(elapsedSec / 60);
  if (elapsedMin < 60) return `${elapsedMin}m ago`;

  const elapsedHours = Math.floor(elapsedMin / 60);
  return `${elapsedHours}h ago`;
}

/**
 * Transforms a raw database row from get_owner_active_locations into a validated OwnerActiveLocation object.
 * Returns null if coordinates are invalid.
 */
export function processRawOwnerActiveLocation(
  row: RawOwnerActiveLocationRow,
  nowMs: number = Date.now()
): OwnerActiveLocation | null {
  // Validate worker coordinates
  const coordValidation = validateCoordinates(row.worker_latitude, row.worker_longitude, row.accuracy);
  if (!coordValidation.valid) {
    return null;
  }

  // Calculate distance to destination if destination coordinates are valid
  let distanceToDestinationMeters: number | null = null;
  if (
    row.destination_latitude !== null &&
    row.destination_longitude !== null &&
    !isNaN(row.destination_latitude) &&
    !isNaN(row.destination_longitude)
  ) {
    const destValidation = validateCoordinates(row.destination_latitude, row.destination_longitude);
    if (destValidation.valid) {
      distanceToDestinationMeters = calculateHaversineDistance(
        row.worker_latitude,
        row.worker_longitude,
        row.destination_latitude,
        row.destination_longitude
      );
    }
  }

  // Evaluate freshness and accuracy
  const isStale = isTelemetryStale(row.recorded_at, STALE_TELEMETRY_THRESHOLD_MS, nowMs);
  const isInaccurate =
    row.accuracy !== null &&
    row.accuracy !== undefined &&
    row.accuracy > MAX_ACCURACY_THRESHOLD_METERS;

  // Build descriptive freshness label
  let freshnessLabel = `Updated ${formatTimeAgo(row.recorded_at, nowMs)}`;
  if (isStale) {
    freshnessLabel = `Stale — updated ${formatTimeAgo(row.recorded_at, nowMs)}`;
  } else if (isInaccurate) {
    freshnessLabel = `Low accuracy (±${Math.round(row.accuracy!)}m) — ${formatTimeAgo(row.recorded_at, nowMs)}`;
  }

  return {
    locationId: row.location_id,
    workerId: row.worker_id,
    workerName: row.worker_name,
    workerAvatarUrl: row.worker_avatar_url,
    jobId: row.job_id,
    jobService: row.job_service,
    jobAddress: row.job_address,
    jobStatus: row.job_status as JobStatus,
    destinationLatitude: row.destination_latitude,
    destinationLongitude: row.destination_longitude,
    workerLatitude: row.worker_latitude,
    workerLongitude: row.worker_longitude,
    accuracy: row.accuracy,
    recordedAt: row.recorded_at,
    distanceToDestinationMeters,
    isStale,
    isInaccurate,
    freshnessLabel,
  };
}

/**
 * Computes summary counts across active territory locations.
 */
export function calculateTerritorySummary(locations: OwnerActiveLocation[]): TerritorySummary {
  let enRouteCount = 0;
  let onSiteCount = 0;
  let staleCount = 0;

  for (const loc of locations) {
    if (loc.jobStatus === 'on_the_way') {
      enRouteCount++;
    } else if (loc.jobStatus === 'arrived' || loc.jobStatus === 'in_progress') {
      onSiteCount++;
    }

    if (loc.isStale) {
      staleCount++;
    }
  }

  return {
    totalActive: locations.length,
    enRouteCount,
    onSiteCount,
    staleCount,
  };
}

// =============================================================================
// M12 Owner Live Map Typed View Model & Evaluation
// =============================================================================

export type MapPositionStatus =
  | 'LIVE'          // Fresh, accurate coordinates on an active field visit
  | 'STALE'         // Valid coordinates, but telemetry older than freshness threshold
  | 'LOW_ACCURACY'  // Valid coordinates, but accuracy worse than threshold (>200m)
  | 'NO_FIX'        // Active field visit, but no coordinates recorded yet or fix invalid
  | 'NOT_TRACKABLE' // Idle or assigned to upcoming job (not in travel/on-site visit)
  | 'INACTIVE';     // Inactive worker account

export interface OwnerLiveMapWorkerItem {
  workerId: string;
  workerName: string;
  workerAvatarUrl: string | null;
  workerPhone: string | null;
  isActive: boolean;

  jobId: string | null;
  jobService: string | null;
  jobAddress: string | null;
  customerName: string | null;
  jobStatus: JobStatus | null;
  destinationLatitude: number | null;
  destinationLongitude: number | null;

  locationId: string | null;
  workerLatitude: number | null;
  workerLongitude: number | null;
  accuracy: number | null;
  recordedAt: string | null;

  positionStatus: MapPositionStatus;
  isEligibleForLiveMarker: boolean;
  isLive: boolean;
  isStale: boolean;
  isInaccurate: boolean;
  distanceToDestinationMeters: number | null;
  freshnessLabel: string;
}

export interface OwnerLiveMapSummary {
  totalWorkers: number;
  activeOnDuty: number;     // workers on active visits (on_the_way, arrived, in_progress)
  liveTracked: number;      // positionStatus === 'LIVE'
  staleTracked: number;     // positionStatus === 'STALE'
  lowAccuracyCount: number; // positionStatus === 'LOW_ACCURACY'
  awaitingFixCount: number; // positionStatus === 'NO_FIX'
  enRouteCount: number;     // jobStatus === 'on_the_way'
  onSiteCount: number;      // jobStatus === 'arrived' | 'in_progress'
  upcomingCount: number;    // jobStatus === 'assigned' | 'accepted'
  idleCount: number;        // no active or upcoming job
}

export interface OwnerLiveMapData {
  workers: OwnerLiveMapWorkerItem[];
  activeMarkers: OwnerLiveMapWorkerItem[];
  untrackedWorkers: OwnerLiveMapWorkerItem[];
  summary: OwnerLiveMapSummary;
  fetchedAt: string;
}

export interface BuildWorkerMapItemParams {
  worker: {
    id: string;
    full_name: string;
    avatar_url: string | null;
    phone: string | null;
    is_active: boolean;
  };
  job?: {
    id: string;
    customer_name?: string;
    service: string;
    address: string;
    status: string;
    latitude: number | null;
    longitude: number | null;
  } | null;
  location?: {
    id: string;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    created_at: string;
  } | null;
  staleThresholdMs?: number;
  maxAccuracyMeters?: number;
  nowMs?: number;
}

/**
 * Pure builder function to transform raw worker, job, and location inputs
 * into an evaluated OwnerLiveMapWorkerItem.
 */
export function buildOwnerLiveMapWorkerItem(
  params: BuildWorkerMapItemParams
): OwnerLiveMapWorkerItem {
  const {
    worker,
    job = null,
    location = null,
    staleThresholdMs = STALE_TELEMETRY_THRESHOLD_MS,
    maxAccuracyMeters = MAX_ACCURACY_THRESHOLD_METERS,
    nowMs = Date.now(),
  } = params;

  const workerId = worker.id;
  const workerName = worker.full_name;
  const workerAvatarUrl = worker.avatar_url;
  const workerPhone = worker.phone;
  const isActive = worker.is_active;

  // Inactive worker profile
  if (!isActive) {
    return {
      workerId,
      workerName,
      workerAvatarUrl,
      workerPhone,
      isActive,
      jobId: null,
      jobService: null,
      jobAddress: null,
      customerName: null,
      jobStatus: null,
      destinationLatitude: null,
      destinationLongitude: null,
      locationId: null,
      workerLatitude: null,
      workerLongitude: null,
      accuracy: null,
      recordedAt: null,
      positionStatus: 'INACTIVE',
      isEligibleForLiveMarker: false,
      isLive: false,
      isStale: false,
      isInaccurate: false,
      distanceToDestinationMeters: null,
      freshnessLabel: 'Inactive account',
    };
  }

  // Idle worker (no active or upcoming job)
  if (!job) {
    return {
      workerId,
      workerName,
      workerAvatarUrl,
      workerPhone,
      isActive,
      jobId: null,
      jobService: null,
      jobAddress: null,
      customerName: null,
      jobStatus: null,
      destinationLatitude: null,
      destinationLongitude: null,
      locationId: null,
      workerLatitude: null,
      workerLongitude: null,
      accuracy: null,
      recordedAt: null,
      positionStatus: 'NOT_TRACKABLE',
      isEligibleForLiveMarker: false,
      isLive: false,
      isStale: false,
      isInaccurate: false,
      distanceToDestinationMeters: null,
      freshnessLabel: 'No active assignments',
    };
  }

  const jobStatus = job.status as JobStatus;
  const isFieldVisit =
    jobStatus === 'on_the_way' || jobStatus === 'arrived' || jobStatus === 'in_progress';

  // Upcoming job (not eligible for GPS tracking per M11 rules)
  if (!isFieldVisit) {
    return {
      workerId,
      workerName,
      workerAvatarUrl,
      workerPhone,
      isActive,
      jobId: job.id,
      jobService: job.service,
      jobAddress: job.address,
      customerName: job.customer_name || null,
      jobStatus,
      destinationLatitude: job.latitude,
      destinationLongitude: job.longitude,
      locationId: null,
      workerLatitude: null,
      workerLongitude: null,
      accuracy: null,
      recordedAt: null,
      positionStatus: 'NOT_TRACKABLE',
      isEligibleForLiveMarker: false,
      isLive: false,
      isStale: false,
      isInaccurate: false,
      distanceToDestinationMeters: null,
      freshnessLabel: 'Scheduled (not travelling yet)',
    };
  }

  // Active field visit without a recorded location row
  if (!location) {
    return {
      workerId,
      workerName,
      workerAvatarUrl,
      workerPhone,
      isActive,
      jobId: job.id,
      jobService: job.service,
      jobAddress: job.address,
      customerName: job.customer_name || null,
      jobStatus,
      destinationLatitude: job.latitude,
      destinationLongitude: job.longitude,
      locationId: null,
      workerLatitude: null,
      workerLongitude: null,
      accuracy: null,
      recordedAt: null,
      positionStatus: 'NO_FIX',
      isEligibleForLiveMarker: false,
      isLive: false,
      isStale: false,
      isInaccurate: false,
      distanceToDestinationMeters: null,
      freshnessLabel: 'Awaiting GPS fix',
    };
  }

  // Active field visit with candidate location row: validate coordinates
  const coordValidation = validateCoordinates(
    location.latitude,
    location.longitude,
    location.accuracy
  );

  if (!coordValidation.valid) {
    return {
      workerId,
      workerName,
      workerAvatarUrl,
      workerPhone,
      isActive,
      jobId: job.id,
      jobService: job.service,
      jobAddress: job.address,
      customerName: job.customer_name || null,
      jobStatus,
      destinationLatitude: job.latitude,
      destinationLongitude: job.longitude,
      locationId: location.id,
      workerLatitude: null,
      workerLongitude: null,
      accuracy: location.accuracy,
      recordedAt: location.created_at,
      positionStatus: 'NO_FIX',
      isEligibleForLiveMarker: false,
      isLive: false,
      isStale: false,
      isInaccurate: false,
      distanceToDestinationMeters: null,
      freshnessLabel: 'Invalid GPS fix',
    };
  }

  // Valid coordinates: evaluate freshness and accuracy
  const isStale = isTelemetryStale(location.created_at, staleThresholdMs, nowMs);
  const isInaccurate =
    location.accuracy !== null &&
    location.accuracy !== undefined &&
    location.accuracy > maxAccuracyMeters;

  let positionStatus: MapPositionStatus = 'LIVE';
  let freshnessLabel = `Updated ${formatTimeAgo(location.created_at, nowMs)}`;

  if (isStale) {
    positionStatus = 'STALE';
    freshnessLabel = `Stale — updated ${formatTimeAgo(location.created_at, nowMs)}`;
  } else if (isInaccurate) {
    positionStatus = 'LOW_ACCURACY';
    freshnessLabel = `Low accuracy (±${Math.round(location.accuracy!)}m) — updated ${formatTimeAgo(location.created_at, nowMs)}`;
  }

  // Distance calculation to customer destination
  let distanceToDestinationMeters: number | null = null;
  if (
    job.latitude !== null &&
    job.longitude !== null &&
    !isNaN(job.latitude) &&
    !isNaN(job.longitude)
  ) {
    const destValidation = validateCoordinates(job.latitude, job.longitude);
    if (destValidation.valid) {
      distanceToDestinationMeters = calculateHaversineDistance(
        location.latitude,
        location.longitude,
        job.latitude,
        job.longitude
      );
    }
  }

  return {
    workerId,
    workerName,
    workerAvatarUrl,
    workerPhone,
    isActive,
    jobId: job.id,
    jobService: job.service,
    jobAddress: job.address,
    customerName: job.customer_name || null,
    jobStatus,
    destinationLatitude: job.latitude,
    destinationLongitude: job.longitude,
    locationId: location.id,
    workerLatitude: location.latitude,
    workerLongitude: location.longitude,
    accuracy: location.accuracy,
    recordedAt: location.created_at,
    positionStatus,
    isEligibleForLiveMarker: true,
    isLive: positionStatus === 'LIVE',
    isStale,
    isInaccurate,
    distanceToDestinationMeters,
    freshnessLabel,
  };
}

/**
 * Builds the composite OwnerLiveMapData structure and summary metrics.
 */
export function buildOwnerLiveMapData(
  items: OwnerLiveMapWorkerItem[],
  fetchedAtISO: string = new Date().toISOString()
): OwnerLiveMapData {
  const activeMarkers = items.filter((item) => item.isEligibleForLiveMarker);
  const untrackedWorkers = items.filter((item) => !item.isEligibleForLiveMarker);

  let activeOnDuty = 0;
  let liveTracked = 0;
  let staleTracked = 0;
  let lowAccuracyCount = 0;
  let awaitingFixCount = 0;
  let enRouteCount = 0;
  let onSiteCount = 0;
  let upcomingCount = 0;
  let idleCount = 0;

  for (const item of items) {
    if (item.jobStatus === 'on_the_way') {
      activeOnDuty++;
      enRouteCount++;
    } else if (item.jobStatus === 'arrived' || item.jobStatus === 'in_progress') {
      activeOnDuty++;
      onSiteCount++;
    } else if (item.jobStatus === 'assigned' || item.jobStatus === 'accepted') {
      upcomingCount++;
    } else {
      idleCount++;
    }

    if (item.positionStatus === 'LIVE') {
      liveTracked++;
    } else if (item.positionStatus === 'STALE') {
      staleTracked++;
    } else if (item.positionStatus === 'LOW_ACCURACY') {
      lowAccuracyCount++;
    } else if (item.positionStatus === 'NO_FIX') {
      awaitingFixCount++;
    }
  }

  return {
    workers: items,
    activeMarkers,
    untrackedWorkers,
    summary: {
      totalWorkers: items.length,
      activeOnDuty,
      liveTracked,
      staleTracked,
      lowAccuracyCount,
      awaitingFixCount,
      enRouteCount,
      onSiteCount,
      upcomingCount,
      idleCount,
    },
    fetchedAt: fetchedAtISO,
  };
}

const STATUS_FIELD_PRIORITY: Record<string, number> = {
  in_progress: 1,
  arrived: 2,
  on_the_way: 3,
  accepted: 4,
  assigned: 5,
};

export interface FetchOwnerLiveMapOptions {
  /** Maximum telemetry age before marked stale (defaults to 5 minutes: 300,000ms) */
  staleThresholdMs?: number;
  /** Maximum acceptable accuracy in meters before marked inaccurate (defaults to 200m) */
  maxAccuracyMeters?: number;
  /** Current time in ms for deterministic testing and freshness calculations */
  nowMs?: number;
}

export interface ComposeOwnerLiveMapParams {
  workerProfiles: Array<{
    id: string;
    full_name: string;
    avatar_url: string | null;
    phone: string | null;
    is_active: boolean;
  }>;
  rawJobs: Array<{
    id: string;
    worker_id: string | null;
    customer_name?: string;
    service: string;
    address: string;
    status: string;
    latitude: number | null;
    longitude: number | null;
    scheduled_at: string | null;
    updated_at?: string;
  }>;
  rawLocations: Array<{
    id: string;
    worker_id: string;
    job_id: string | null;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    created_at: string;
  }>;
  options?: FetchOwnerLiveMapOptions;
}

/**
 * Pure batched composition function:
 * - Prioritizes active field visits over upcoming jobs per worker.
 * - Deduplicates historical location rows by selecting the newest sample per worker.
 * - Composes fully typed OwnerLiveMapWorkerItem instances.
 * - Computes complete territory metrics with zero network dependencies.
 */
export function composeOwnerLiveMapData(
  params: ComposeOwnerLiveMapParams
): OwnerLiveMapData {
  const {
    workerProfiles,
    rawJobs,
    rawLocations,
    options,
  } = params;

  const nowMs = options?.nowMs ?? Date.now();
  const staleThresholdMs = options?.staleThresholdMs ?? STALE_TELEMETRY_THRESHOLD_MS;
  const maxAccuracyMeters = options?.maxAccuracyMeters ?? MAX_ACCURACY_THRESHOLD_METERS;

  // 1. Map single highest-priority non-terminal job to each worker
  const jobByWorkerId = new Map<string, (typeof rawJobs)[number]>();

  for (const job of rawJobs) {
    if (!job.worker_id) continue;
    const existing = jobByWorkerId.get(job.worker_id);
    if (!existing) {
      jobByWorkerId.set(job.worker_id, job);
    } else {
      const priorityExisting = STATUS_FIELD_PRIORITY[existing.status] ?? 99;
      const priorityCurrent = STATUS_FIELD_PRIORITY[job.status] ?? 99;

      if (priorityCurrent < priorityExisting) {
        jobByWorkerId.set(job.worker_id, job);
      } else if (priorityCurrent === priorityExisting) {
        const timeExisting = existing.scheduled_at ? new Date(existing.scheduled_at).getTime() : 0;
        const timeCurrent = job.scheduled_at ? new Date(job.scheduled_at).getTime() : 0;
        if (timeCurrent < timeExisting) {
          jobByWorkerId.set(job.worker_id, job);
        }
      }
    }
  }

  // 2. Sort locations newest first and select latest per worker_id
  const sortedLocations = [...rawLocations].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const latestLocationByWorkerId = new Map<string, (typeof rawLocations)[number]>();
  for (const loc of sortedLocations) {
    if (!latestLocationByWorkerId.has(loc.worker_id)) {
      latestLocationByWorkerId.set(loc.worker_id, loc);
    }
  }

  // 3. Compose items for all workers in the business roster
  const items = workerProfiles.map((worker) => {
    const job = jobByWorkerId.get(worker.id) || null;
    const location = latestLocationByWorkerId.get(worker.id) || null;

    return buildOwnerLiveMapWorkerItem({
      worker,
      job,
      location,
      staleThresholdMs,
      maxAccuracyMeters,
      nowMs,
    });
  });

  return buildOwnerLiveMapData(items, new Date(nowMs).toISOString());
}

/**
 * Maps M9 lifecycle status to human-readable live map label.
 * Requirement 5:
 * - Travelling for on_the_way
 * - Arrived for arrived
 * - Working for in_progress
 */
export function getMapLifecycleStatusLabel(status: JobStatus | string | null): string {
  switch (status) {
    case 'on_the_way':
      return 'Travelling';
    case 'arrived':
      return 'Arrived';
    case 'in_progress':
      return 'Working';
    case 'assigned':
      return 'Assigned';
    case 'accepted':
      return 'Accepted';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
    case 'unassigned':
      return 'Unassigned';
    default:
      return status ? String(status) : 'Unknown';
  }
}

/**
 * Restrained accessible status colors for live map markers and legend.
 * Requirement 6:
 * - Travelling: Blue (#1D4ED8)
 * - Arrived: Cyan/Teal (#0E7490)
 * - Working: Green (#15803D)
 */
export const MAP_STATUS_COLORS: Record<'on_the_way' | 'arrived' | 'in_progress', string> = {
  on_the_way: '#1D4ED8', // Travelling
  arrived: '#0E7490',    // Arrived
  in_progress: '#15803D', // Working
};

/**
 * Safely finds an OwnerLiveMapWorkerItem by stable worker ID.
 * Avoids array indexing or display name matching.
 */
export function findWorkerMapItemById(
  items: OwnerLiveMapWorkerItem[],
  workerId: string | null
): OwnerLiveMapWorkerItem | null {
  if (!workerId) return null;
  return items.find((item) => item.workerId === workerId) ?? null;
}

/**
 * Checks whether an item's telemetry is currently stale based on its recorded timestamp.
 */
export function isWorkerLocationStale(
  item: OwnerLiveMapWorkerItem,
  staleThresholdMs: number = STALE_TELEMETRY_THRESHOLD_MS,
  nowMs: number = Date.now()
): boolean {
  if (!item.recordedAt) return true;
  return isTelemetryStale(item.recordedAt, staleThresholdMs, nowMs);
}




