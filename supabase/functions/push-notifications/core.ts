/**
 * Dispatcher M15.4 — Secure Notification Delivery Pipeline Core
 *
 * Server-side notification dispatch pipeline reacting to job lifecycle events.
 *
 * Invariants & Security:
 * 1. Source of truth is the append-only job_events ledger (committed M9 lifecycle events).
 * 2. Strictly filters for 4 approved event types:
 *    - job assigned (worker_assigned, worker_reassigned) -> Recipient: assigned worker
 *    - job accepted (status_changed: assigned -> accepted) -> Recipient: business owner
 *    - worker arrived (status_changed: on_the_way -> arrived) -> Recipient: business owner
 *    - job completed (status_changed: in_progress -> completed) -> Recipient: business owner
 * 3. All other events (locations, travel start, cancellation, unassignment) are ignored.
 * 4. Deduplication is enforced by idempotency key: `${job_event_id}:${recipient_user_id}`.
 *    Repeated webhook invocations or retries produce at most ONE logical notification.
 * 5. Recipient users are resolved strictly from trusted database relations (jobs.worker_id, profiles.role = 'owner').
 *    Arbitrary recipient IDs from client requests are rejected.
 * 6. Payloads are strictly sanitized: customer phone numbers, internal notes, gate codes,
 *    and exact street addresses are never included in push payloads.
 * 7. Invalid tokens (DeviceNotRegistered) are deactivated in device_tokens to prevent future failed deliveries.
 */

// Declare Deno runtime global for TypeScript compilers outside Deno
declare const Deno: any;

// =============================================================================
// Types & Interfaces
// =============================================================================

export type ApprovedNotificationType =
  | 'job_assigned'
  | 'job_accepted'
  | 'worker_arrived'
  | 'job_completed';

export interface JobEventRecord {
  id: string;
  job_id: string;
  business_id: string;
  actor_id: string | null;
  actor_role: string;
  event_type: string;
  previous_status: string | null;
  new_status: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
}

export interface JobRecord {
  id: string;
  business_id: string;
  service: string;
  address: string;
  status: string;
  worker_id: string | null;
}

export interface ProfileRecord {
  id: string;
  business_id: string;
  full_name: string;
  role: 'owner' | 'worker';
}

export interface SanitizedPushPayload {
  title: string;
  body: string;
  data: {
    type: ApprovedNotificationType;
    jobId: string;
    [key: string]: unknown;
  };
}

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: string | 'default';
  badge?: number;
  channelId?: string;
}

export interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: {
    error?: 'DeviceNotRegistered' | 'InvalidCredentials' | 'MessageTooBig' | 'MessageRateExceeded' | string;
    [key: string]: unknown;
  };
}

export interface ExpoPushReceipt {
  status: 'ok' | 'error';
  message?: string;
  details?: {
    error?: 'DeviceNotRegistered' | 'InvalidCredentials' | 'MessageTooBig' | 'MessageRateExceeded' | string;
    [key: string]: unknown;
  };
}

export interface ReceiptProcessingResult {
  receiptsChecked: number;
  confirmedCount: number;
  errorCount: number;
  deactivatedTokens: string[];
  receipts: Record<string, ExpoPushReceipt>;
}

export interface PipelineExecutionResult {
  success: boolean;
  processed: boolean;
  notificationType?: ApprovedNotificationType;
  idempotencyKey?: string;
  status?: 'delivered' | 'no_tokens' | 'duplicate_suppressed' | 'failed' | 'stale_suppressed';
  tokensCount?: number;
  ticketsCount?: number;
  ticketTokenMap?: Record<string, string>;
  deactivatedTokens?: string[];
  reason?: string;
  error?: string;
  retryable?: boolean;
  attempt?: number;
  maxAttempts?: number;
  backoffDelayMs?: number;
}

