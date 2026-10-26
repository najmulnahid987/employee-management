/**
 * Dispatcher Job Lifecycle State Machine & Transition Rules
 *
 * Authoritative Spec: docs/product-specification.md & AGENTS.md
 *
 * Frozen 8-Status Lifecycle:
 * unassigned -> assigned -> accepted -> on_the_way -> arrived -> in_progress -> completed
 *                                                                             \-> cancelled (from any nonterminal)
 *
 * NOTE: This module defines client-side consistency, UI guards, and typing aids.
 * It is NOT the authorization boundary. The database (PostgreSQL RLS, triggers,
 * and RPCs) authoritatively validates every requested transition.
 */

// =============================================================================
// 1. Status Inventory & Classification
// =============================================================================

/**
 * All 8 frozen lifecycle statuses supported in the database and application.
 */
export const JOB_STATUSES = [
  'unassigned',
  'assigned',
  'accepted',
  'on_the_way',
  'arrived',
  'in_progress',
  'completed',
  'cancelled',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Terminal statuses: terminal jobs can never transition to any other status.
 */
export const TERMINAL_JOB_STATUSES = ['completed', 'cancelled'] as const;
export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

/**
 * Non-terminal statuses: can transition according to state machine rules.
 */
export const NON_TERMINAL_JOB_STATUSES = [
  'unassigned',
  'assigned',
  'accepted',
  'on_the_way',
  'arrived',
  'in_progress',
] as const;
export type NonTerminalJobStatus = (typeof NON_TERMINAL_JOB_STATUSES)[number];

/**
 * Active statuses: jobs currently in the field (travelling, arrived, or working).
 */
export const ACTIVE_JOB_STATUSES = ['on_the_way', 'arrived', 'in_progress'] as const;
export type ActiveJobStatus = (typeof ACTIVE_JOB_STATUSES)[number];

/**
 * Upcoming statuses: jobs not yet underway in the field.
 */
export const UPCOMING_JOB_STATUSES = ['unassigned', 'assigned', 'accepted'] as const;
export type UpcomingJobStatus = (typeof UPCOMING_JOB_STATUSES)[number];

// =============================================================================
// 2. Roles & Actor Constraints
// =============================================================================

export type JobActorRole = 'owner' | 'worker';

// =============================================================================
// 3. Central Transition Maps
// =============================================================================

/**
 * Master State Machine Transition Map
 * Maps each current status to all valid target statuses across all actors.
 */
export const JOB_TRANSITION_MAP: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  unassigned: ['assigned', 'cancelled'],
  assigned: ['accepted', 'unassigned', 'assigned', 'cancelled'],
  accepted: ['on_the_way', 'cancelled'],
  on_the_way: ['arrived', 'cancelled'],
  arrived: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
} as const;

/**
 * Role-Specific Transition Map for Business Owners:
 * - unassigned: assign worker -> assigned, cancel -> cancelled
 * - assigned: reassign worker -> assigned, unassign worker -> unassigned, cancel -> cancelled
 * - accepted..in_progress: cancel -> cancelled
 * - completed / cancelled: none (terminal)
 */
export const OWNER_TRANSITION_MAP: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  unassigned: ['assigned', 'cancelled'],
  assigned: ['unassigned', 'assigned', 'cancelled'],
  accepted: ['cancelled'],
  on_the_way: ['cancelled'],
  arrived: ['cancelled'],
  in_progress: ['cancelled'],
  completed: [],
  cancelled: [],
} as const;

/**
 * Role-Specific Transition Map for Field Workers:
 * - unassigned: none (workers cannot self-assign or interact with unassigned jobs)
 * - assigned: accept -> accepted, decline -> unassigned
 * - accepted: start travel -> on_the_way
 * - on_the_way: record arrival -> arrived
 * - arrived: start work -> in_progress
 * - in_progress: complete work -> completed
 * - completed / cancelled: none (terminal)
 */
export const WORKER_TRANSITION_MAP: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  unassigned: [],
  assigned: ['accepted', 'unassigned'],
  accepted: ['on_the_way'],
  on_the_way: ['arrived'],
  arrived: ['in_progress'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
} as const;

// =============================================================================
// 4. Action Definitions & Mappings
// =============================================================================

