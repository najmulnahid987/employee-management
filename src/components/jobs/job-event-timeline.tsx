import React, { useMemo, useState } from 'react';
import {
  StyleProp,
  StyleSheet,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, Loading, StatusBadge } from '@/components/ui';
import { JobStatus, Palette, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { JobEventRecord } from '@/lib/jobs';

export interface JobEventTimelineProps {
  events?: JobEventRecord[];
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  defaultExpanded?: boolean;
}

/**
 * Formats ISO timestamp into a clean, human-readable local time and date.
 */
export function formatEventTimestamp(dateString: string): string {
  if (!dateString) return '';
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return dateString;

  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (isToday) {
    return `Today at ${timeStr}`;
  }

  const dateStr = d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });

  return `${dateStr}, ${timeStr}`;
}

/**
 * Formats actor display name and role attribution.
 */
export function formatEventActor(event: {
  actor_name?: string | null;
  actor_role: string;
}): string {
  const role = event.actor_role;
  const name = event.actor_name?.trim();

  if (name) {
    if (role === 'owner') return `${name} (Owner)`;
    if (role === 'worker') return `${name} (Technician)`;
    if (role === 'system') return 'System';
    return `${name} (${role})`;
  }

  if (role === 'owner') return 'Business Owner';
  if (role === 'worker') return 'Field Technician';
  if (role === 'system') return 'System';

  return 'Dispatcher System';
}

/**
 * Maps event_type and new_status to a human-readable title.
 */
export function getEventTitle(event: {
  event_type: string;
  new_status?: string | null;
}): string {
  switch (event.event_type) {
    case 'job_created':
      return 'Job Created';
    case 'worker_assigned':
      return 'Technician Assigned';
    case 'worker_unassigned':
      return 'Technician Unassigned';
    case 'worker_reassigned':
      return 'Technician Reassigned';
    case 'job_cancelled':
      return 'Job Cancelled';
    case 'declined':
      return 'Assignment Declined';
    case 'status_changed': {
      switch (event.new_status) {
        case 'assigned':
          return 'Job Assigned';
        case 'accepted':
          return 'Assignment Accepted';
        case 'on_the_way':
          return 'Technician En Route';
        case 'arrived':
          return 'Arrived On Site';
        case 'in_progress':
          return 'Work Started';
        case 'completed':
          return 'Job Completed';
        case 'cancelled':
          return 'Job Cancelled';
        case 'unassigned':
          return 'Returned to Queue';
        default:
          return event.new_status
            ? `Status: ${event.new_status.replace(/_/g, ' ')}`
            : 'Status Updated';
      }
    }
    default:
      return event.event_type
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
  }
}

/**
 * Selects node dot color based on event semantics.
 */
export function getEventDotColor(
  event: { event_type: string; new_status?: string | null }
): string {
  if (event.event_type === 'job_cancelled' || event.new_status === 'cancelled') {
    return Palette.redDot;
  }
  if (event.new_status === 'completed') {
    return Palette.greenDot;
  }
  if (event.event_type === 'declined' || event.event_type === 'worker_unassigned') {
    return Palette.amberDot;
  }
  if (
    event.event_type === 'worker_assigned' ||
    event.event_type === 'worker_reassigned' ||
    event.new_status === 'on_the_way' ||
    event.new_status === 'arrived' ||
    event.new_status === 'in_progress'
  ) {
    return Palette.blueDot;
  }
  if (event.new_status === 'accepted') {
    return Palette.purpleDot;
  }
  return Palette.neutral400;
}

const INITIAL_VISIBLE_COUNT = 6;