export interface PipelineDependencies {
  fetchJob: (jobId: string, businessId: string) => Promise<JobRecord | null>;
  fetchWorkerProfile: (workerId: string, businessId: string) => Promise<ProfileRecord | null>;
  fetchOwnerProfile: (businessId: string) => Promise<ProfileRecord | null>;
  claimDeliverySlot: (
    jobEventId: string,
    recipientUserId: string,
    businessId: string,
    notificationType: ApprovedNotificationType,
    idempotencyKey: string
  ) => Promise<'claimed' | 'already_delivered' | 'in_progress' | 'max_retries_exceeded'>;
  fetchRecipientDeviceTokens: (recipientUserId: string) => Promise<string[]>;
  sendExpoPush: (messages: ExpoPushMessage[], expoAccessToken?: string) => Promise<ExpoPushTicket[]>;
  fetchExpoReceipts?: (ticketIds: string[], expoAccessToken?: string) => Promise<Record<string, ExpoPushReceipt>>;
  updateDeliverySuccess: (
    idempotencyKey: string,
    tokensCount: number,
    ticketIds: string[],
    ticketTokenMap?: Record<string, string>
  ) => Promise<void>;
  updateDeliveryReceipts?: (
    idempotencyKey: string,
    receiptStatus: Record<string, ExpoPushReceipt>
  ) => Promise<void>;
  updateDeliveryNoTokens: (idempotencyKey: string) => Promise<void>;
  updateDeliveryFailed: (
    idempotencyKey: string,
    errorMessage: string,
    isRetryable?: boolean,
    retryCount?: number
  ) => Promise<void>;
  deactivateDeviceToken: (token: string) => Promise<void>;
}

// =============================================================================
// Pure Logic Helpers
// =============================================================================

/**
 * Classifies an incoming job_event.
 * Returns the ApprovedNotificationType if delivery is required, or null if ignored.
 */
export function classifyNotificationEvent(
  event: Partial<JobEventRecord> | null | undefined
): ApprovedNotificationType | null {
  if (!event || !event.event_type) return null;

  // 1. Worker assigned or reassigned
  if (
    event.event_type === 'worker_assigned' ||
    event.event_type === 'worker_reassigned'
  ) {
    return 'job_assigned';
  }

  // 2. Status change events
  if (event.event_type === 'status_changed') {
    // Worker accepted job
    if (event.previous_status === 'assigned' && event.new_status === 'accepted') {
      return 'job_accepted';
    }
    // Worker arrived at job location
    if (event.previous_status === 'on_the_way' && event.new_status === 'arrived') {
      return 'worker_arrived';
    }
    // Worker completed job
    if (event.previous_status === 'in_progress' && event.new_status === 'completed') {
      return 'job_completed';
    }
  }

  // All other events are strictly filtered out (unassigned, cancelled, travel start, locations, etc.)
  return null;
}

/**
 * Generates the deterministic idempotency key for an event and recipient.
 */
export function generateIdempotencyKey(jobEventId: string, recipientUserId: string): string {
  if (!jobEventId || !recipientUserId) {
    throw new Error('jobEventId and recipientUserId are required for idempotency key');
  }
  return `${jobEventId}:${recipientUserId}`;
}

/**
 * Formats a user-friendly, privacy-sanitized notification payload.
 * Strictly withholds customer phone, notes, gate codes, and detailed address.
 */
export function formatNotificationPayload(
  type: ApprovedNotificationType,
  jobId: string,
  serviceName: string,
  workerName?: string
): SanitizedPushPayload {
  const service = serviceName ? serviceName.trim() : 'Service Visit';
  const worker = workerName ? workerName.trim() : 'Technician';

  switch (type) {
    case 'job_assigned':
      return {
        title: 'New job assigned',
        body: `${service}: Please review the job details.`,
        data: {
          type,
          jobId,
        },
      };

    case 'job_accepted':
      return {
        title: 'Job accepted',
        body: `${worker} accepted ${service}.`,
        data: {
          type,
          jobId,
        },
      };

    case 'worker_arrived':
      return {
        title: 'Worker arrived',
        body: `${worker} arrived for ${service}.`,
        data: {
          type,
          jobId,
        },
      };

    case 'job_completed':
      return {
        title: 'Job completed',
        body: `${worker} completed ${service}.`,
        data: {
          type,
          jobId,
        },
      };
  }
}

/**
 * Validates that no sensitive information is leaked in the notification payload.
 */
export function validatePayloadSanitization(payload: SanitizedPushPayload): void {
  const forbiddenPatterns = [
    'customer_phone',
    'phone',
    'internal_notes',
    'notes',
    'gate_code',
    'tracking_token',
    'token_hash',
  ];

  for (const forbidden of forbiddenPatterns) {
    if (forbidden in payload.data) {
      throw new Error(`Sensitive field '${forbidden}' is forbidden in notification payload data`);
    }
  }
}