export type JobActionType =
  | 'assign_worker'
  | 'reassign_worker'
  | 'unassign_worker'
  | 'cancel_job'
  | 'accept_assignment'
  | 'decline_assignment'
  | 'start_travel'
  | 'record_arrival'
  | 'start_work'
  | 'complete_work';

export interface JobActionDefinition {
  readonly type: JobActionType;
  readonly label: string;
  readonly actor: JobActorRole;
  readonly targetStatus: JobStatus;
  readonly isTerminal?: boolean;
  readonly requiresReason?: boolean;
}

export const JOB_ACTIONS: Readonly<Record<JobActionType, JobActionDefinition>> = {
  assign_worker: {
    type: 'assign_worker',
    label: 'Assign Worker',
    actor: 'owner',
    targetStatus: 'assigned',
  },
  reassign_worker: {
    type: 'reassign_worker',
    label: 'Reassign Worker',
    actor: 'owner',
    targetStatus: 'assigned',
  },
  unassign_worker: {
    type: 'unassign_worker',
    label: 'Unassign Worker',
    actor: 'owner',
    targetStatus: 'unassigned',
  },
  cancel_job: {
    type: 'cancel_job',
    label: 'Cancel Job',
    actor: 'owner',
    targetStatus: 'cancelled',
    isTerminal: true,
    requiresReason: true,
  },
  accept_assignment: {
    type: 'accept_assignment',
    label: 'Accept Job',
    actor: 'worker',
    targetStatus: 'accepted',
  },
  decline_assignment: {
    type: 'decline_assignment',
    label: 'Decline Assignment',
    actor: 'worker',
    targetStatus: 'unassigned',
    requiresReason: true,
  },
  start_travel: {
    type: 'start_travel',
    label: 'Start Travel',
    actor: 'worker',
    targetStatus: 'on_the_way',
  },
  record_arrival: {
    type: 'record_arrival',
    label: 'Record Arrival',
    actor: 'worker',
    targetStatus: 'arrived',
  },
  start_work: {
    type: 'start_work',
    label: 'Start Work',
    actor: 'worker',
    targetStatus: 'in_progress',
  },
  complete_work: {
    type: 'complete_work',
    label: 'Complete Work',
    actor: 'worker',
    targetStatus: 'completed',
    isTerminal: true,
  },
} as const;

/**
 * Maps each status to the valid action types available from that status.
 */
export const STATUS_ACTION_MAP: Readonly<Record<JobStatus, readonly JobActionType[]>> = {
  unassigned: ['assign_worker', 'cancel_job'],
  assigned: [
    'accept_assignment',
    'decline_assignment',
    'reassign_worker',
    'unassign_worker',
    'cancel_job',
  ],
  accepted: ['start_travel', 'cancel_job'],
  on_the_way: ['record_arrival', 'cancel_job'],
  arrived: ['start_work', 'cancel_job'],
  in_progress: ['complete_work', 'cancel_job'],
  completed: [],
  cancelled: [],
} as const;

/**
 * Deterministic status sorting priority for worker inbox & today views.
 */
export const WORKER_STATUS_PRIORITY: Readonly<Record<JobStatus, number>> = {
  in_progress: 1,
  arrived: 2,
  on_the_way: 3,
  assigned: 4,
  accepted: 5,
  completed: 6,
  cancelled: 7,
  unassigned: 8,
} as const;

// =============================================================================
// 5. Helper & Verification Functions
// =============================================================================

/**
 * Type guard checking if a string is a valid JobStatus.
 */
export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * Checks if a status is terminal ('completed' | 'cancelled').
 */
export function isTerminalJobStatus(status: JobStatus): status is TerminalJobStatus {
  return status === 'completed' || status === 'cancelled';
}

/**
 * Checks if a status represents an active field visit ('on_the_way' | 'arrived' | 'in_progress').
 */
export function isJobActive(status: JobStatus): boolean {
  return status === 'on_the_way' || status === 'arrived' || status === 'in_progress';
}

/**
 * Checks if a status represents an upcoming visit ('unassigned' | 'assigned' | 'accepted').
 */
export function isJobUpcoming(status: JobStatus): boolean {
  return status === 'unassigned' || status === 'assigned' || status === 'accepted';
}

/**
 * Checks if a status requires worker action ('assigned').
 */
export function isJobActionRequired(status: JobStatus): boolean {
  return status === 'assigned';
}