export function JobEventTimeline({
  events,
  isLoading = false,
  error = null,
  onRetry,
  style,
  testID = 'job-event-timeline',
  defaultExpanded = false,
}: JobEventTimelineProps) {
  const theme = useTheme();
  const [isExpanded, setIsExpanded] = useState<boolean>(defaultExpanded);

  // Deterministic chronological ordering: oldest first (created_at ASC, id ASC)
  const sortedEvents = useMemo(() => {
    if (!events || events.length === 0) return [];
    return [...events].sort((a, b) => {
      const timeA = new Date(a.created_at).getTime();
      const timeB = new Date(b.created_at).getTime();
      if (timeA !== timeB) {
        return timeA - timeB;
      }
      return (a.id || '').localeCompare(b.id || '');
    });
  }, [events]);

  const hasEvents = sortedEvents.length > 0;
  const shouldShowToggle = sortedEvents.length > INITIAL_VISIBLE_COUNT;

  // When collapsed, display the first event (creation) and the latest (N - 1) events
  const displayedEvents = useMemo(() => {
    if (!shouldShowToggle || isExpanded) {
      return sortedEvents;
    }
    // Show the most recent events when collapsed
    return sortedEvents.slice(-INITIAL_VISIBLE_COUNT);
  }, [sortedEvents, shouldShowToggle, isExpanded]);

  return (
    <Card variant="surface" style={[styles.card, style]} testID={testID}>
      {/* Header */}
      <View style={styles.headerRow}>
        <ThemedText type="headline">Activity Timeline</ThemedText>
        {hasEvents ? (
          <View style={[styles.countBadge, { backgroundColor: theme.surfaceSecondary }]}>
            <ThemedText type="captionMedium" themeColor="textSecondary">
              {sortedEvents.length} {sortedEvents.length === 1 ? 'event' : 'events'}
            </ThemedText>
          </View>
        ) : null}
      </View>

      {/* Error State */}
      {error ? (
        <View
          style={[
            styles.errorContainer,
            { backgroundColor: theme.dangerBackground, borderColor: theme.dangerBorder },
          ]}>
          <ThemedText type="captionMedium" style={{ color: theme.danger }}>
            {error}
          </ThemedText>
          {onRetry ? (
            <Button
              label="Retry"
              variant="outline"
              size="sm"
              onPress={onRetry}
              style={styles.retryButton}
            />
          ) : null}
        </View>
      ) : null}

      {/* Loading State */}
      {isLoading && !hasEvents ? (
        <View style={styles.loadingContainer}>
          <Loading label="Loading event history..." />
        </View>
      ) : null}

      {/* Empty State (Honest handling of jobs without events) */}
      {!isLoading && !hasEvents && !error ? (
        <View style={styles.emptyContainer}>
          <ThemedText type="body" themeColor="textSecondary" style={{ textAlign: 'center' }}>
            No recorded history for this job.
          </ThemedText>
          <ThemedText
            type="caption"
            themeColor="textSecondary"
            style={{ textAlign: 'center', marginTop: 4 }}>
            Lifecycle transitions and technician assignments will appear here chronologically.
          </ThemedText>
        </View>
      ) : null}

      {/* Chronological Event Track */}
      {hasEvents ? (
        <View style={styles.timelineList}>
          {shouldShowToggle && !isExpanded ? (
            <TouchableOpacity
              onPress={() => setIsExpanded(true)}
              style={[styles.expandBanner, { backgroundColor: theme.surfaceSecondary, borderColor: theme.border }]}>
              <ThemedText type="captionMedium" themeColor="primary">
                Show {sortedEvents.length - displayedEvents.length} earlier events
              </ThemedText>
            </TouchableOpacity>
          ) : null}

          {displayedEvents.map((event, index) => {
            const isLast = index === displayedEvents.length - 1;
            const dotColor = getEventDotColor(event);
            const title = getEventTitle(event);
            const actorLabel = formatEventActor(event);
            const timestamp = formatEventTimestamp(event.created_at);

            const hasStatusTransition =
              Boolean(event.previous_status && event.new_status && event.previous_status !== event.new_status);
            const hasInitialStatus =
              !event.previous_status && Boolean(event.new_status);

            const meta = event.metadata || {};
            const cancellationReason =
              typeof meta.cancellation_reason === 'string' && meta.cancellation_reason.trim()
                ? meta.cancellation_reason.trim()
                : null;
            const declineReason =
              typeof meta.reason === 'string' && meta.reason.trim()
                ? meta.reason.trim()
                : null;
            const note =
              typeof meta.note === 'string' && meta.note.trim()
                ? meta.note.trim()
                : null;
            const serviceScope =
              event.event_type === 'job_created' && typeof meta.service === 'string' && meta.service.trim()
                ? meta.service.trim()
                : null;

            return (
              <View key={event.id} style={styles.timelineRow}>
                {/* Node Track Column */}
                <View style={styles.nodeColumn}>
                  <View style={[styles.nodeDot, { backgroundColor: dotColor }]} />
                  {!isLast ? (
                    <View style={[styles.connectingLine, { backgroundColor: theme.border }]} />
                  ) : null}
                </View>

                {/* Content Column */}
                <View style={[styles.contentColumn, !isLast && styles.contentColumnSpacing]}>
                  {/* Top Line: Event Title + Timestamp */}
                  <View style={styles.titleRow}>
                    <ThemedText type="bodyMedium" style={styles.eventTitle}>
                      {title}
                    </ThemedText>
                    <ThemedText type="caption" themeColor="textSecondary" style={styles.timestampText}>
                      {timestamp}
                    </ThemedText>
                  </View>

                  {/* Actor Attribution */}
                  <ThemedText type="caption" themeColor="textSecondary" style={styles.actorText}>
                    By {actorLabel}
                  </ThemedText>

                  {/* Previous / New Status Transition Badge (where recorded and useful) */}
                  {hasStatusTransition ? (
                    <View style={styles.statusRow}>
                      <StatusBadge status={event.previous_status as JobStatus} size="sm" />
                      <ThemedText type="caption" themeColor="textSecondary" style={styles.statusArrow}>
                        →
                      </ThemedText>
                      <StatusBadge status={event.new_status as JobStatus} size="sm" />
                    </View>
                  ) : hasInitialStatus && event.event_type === 'job_created' ? (
                    <View style={styles.statusRow}>
                      <StatusBadge status={event.new_status as JobStatus} size="sm" />
                    </View>
                  ) : null}

                  {/* Allowlisted Meaningful Metadata (Never renders raw UUIDs or arbitrary JSON) */}
                  {cancellationReason ? (
                    <View
                      style={[
                        styles.metadataAlert,
                        { backgroundColor: theme.dangerBackground, borderColor: theme.dangerBorder },
                      ]}>
                      <ThemedText type="caption" style={{ color: theme.danger }}>
                        Cancellation reason: {cancellationReason}
                      </ThemedText>
                    </View>
                  ) : null}

                  {declineReason ? (
                    <View
                      style={[
                        styles.metadataAlert,
                        { backgroundColor: Palette.amberBg, borderColor: Palette.amberBorder },
                      ]}>
                      <ThemedText type="caption" style={{ color: Palette.amberText }}>
                        Decline reason: {declineReason}
                      </ThemedText>
                    </View>
                  ) : null}

                  {event.target_worker_name ? (
                    <ThemedText type="caption" themeColor="textSecondary">
                      Technician: {event.target_worker_name}
                    </ThemedText>
                  ) : null}

                  {event.previous_worker_name ? (
                    <ThemedText type="caption" themeColor="textSecondary">
                      Previous technician: {event.previous_worker_name}
                    </ThemedText>
                  ) : null}

                  {serviceScope ? (
                    <ThemedText type="caption" themeColor="textSecondary">
                      Scope: {serviceScope}
                    </ThemedText>
                  ) : null}

                  {note ? (
                    <ThemedText type="caption" themeColor="textSecondary" style={{ fontStyle: 'italic' }}>
                      Note: {note}
                    </ThemedText>
                  ) : null}
                </View>
              </View>
            );
          })}

          {shouldShowToggle && isExpanded ? (
            <TouchableOpacity
              onPress={() => setIsExpanded(false)}
              style={[styles.expandBanner, { backgroundColor: theme.surfaceSecondary, borderColor: theme.border }]}>
              <ThemedText type="captionMedium" themeColor="primary">
                Show fewer events
              </ThemedText>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: Spacing.base,
    gap: Spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  countBadge: {
    paddingHorizontal: Spacing.xs + 2,
    paddingVertical: 2,
    borderRadius: Radii.pill,
  },
  errorContainer: {
    padding: Spacing.sm,
    borderRadius: Radii.sm,
    borderWidth: 1,
    gap: Spacing.xs,
  },
  retryButton: {
    alignSelf: 'flex-start',
  },
  loadingContainer: {
    paddingVertical: Spacing.base,
    alignItems: 'center',
  },
  emptyContainer: {
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.sm,
    alignItems: 'center',
  },
  timelineList: {
    marginTop: Spacing.xs,
  },
  timelineRow: {
    flexDirection: 'row',
  },
  nodeColumn: {
    width: 22,
    alignItems: 'center',
  },
  nodeDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 4,
  },
  connectingLine: {
    width: 2,
    flex: 1,
    marginTop: 2,
    marginBottom: -4,
  },
  contentColumn: {
    flex: 1,
    paddingLeft: Spacing.xs,
    gap: 4,
  },
  contentColumnSpacing: {
    paddingBottom: Spacing.md,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: Spacing.xs,
  },
  eventTitle: {
    flex: 1,
    fontWeight: '600',
  },
  timestampText: {
    fontSize: 11,
  },
  actorText: {
    fontSize: 12,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  statusArrow: {
    fontSize: 12,
  },
  metadataAlert: {
    paddingHorizontal: Spacing.xs + 2,
    paddingVertical: 4,
    borderRadius: Radii.xs,
    borderWidth: 1,
    marginTop: 2,
  },
  expandBanner: {
    paddingVertical: Spacing.xs,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radii.sm,
    borderWidth: 1,
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
});