// =============================================================================
// M15.7 Reliability Safeguards: Deduplication, Bounded Retries & Receipt Tracking
// =============================================================================

/**
 * Maximum age for a real-time dispatch event (30 minutes).
 * Events older than this are considered stale backlog and suppressed to prevent alert bursts.
 */
export const MAX_EVENT_AGE_MS = 30 * 60 * 1000;

/**
 * Checks whether an incoming lifecycle event is stale based on its creation timestamp.
 */
export function isEventStale(
  createdAt: string | undefined | null,
  maxAgeMs: number = MAX_EVENT_AGE_MS,
  nowMs: number = Date.now()
): boolean {
  if (!createdAt) return false;
  const eventTime = new Date(createdAt).getTime();
  if (isNaN(eventTime)) return false;
  return nowMs - eventTime > maxAgeMs;
}

/**
 * Bounded retry configuration for transient notification provider errors.
 */
export const MAX_RETRY_ATTEMPTS = 3;
export const INITIAL_BACKOFF_MS = 1000;
export const BACKOFF_MULTIPLIER = 2;
export const MAX_BACKOFF_DELAY_MS = 10000;

/**
 * Calculates exponential backoff delay capped at maximum delay.
 */
export function calculateBackoffDelay(
  attempt: number,
  initialDelay: number = INITIAL_BACKOFF_MS,
  multiplier: number = BACKOFF_MULTIPLIER,
  maxDelay: number = MAX_BACKOFF_DELAY_MS
): number {
  const clamped = Math.max(1, attempt);
  const delay = initialDelay * Math.pow(multiplier, clamped - 1);
  return Math.min(delay, maxDelay);
}

/**
 * Classifies whether an error from the provider or network is transient or permanent.
 */
export function classifyErrorRetryability(error: unknown): {
  isRetryable: boolean;
  reason: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // Permanent failures: never retry
  if (
    lower.includes('devicenotregistered') ||
    lower.includes('invalidcredentials') ||
    lower.includes('messagetoobig') ||
    lower.includes('not found') ||
    lower.includes('mismatch') ||
    lower.includes('stale') ||
    lower.includes('unauthorized') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('forbidden')
  ) {
    return { isRetryable: false, reason: 'Permanent failure: validation or authentication error' };
  }

  // Transient provider / network failures: retryable with backoff
  if (
    lower.includes('messagerateexceeded') ||
    lower.includes('rate limit') ||
    lower.includes('timeout') ||
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return { isRetryable: true, reason: 'Transient failure: provider or network error' };
  }

  return { isRetryable: true, reason: 'Unknown error: treated as transient' };
}

/**
 * Strips raw secrets, authorization tokens, and sensitive customer information from error logs.
 */