/**
 * Returns allowed next statuses from currentStatus, optionally filtered by actor role.
 */
export function getAllowedNextStatuses(
  currentStatus: JobStatus,
  role?: JobActorRole
): readonly JobStatus[] {
  if (role === 'owner') {
    return OWNER_TRANSITION_MAP[currentStatus];
  }
  if (role === 'worker') {
    return WORKER_TRANSITION_MAP[currentStatus];
  }
  return JOB_TRANSITION_MAP[currentStatus];
}

/**
 * Checks whether a job can transition from currentStatus to nextStatus,
 * optionally verifying authorization for the specified role.
 */
export function canTransitionJob(
  currentStatus: JobStatus,
  nextStatus: JobStatus,
  role?: JobActorRole
): boolean {
  const allowed = getAllowedNextStatuses(currentStatus, role);
  return allowed.includes(nextStatus);
}

/**
 * Returns all valid next actions available from the current status,
 * optionally filtered by actor role.
 */
export function getValidNextActions(
  currentStatus: JobStatus,
  role?: JobActorRole
): readonly JobActionDefinition[] {
  const actionKeys = STATUS_ACTION_MAP[currentStatus] || [];
  const actions = actionKeys.map((key) => JOB_ACTIONS[key]);
  if (!role) {
    return actions;
  }
  return actions.filter((action) => action.actor === role);
}

/**
 * Returns the single sequential forward action for a worker in the field,
 * or null if no worker action is permitted from the current status.
 */
export function getNextWorkerAction(currentStatus: JobStatus): JobActionDefinition | null {
  switch (currentStatus) {
    case 'assigned':
      return JOB_ACTIONS.accept_assignment;
    case 'accepted':
      return JOB_ACTIONS.start_travel;
    case 'on_the_way':
      return JOB_ACTIONS.record_arrival;
    case 'arrived':
      return JOB_ACTIONS.start_work;
    case 'in_progress':
      return JOB_ACTIONS.complete_work;
    default:
      return null;
  }
}

// =============================================================================
// 6. Lifecycle Timestamp Consistency & Field Mappings
// =============================================================================

/**
 * All lifecycle transition timestamp columns in `public.jobs`.
 * Note: `created_at`, `updated_at`, and `scheduled_at` are operational timestamps
 * and are not lifecycle transition timestamps.
 */
export const LIFECYCLE_TIMESTAMP_FIELDS = [
  'assigned_at',
  'accepted_at',
  'travelling_at',
  'arrived_at',
  'started_at',
  'completed_at',
  'cancelled_at',
] as const;

export type LifecycleTimestampField = (typeof LIFECYCLE_TIMESTAMP_FIELDS)[number];

/**
 * Maps each of the 8 lifecycle statuses to its corresponding transition timestamp column in `public.jobs`.
 * - `unassigned`: `null` (initial job creation timestamp is captured in `created_at`;
 *   subsequent unassignments/declines are captured in `job_events.created_at`).
 * - `assigned`: `assigned_at`
 * - `accepted`: `accepted_at`
 * - `on_the_way`: `travelling_at`
 * - `arrived`: `arrived_at`
 * - `in_progress`: `started_at`
 * - `completed`: `completed_at`
 * - `cancelled`: `cancelled_at`
 */
export const STATUS_TIMESTAMP_FIELD_MAP: Readonly<Record<JobStatus, LifecycleTimestampField | null>> = {
  unassigned: null,
  assigned: 'assigned_at',
  accepted: 'accepted_at',
  on_the_way: 'travelling_at',
  arrived: 'arrived_at',
  in_progress: 'started_at',
  completed: 'completed_at',
  cancelled: 'cancelled_at',
} as const;

/**
 * Type guard checking if a string matches a recognized lifecycle transition timestamp column name.
 */
export function isLifecycleTimestampField(field: unknown): field is LifecycleTimestampField {
  return typeof field === 'string' && (LIFECYCLE_TIMESTAMP_FIELDS as readonly string[]).includes(field);
}

/**
 * Returns the transition timestamp column name associated with a job status,
 * or `null` if the status does not have a dedicated transition timestamp (e.g. `unassigned`).
 */
export function getStatusTimestampField(status: JobStatus): LifecycleTimestampField | null {
  return STATUS_TIMESTAMP_FIELD_MAP[status];
}

