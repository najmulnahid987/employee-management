/**
 * Dispatcher M15.6 — Notification Navigation & Deep Linking Core
 *
 * Pure TypeScript logic for:
 * 1. Safe notification payload extraction and validation.
 * 2. Role-based route resolution (Owner vs Worker Job Details).
 * 3. In-app notification item formatting from database delivery records.
 * 4. Pending deep link queue management for unauthenticated cold/warm starts.
 *
 * Guarantees:
 * - Never parses or exposes sensitive fields (customer phone, notes, tokens).
 * - Never grants access based on notification payload alone; relies on Supabase RLS.
 * - Pure logic decoupled from native APIs for 100% testability.
 */

export type ApprovedNotificationType =
  | 'job_assigned'
  | 'job_accepted'
  | 'worker_arrived'
  | 'job_completed';

export interface ValidatedNotificationData {
  jobId: string;
  type: ApprovedNotificationType;
}

export interface ResolvedNavigationTarget {
  pathname: string;
  params: { id: string };
}

export interface RawDeliveryRecord {
  id: string;
  notification_type: string;
  status: string;
  created_at: string;
  delivered_at: string | null;
  job_events?: {
    job_id: string;
    metadata?: Record<string, unknown> | null;
  } | null;
}

export interface FormattedInAppNotification {
  id: string;
  jobId: string;
  type: ApprovedNotificationType;
  title: string;
  body: string;
  createdAt: string;
  deliveredAt: string | null;
}

/**
 * Safely parses and validates notification payload data.
 * Returns ValidatedNotificationData if valid, or null if invalid or unsafe.
 */
export function parseNotificationPayload(data: unknown): ValidatedNotificationData | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const payload = data as Record<string, unknown>;

  const rawJobId = payload.jobId || payload.job_id;
  if (!rawJobId || typeof rawJobId !== 'string' || rawJobId.trim().length === 0) {
    return null;
  }

  const rawType = payload.type || payload.notification_type;
  if (!rawType || typeof rawType !== 'string') {
    return null;
  }

  const validTypes: ApprovedNotificationType[] = [
    'job_assigned',
    'job_accepted',
    'worker_arrived',
    'job_completed',
  ];

  if (!validTypes.includes(rawType as ApprovedNotificationType)) {
    return null;
  }

  return {
    jobId: rawJobId.trim(),
    type: rawType as ApprovedNotificationType,
  };
}

/**
 * Resolves the destination route based strictly on the authenticated user's trusted role.
 * Never allows role spoofing or route manipulation from notification payload.
 */
export function resolveNotificationRoute(
  role: 'owner' | 'worker' | null | undefined,
  jobId: string
): ResolvedNavigationTarget | null {
  if (!role || !jobId) {
    return null;
  }

  if (role === 'owner') {
    return {
      pathname: '/owner/job-details',
      params: { id: jobId },
    };
  }

  if (role === 'worker') {
    return {
      pathname: '/worker/job-details',
      params: { id: jobId },
    };
  }

  return null;
}

/**
 * Formats a database delivery record into a safe, user-friendly in-app notification item.
 */
export function formatInAppNotification(
  record: RawDeliveryRecord
): FormattedInAppNotification | null {
  if (!record || !record.notification_type) {
    return null;
  }

  const type = record.notification_type as ApprovedNotificationType;
  const jobId = record.job_events?.job_id;
  if (!jobId) {
    return null;
  }

  const metadata = (record.job_events?.metadata || {}) as Record<string, unknown>;
  const service = typeof metadata.service === 'string' && metadata.service.trim()
    ? metadata.service.trim()
    : 'Service Visit';
  const worker = typeof metadata.worker_name === 'string' && metadata.worker_name.trim()
    ? metadata.worker_name.trim()
    : 'Technician';

  let title = 'Job update';
  let body = `${service}: Updates are available.`;

  switch (type) {
    case 'job_assigned':
      title = 'New job assigned';
      body = `${service}: Please review the job details.`;
      break;
    case 'job_accepted':
      title = 'Job accepted';
      body = `${worker} accepted ${service}.`;
      break;
    case 'worker_arrived':
      title = 'Worker arrived';
      body = `${worker} arrived for ${service}.`;
      break;
    case 'job_completed':
      title = 'Job completed';
      body = `${worker} completed ${service}.`;
      break;
  }

  return {
    id: record.id,
    jobId,
    type,
    title,
    body,
    createdAt: record.created_at,
    deliveredAt: record.delivered_at,
  };
}

/**
 * In-memory pending deep-link state holder for unauthenticated launches.
 */
let pendingNotificationTarget: ValidatedNotificationData | null = null;

export function getPendingNotificationTarget(): ValidatedNotificationData | null {
  return pendingNotificationTarget;
}

export function setPendingNotificationTarget(target: ValidatedNotificationData | null): void {
  pendingNotificationTarget = target;
}

export function consumePendingNotificationTarget(): ValidatedNotificationData | null {
  const current = pendingNotificationTarget;
  pendingNotificationTarget = null;
  return current;
}

export interface ForegroundNotificationAlert {
  title: string;
  body: string;
  jobId: string;
  type: ApprovedNotificationType;
}

export interface NotificationDeepLinkOptions {
  role?: 'owner' | 'worker' | null;
  isAuthenticated?: boolean;
  onNavigate?: (target: { pathname: string; params: { id: string } }) => void;
  onForegroundNotification?: (alert: ForegroundNotificationAlert) => void;
}

/**
 * Handles an incoming notification tap response (cold start or warm start).
 */
export function handleNotificationTapResponse(
  response: any,
  options: NotificationDeepLinkOptions
): boolean {
  if (!response?.notification?.request?.content) {
    return false;
  }

  const rawData = response.notification.request.content.data;
  const validated = parseNotificationPayload(rawData);
  if (!validated) {
    return false;
  }

  const { isAuthenticated, role, onNavigate } = options;

  // If user is signed out, do not bypass authentication.
  // Store pending target in memory so it can be resumed upon sign-in.
  if (!isAuthenticated || !role) {
    setPendingNotificationTarget(validated);
    return false;
  }

  const route = resolveNotificationRoute(role, validated.jobId);
  if (route && onNavigate) {
    onNavigate(route);
    return true;
  }

  return false;
}

/**
 * Dispatches any stored pending notification route once user completes sign-in.
 */
export function resumePendingNotificationNavigation(
  role: 'owner' | 'worker' | null,
  onNavigate: (target: { pathname: string; params: { id: string } }) => void
): boolean {
  if (!role) return false;

  const pending = consumePendingNotificationTarget();
  if (!pending) return false;

  const route = resolveNotificationRoute(role, pending.jobId);
  if (route) {
    onNavigate(route);
    return true;
  }

  return false;
}