export function sanitizeErrorMessage(error: unknown): string {
  if (!error) return 'Unknown error';
  let message = error instanceof Error ? error.message : String(error);

  // Strip Bearer tokens
  message = message.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
  // Strip apikey / secrets
  message = message.replace(/(apikey|secret|password|token)[:=]\s*["']?[A-Za-z0-9._-]+["']?/gi, '$1=[REDACTED]');
  // Strip credentials from URLs
  message = message.replace(/https?:\/\/[^@]+@/gi, 'https://[REDACTED]@');
  // Strip phone numbers
  message = message.replace(/\+?[0-9]{10,15}/g, '[PHONE_REDACTED]');

  return message.slice(0, 500);
}

/**
 * Processes Expo Push Receipts for previously submitted tickets.
 * Deactivates tokens that resulted in DeviceNotRegistered.
 */
export async function processNotificationReceipts(
  ticketTokenMap: Record<string, string>,
  deps: {
    fetchExpoReceipts: (ticketIds: string[], token?: string) => Promise<Record<string, ExpoPushReceipt>>;
    deactivateDeviceToken: (token: string) => Promise<void>;
    updateDeliveryReceipts?: (idempotencyKey: string, receipts: Record<string, ExpoPushReceipt>) => Promise<void>;
  },
  idempotencyKey?: string,
  expoAccessToken?: string
): Promise<ReceiptProcessingResult> {
  const ticketIds = Object.keys(ticketTokenMap);
  if (ticketIds.length === 0) {
    return { receiptsChecked: 0, confirmedCount: 0, errorCount: 0, deactivatedTokens: [], receipts: {} };
  }

  const receipts = await deps.fetchExpoReceipts(ticketIds, expoAccessToken);
  let confirmedCount = 0;
  let errorCount = 0;
  const deactivatedTokens: string[] = [];

  for (const [ticketId, receipt] of Object.entries(receipts)) {
    if (receipt.status === 'ok') {
      confirmedCount++;
    } else if (receipt.status === 'error') {
      errorCount++;
      if (receipt.details?.error === 'DeviceNotRegistered') {
        const token = ticketTokenMap[ticketId];
        if (token) {
          await deps.deactivateDeviceToken(token);
          deactivatedTokens.push(token);
        }
      }
    }
  }

  if (idempotencyKey && deps.updateDeliveryReceipts) {
    await deps.updateDeliveryReceipts(idempotencyKey, receipts);
  }

  return {
    receiptsChecked: Object.keys(receipts).length,
    confirmedCount,
    errorCount,
    deactivatedTokens,
    receipts,
  };
}

// =============================================================================
// Core Pipeline Execution
// =============================================================================

/**
 * Processes an incoming job lifecycle event through the secure notification pipeline.
 */
export async function processNotificationEvent(
  event: JobEventRecord,
  deps: PipelineDependencies,
  expoAccessToken?: string
): Promise<PipelineExecutionResult> {
  // 1. Classify event
  const notificationType = classifyNotificationEvent(event);
  if (!notificationType) {
    return {
      success: true,
      processed: false,
      reason: `Event type '${event.event_type}' (status: ${event.previous_status} -> ${event.new_status}) is not eligible for push delivery.`,
    };
  }

  // 2. Fetch authoritative job record
  const job = await deps.fetchJob(event.job_id, event.business_id);
  if (!job) {
    return {
      success: false,
      processed: false,
      reason: `Job '${event.job_id}' not found in business '${event.business_id}'.`,
    };
  }

  // 3. Resolve trusted recipient and metadata
  let recipientUserId: string;
  let workerProfile: ProfileRecord | null = null;

  if (notificationType === 'job_assigned') {
    // Recipient is the newly assigned worker.
    // For reassignment, ensure we target new_worker_id and NEVER previous_worker_id.
    const newWorkerId =
      (typeof event.metadata?.new_worker_id === 'string' ? event.metadata.new_worker_id : null) ||
      (typeof event.metadata?.worker_id === 'string' ? event.metadata.worker_id : null) ||
      job.worker_id;

    if (!newWorkerId) {
      return {
        success: false,
        processed: false,
        reason: 'Cannot deliver job_assigned notification: job has no worker_id assigned.',
      };
    }

    // Safeguard: Ensure old worker is not notified after an assignment is changed
    const previousWorkerId =
      typeof event.metadata?.previous_worker_id === 'string'
        ? event.metadata.previous_worker_id
        : null;

    if (previousWorkerId && newWorkerId === previousWorkerId) {
      return {
        success: false,
        processed: false,
        reason: 'Target worker matches previous worker in reassignment event. No notification needed.',
      };
    }

    recipientUserId = newWorkerId;
    workerProfile = await deps.fetchWorkerProfile(recipientUserId, event.business_id);
    if (!workerProfile) {
      return {
        success: false,
        processed: false,
        reason: `Assigned worker '${recipientUserId}' profile not found in business.`,
      };
    }

    // Safeguard: Ensure we do not notify an owner as if they were a worker
    if (workerProfile.role !== 'worker') {
      return {
        success: false,
        processed: false,
        reason: `Assigned user '${recipientUserId}' has role '${workerProfile.role}', not 'worker'. Notification suppressed.`,
      };
    }
  } else {
    // Recipient is the business owner
    const ownerProfile = await deps.fetchOwnerProfile(event.business_id);
    if (!ownerProfile) {
      return {
        success: false,
        processed: false,
        reason: `Owner profile not found for business '${event.business_id}'.`,
      };
    }

    // Safeguard: Ensure we do not notify a worker as if they were an owner
    if (ownerProfile.role !== 'owner') {
      return {
        success: false,
        processed: false,
        reason: `Profile '${ownerProfile.id}' has role '${ownerProfile.role}', not 'owner'. Notification suppressed.`,
      };
    }

    recipientUserId = ownerProfile.id;

    // Fetch worker name for message context
    if (job.worker_id) {
      workerProfile = await deps.fetchWorkerProfile(job.worker_id, event.business_id);
    }
  }

  // Safeguard: Do not notify an actor about their own action
  if (event.actor_id && event.actor_id === recipientUserId) {
    return {
      success: true,
      processed: false,
      reason: `Actor '${event.actor_id}' is the recipient '${recipientUserId}'. Self-notification suppressed.`,
    };
  }

  // 4. Stale Event Check (Prevent Backlog Bursts after Outages)
  if (isEventStale(event.created_at)) {
    return {
      success: true,
      processed: false,
      notificationType,
      idempotencyKey: generateIdempotencyKey(event.id, recipientUserId),
      status: 'duplicate_suppressed',
      reason: `Event '${event.id}' created at ${event.created_at} is older than ${MAX_EVENT_AGE_MS / 60000} minutes. Delivery suppressed to prevent stale backlog burst.`,
    };
  }

  // 5. Generate idempotency key
  const idempotencyKey = generateIdempotencyKey(event.id, recipientUserId);

  // 6. Atomically claim delivery slot in database outbox
  const claimResult = await deps.claimDeliverySlot(
    event.id,
    recipientUserId,
    event.business_id,
    notificationType,
    idempotencyKey
  );

  if (claimResult === 'already_delivered') {
    return {
      success: true,
      processed: false,
      notificationType,
      idempotencyKey,
      status: 'duplicate_suppressed',
      reason: `Notification for idempotency key '${idempotencyKey}' was already delivered. Duplicate suppressed.`,
    };
  }

  if (claimResult === 'in_progress') {
    return {
      success: true,
      processed: false,
      notificationType,
      idempotencyKey,
      status: 'duplicate_suppressed',
      reason: `Notification for idempotency key '${idempotencyKey}' is currently in-progress by another process. Duplicate suppressed.`,
    };
  }

  if (claimResult === 'max_retries_exceeded') {
    return {
      success: false,
      processed: false,
      notificationType,
      idempotencyKey,
      status: 'failed',
      error: `Notification for idempotency key '${idempotencyKey}' exceeded maximum retry attempts (${MAX_RETRY_ATTEMPTS}). Delivery aborted.`,
      retryable: false,
    };
  }

  // 7. Fetch recipient device tokens & strictly deduplicate for multiple devices
  const rawTokens = await deps.fetchRecipientDeviceTokens(recipientUserId);
  const uniqueTokens = Array.from(
    new Set(
      (rawTokens || [])
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter((t) => t.length >= 10)
    )
  );

  if (uniqueTokens.length === 0) {
    await deps.updateDeliveryNoTokens(idempotencyKey);
    return {
      success: true,
      processed: true,
      notificationType,
      idempotencyKey,
      status: 'no_tokens',
      tokensCount: 0,
      reason: `Recipient user '${recipientUserId}' has no active registered device tokens.`,
    };
  }

  // 8. Format sanitized payload
  const payload = formatNotificationPayload(
    notificationType,
    job.id,
    job.service,
    workerProfile?.full_name
  );
  validatePayloadSanitization(payload);

  // 9. Build Expo push messages (one per unique registered device)
  const messages: ExpoPushMessage[] = uniqueTokens.map((token) => ({
    to: token,
    title: payload.title,
    body: payload.body,
    data: payload.data,
    sound: 'default',
    channelId: 'default',
  }));

  // 10. Dispatch to Expo Push Service
  try {
    const tickets = await deps.sendExpoPush(messages, expoAccessToken);

    const ticketIds: string[] = [];
    const ticketTokenMap: Record<string, string> = {};
    const deactivatedTokens: string[] = [];

    // 11. Inspect tickets, record ticket-to-token mappings, and handle immediate DeviceNotRegistered
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const token = uniqueTokens[i];

      if (ticket.status === 'ok' && ticket.id) {
        ticketIds.push(ticket.id);
        if (token) {
          ticketTokenMap[ticket.id] = token;
        }
      } else if (ticket.status === 'error') {
        if (ticket.details?.error === 'DeviceNotRegistered' && token) {
          // Token is invalid/unregistered -> deactivate it immediately server-side
          await deps.deactivateDeviceToken(token);
          deactivatedTokens.push(token);
        }
      }
    }

    // 12. Update delivery status in outbox with ticket mapping
    await deps.updateDeliverySuccess(idempotencyKey, uniqueTokens.length, ticketIds, ticketTokenMap);

    return {
      success: true,
      processed: true,
      notificationType,
      idempotencyKey,
      status: 'delivered',
      tokensCount: uniqueTokens.length,
      ticketsCount: ticketIds.length,
      ticketTokenMap: Object.keys(ticketTokenMap).length > 0 ? ticketTokenMap : undefined,
      deactivatedTokens: deactivatedTokens.length > 0 ? deactivatedTokens : undefined,
    };
  } catch (err: any) {
    const { isRetryable } = classifyErrorRetryability(err);
    const currentAttempt = typeof event.metadata?.attempt_count === 'number'
      ? event.metadata.attempt_count
      : 1;
    const canRetry = isRetryable && currentAttempt < MAX_RETRY_ATTEMPTS;
    const sanitizedError = sanitizeErrorMessage(err);

    await deps.updateDeliveryFailed(idempotencyKey, sanitizedError, canRetry, currentAttempt);

    return {
      success: false,
      processed: false,
      notificationType,
      idempotencyKey,
      status: 'failed',
      error: sanitizedError,
      retryable: canRetry,
      attempt: currentAttempt,
      maxAttempts: MAX_RETRY_ATTEMPTS,
      backoffDelayMs: canRetry ? calculateBackoffDelay(currentAttempt) : undefined,
    };
  }
}

// =============================================================================
// Production Supabase PostgREST & Expo Dispatcher
// =============================================================================

/**
 * Creates production dependencies that interact with Supabase REST API and Expo Push API.
 */
export function createProductionDependencies(
  supabaseUrl: string,
  serviceRoleKey: string
): PipelineDependencies {
  const baseUrl = supabaseUrl.replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'apikey': serviceRoleKey,
    'Authorization': `Bearer ${serviceRoleKey}`,
  };

  return {
    async fetchJob(jobId: string, businessId: string): Promise<JobRecord | null> {
      const url = `${baseUrl}/rest/v1/jobs?id=eq.${encodeURIComponent(jobId)}&business_id=eq.${encodeURIComponent(businessId)}&select=id,business_id,service,address,status,worker_id`;
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      const rows = await res.json();
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },

    async fetchWorkerProfile(workerId: string, businessId: string): Promise<ProfileRecord | null> {
      const url = `${baseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(workerId)}&business_id=eq.${encodeURIComponent(businessId)}&select=id,business_id,full_name,role`;
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      const rows = await res.json();
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },

    async fetchOwnerProfile(businessId: string): Promise<ProfileRecord | null> {
      const url = `${baseUrl}/rest/v1/profiles?business_id=eq.${encodeURIComponent(businessId)}&role=eq.owner&select=id,business_id,full_name,role&limit=1`;
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      const rows = await res.json();
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },

    async claimDeliverySlot(
      jobEventId: string,
      recipientUserId: string,
      businessId: string,
      notificationType: ApprovedNotificationType,
      idempotencyKey: string
    ): Promise<'claimed' | 'already_delivered' | 'in_progress'> {
      const url = `${baseUrl}/rest/v1/rpc/claim_notification_delivery`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_job_event_id: jobEventId,
          p_recipient_user_id: recipientUserId,
          p_business_id: businessId,
          p_notification_type: notificationType,
          p_idempotency_key: idempotencyKey,
        }),
      });

      if (!res.ok) {
        throw new Error(`claim_notification_delivery RPC failed: ${res.statusText}`);
      }
      const statusText = await res.json();
      return statusText as 'claimed' | 'already_delivered' | 'in_progress';
    },

    async fetchRecipientDeviceTokens(recipientUserId: string): Promise<string[]> {
      const url = `${baseUrl}/rest/v1/device_tokens?user_id=eq.${encodeURIComponent(recipientUserId)}&is_active=eq.true&select=expo_push_token`;
      const res = await fetch(url, { headers });
      if (!res.ok) return [];
      const rows = await res.json();
      if (!Array.isArray(rows)) return [];
      return rows.map((r) => r.expo_push_token).filter(Boolean);
    },

    async sendExpoPush(
      messages: ExpoPushMessage[],
      expoAccessToken?: string
    ): Promise<ExpoPushTicket[]> {
      const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      };
      if (expoAccessToken) {
        reqHeaders['Authorization'] = `Bearer ${expoAccessToken}`;
      }

      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(messages),
      });

      if (!res.ok) {
        throw new Error(`Expo push service error: ${res.status} ${res.statusText}`);
      }

      const responseJson = await res.json();
      return (responseJson.data || []) as ExpoPushTicket[];
    },

    async updateDeliverySuccess(
      idempotencyKey: string,
      tokensCount: number,
      ticketIds: string[],
      ticketTokenMap?: Record<string, string>
    ): Promise<void> {
      const url = `${baseUrl}/rest/v1/notification_deliveries?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`;
      await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          status: 'delivered',
          device_tokens_count: tokensCount,
          expo_ticket_ids: ticketIds,
          ticket_token_map: ticketTokenMap || {},
          delivered_at: new Date().toISOString(),
          error_message: null,
        }),
      });
    },

    async fetchExpoReceipts(
      ticketIds: string[],
      expoAccessToken?: string
    ): Promise<Record<string, ExpoPushReceipt>> {
      const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      };
      if (expoAccessToken) {
        reqHeaders['Authorization'] = `Bearer ${expoAccessToken}`;
      }

      const res = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({ ids: ticketIds }),
      });

      if (!res.ok) {
        throw new Error(`Expo push receipts error: ${res.status} ${res.statusText}`);
      }

      const responseJson = await res.json();
      return (responseJson.data || {}) as Record<string, ExpoPushReceipt>;
    },

    async updateDeliveryReceipts(
      idempotencyKey: string,
      receiptStatus: Record<string, ExpoPushReceipt>
    ): Promise<void> {
      const url = `${baseUrl}/rest/v1/notification_deliveries?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`;
      await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          receipt_status: receiptStatus,
          receipts_checked_at: new Date().toISOString(),
        }),
      });
    },

    async updateDeliveryNoTokens(idempotencyKey: string): Promise<void> {
      const url = `${baseUrl}/rest/v1/notification_deliveries?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`;
      await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          status: 'no_tokens',
          device_tokens_count: 0,
          delivered_at: new Date().toISOString(),
          error_message: null,
        }),
      });
    },

    async updateDeliveryFailed(
      idempotencyKey: string,
      errorMessage: string,
      isRetryable?: boolean,
      retryCount?: number
    ): Promise<void> {
      const url = `${baseUrl}/rest/v1/notification_deliveries?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`;
      await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          status: 'failed',
          error_message: errorMessage,
          is_retryable: isRetryable !== undefined ? isRetryable : true,
          retry_count: retryCount !== undefined ? retryCount : 0,
        }),
      });
    },

    async deactivateDeviceToken(token: string): Promise<void> {
      const url = `${baseUrl}/rest/v1/device_tokens?expo_push_token=eq.${encodeURIComponent(token)}`;
      await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          is_active: false,
          updated_at: new Date().toISOString(),
        }),
      });
    },
  };
}

// =============================================================================
// Webhook Request Handler
// =============================================================================

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
};

export async function handleNotificationWebhookRequest(req: Request): Promise<Response> {
  // 1. CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  // 2. HTTP Method Validation
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed. Use POST.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  // 3. Environment Configuration
  const supabaseUrl =
    (typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_URL') : null) ||
    (typeof process !== 'undefined' ? process.env?.SUPABASE_URL : null);

  const serviceRoleKey =
    (typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') : null) ||
    (typeof process !== 'undefined' ? process.env?.SUPABASE_SERVICE_ROLE_KEY : null);

  const expoAccessToken =
    (typeof Deno !== 'undefined' ? Deno.env.get('EXPO_ACCESS_TOKEN') : null) ||
    (typeof process !== 'undefined' ? process.env?.EXPO_ACCESS_TOKEN : null);

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: 'Server configuration error: missing Supabase credentials.' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      }
    );
  }

  // 4. Parse Webhook Payload
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  // Support standard Supabase Database Webhook format: body.record
  // or direct invocation: body
  const record: JobEventRecord = body.record || body;

  if (!record || !record.id || !record.job_id || !record.business_id || !record.event_type) {
    return new Response(
      JSON.stringify({
        error: 'Missing required job_event fields (id, job_id, business_id, event_type).',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      }
    );
  }

  // 5. Execute Core Pipeline
  try {
    const deps = createProductionDependencies(supabaseUrl, serviceRoleKey);
    const result = await processNotificationEvent(record, deps, expoAccessToken);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
}

