import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, View } from 'react-native';

import { LocationPermissionModal } from '@/components/location/location-permission-modal';
import { TrackingStatusIndicator } from '@/components/location/tracking-status-indicator';
import { ThemedText } from '@/components/themed-text';
import { Button, Card, Loading, ScreenContainer, StatusBadge } from '@/components/ui';
import { JobStatus, Palette, Radii, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useLocationPermission } from '@/hooks/use-location-permission';
import { useWorkerLocationTracker } from '@/hooks/use-worker-location-tracker';
import { useTheme } from '@/hooks/use-theme';
import {
  declineJobAssignment,
  fetchWorkerJobDetails,
  Job,
  requestJobTransition,
  subscribeToJobTransitions,
} from '@/lib/jobs';
import { stopBackgroundTrackingAsync } from '@/lib/background-location-task';
import { foregroundLocationTracker } from '@/lib/location-tracker';
import { launchNativeMaps, launchPhoneCall } from '@/lib/launchers';
import { getNextWorkerAction } from '@/lib/lifecycle';
import { subscribeToJobSignals } from '@/lib/realtime';

function formatScheduledDateTime(scheduledAt: string | null): string {
  if (!scheduledAt) return 'Time not specified';
  try {
    const d = new Date(scheduledAt);
    if (isNaN(d.getTime())) return 'Scheduled';
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return 'Scheduled';
  }
}

export default function WorkerJobDetailsScreen() {
  const theme = useTheme();
  const { businessId, user } = useAuth();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const [job, setJob] = useState<Job | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(id));
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isExecutingAction, setIsExecutingAction] = useState<boolean>(false);
  const [isDeclining, setIsDeclining] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // M11.3 Location Permission & Tracking Policy Management
  const {
    permissionState,
    isExplanationVisible,
    isRequesting: isRequestingLocation,
    ensurePermissionForTravel,
    handleConfirmExplanation,
    handleDismissExplanation,
  } = useLocationPermission();

  // M11.4 & M11.5 Foreground & Background Location Tracking Integration
  const isAssignedToCurrentWorker = Boolean(
    job && user?.id && job.worker_id === user.id
  );
  const tracker = useWorkerLocationTracker({
    jobId: job?.id,
    workerId: user?.id,
    jobStatus: job?.status as JobStatus,
    isAssignedToCurrentWorker,
    permissionState,
  });

  // Synchronous double-tap lock preventing concurrent action executions
  const actionLockRef = useRef<boolean>(false);
  // Concurrency token preventing out-of-order race conditions
  const activeRequestRef = useRef<number>(0);

  const loadJob = useCallback(
    async (isPullRefresh: boolean = false) => {
      if (!id || !businessId || !user?.id) {
        ++activeRequestRef.current;
        setIsLoading(false);
        setIsRefreshing(false);
        return;
      }

      if (isPullRefresh) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      const requestId = ++activeRequestRef.current;

      try {
        const { job: loadedJob, error: loadErr } = await fetchWorkerJobDetails(
          id,
          businessId,
          user.id
        );

        if (activeRequestRef.current === requestId) {
          if (loadErr) {
            setError(loadErr);
          } else {
            setJob(loadedJob);
            setError(null);
          }
        }
      } catch (err) {
        if (activeRequestRef.current === requestId) {
          setError(err instanceof Error ? err.message : 'Failed to load job details');
        }
      } finally {
        if (activeRequestRef.current === requestId) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [id, businessId, user?.id]
  );

  useEffect(() => {
    loadJob(false);
  }, [loadJob]);

  // Clean unmount token invalidation
  useEffect(() => {
    const reqRef = activeRequestRef;
    return () => {
      reqRef.current++;
    };
  }, []);

  // Reconcile and reload authoritative job details when screen gains focus
  useFocusEffect(
    useCallback(() => {
      loadJob(false);
    }, [loadJob])
  );

  // Invalidate and reload job details if this job transitions elsewhere or Realtime signal arrives
  useEffect(() => {
    const unsubTransitions = subscribeToJobTransitions((updatedJobId) => {
      if (updatedJobId === id || updatedJobId === '*') {
        loadJob(false);
      }
    });
    const unsubSignals = subscribeToJobSignals((signal) => {
      if (signal.jobId === id || signal.jobId === '*') {
        loadJob(false);
      }
    });
    return () => {
      unsubTransitions();
      unsubSignals();
    };
  }, [id, loadJob]);

  // Advance Status Handler (for sequential worker transitions)
  const handleAdvanceStatus = (targetStatus: JobStatus) => {
    if (!job || isExecutingAction || isDeclining || actionLockRef.current) return;

    // Explicit confirmation dialog required before completing a job (completion is final)
    if (targetStatus === 'completed') {
      Alert.alert(
        'Complete Service Visit?',
        'Are you sure you want to mark this service visit as completed? Completion is final and cannot be reopened or undone.',
        [
          { text: 'Keep In Progress', style: 'cancel' },
          {
            text: 'Confirm Completion',
            style: 'default',
            onPress: () => performStatusAdvance('completed'),
          },
        ]
      );
      return;
    }

    // M11.3: Explain tracking policy and request location permission before entering field travel
    if (targetStatus === 'on_the_way') {
      ensurePermissionForTravel(() => {
        performStatusAdvance('on_the_way');
      });
      return;
    }

    performStatusAdvance(targetStatus);
  };

  const performStatusAdvance = async (targetStatus: JobStatus) => {
    if (!job || actionLockRef.current) return;
    actionLockRef.current = true;
    setIsExecutingAction(true);
    try {
      const result = await requestJobTransition({
        jobId: job.id,
        targetStatus,
        currentStatus: job.status as JobStatus,
        role: 'worker',
      });

      if (result.success && result.job) {
        setJob(result.job);
        if (targetStatus === 'accepted') {
          Alert.alert(
            'Job Accepted',
            'You have confirmed this assignment. It is now part of your active visits.'
          );
        } else if (targetStatus === 'completed') {
          foregroundLocationTracker.stopTracking();
          await stopBackgroundTrackingAsync();
          Alert.alert(
            'Job Completed',
            'Service visit marked as completed.'
          );
        }
      } else {
        // Backend rejection or stale status: alert user and refresh current authoritative job state
        Alert.alert(
          'Unable to Update Job',
          result.error || 'The job status has changed. Refreshing current state.'
        );
        await loadJob(false);
      }
    } catch (err) {
      Alert.alert(
        'Unable to Update Job',
        err instanceof Error ? err.message : 'An unexpected error occurred.'
      );
      await loadJob(false);
    } finally {
      actionLockRef.current = false;
      setIsExecutingAction(false);
    }
  };

  // Explicit Decline Job Handler
  const handleDecline = () => {
    if (!job || isExecutingAction || isDeclining || actionLockRef.current) return;

    Alert.alert(
      'Decline Service Assignment?',
      'This job will be returned to your business dispatcher for reassignment and removed from your schedule. Are you sure you want to decline?',
      [
        { text: 'Keep Assignment', style: 'cancel' },
        {
          text: 'Decline Job',
          style: 'destructive',
          onPress: async () => {
            if (actionLockRef.current) return;
            actionLockRef.current = true;
            setIsDeclining(true);
            try {
              const result = await declineJobAssignment(
                job.id,
                'Declined by technician',
                job.status as JobStatus
              );
              if (result.success) {
                foregroundLocationTracker.stopTracking();
                await stopBackgroundTrackingAsync();
                Alert.alert(
                  'Assignment Declined',
                  'The job has been returned to dispatch for reassignment.',
                  [
                    {
                      text: 'OK',
                      onPress: () => router.back(),
                    },
                  ]
                );
              } else {
                Alert.alert('Unable to Decline Job', result.error || 'Failed to decline job.');
                await loadJob(false);
              }
            } catch (err) {
              Alert.alert(
                'Unable to Decline Job',
                err instanceof Error ? err.message : 'An unexpected error occurred.'
              );
              await loadJob(false);
            } finally {
              actionLockRef.current = false;
              setIsDeclining(false);
            }
          },
        },
      ]
    );
  };

  if (isLoading && !isRefreshing) {
    return <Loading fullScreen label="Loading job details..." />;
  }

  if (!id) {
    return (
      <ScreenContainer scrollable withPadding>
        <View style={styles.container}>
          <Card variant="outline" style={styles.card}>
            <ThemedText type="headline">No Job Specified</ThemedText>
            <ThemedText type="body" themeColor="textSecondary">
              Please select a service job from your Today schedule or Assigned Jobs list.
            </ThemedText>
            <Button
              label="Go Back"
              variant="outline"
              size="sm"
              onPress={() => router.back()}
              style={{ marginTop: Spacing.sm }}
            />
          </Card>
        </View>
      </ScreenContainer>
    );
  }

  if (error || !job) {
    return (
      <ScreenContainer
        scrollable
        withPadding
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => loadJob(true)} />}>
        <View style={styles.container}>
          <Card
            variant="outline"
            style={[
              styles.card,
              { borderColor: theme.dangerBorder, backgroundColor: theme.dangerBackground },
            ]}>
            <ThemedText type="headline" style={{ color: theme.danger }}>
              Job Unavailable
            </ThemedText>
            <ThemedText type="body" themeColor="textSecondary">
              {error || 'This job is no longer assigned to your account or has been unassigned.'}
            </ThemedText>
            <Button
              label="Return to Schedule"
              variant="outline"
              size="sm"
              onPress={() => router.back()}
              style={{ marginTop: Spacing.sm }}
            />
          </Card>
        </View>
      </ScreenContainer>
    );
  }

  const isAssigned = job.status === 'assigned';
  const isAccepted = job.status === 'accepted';
  const isTravelling = job.status === 'on_the_way';
  const isArrived = job.status === 'arrived';
  const isInProgress = job.status === 'in_progress';
  const isCompleted = job.status === 'completed';
  const isCancelled = job.status === 'cancelled';
  const shortJobId = `JOB-${job.id.slice(0, 6).toUpperCase()}`;

  const nextWorkerAction = getNextWorkerAction(job.status as JobStatus);

  return (
    <ScreenContainer
      scrollable
      withPadding
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => loadJob(true)} />}>
      {/* M11.3 Location Permission Explanation Modal */}
      <LocationPermissionModal
        visible={isExplanationVisible}
        onConfirm={handleConfirmExplanation}
        onDismiss={handleDismissExplanation}
        isRequesting={isRequestingLocation}
      />

      <View style={styles.container}>
        {/* Status Header */}
        <View style={styles.statusRow}>
          <StatusBadge status={job.status as JobStatus} size="md" />
          <ThemedText type="caption" themeColor="textSecondary">
            #{shortJobId}
          </ThemedText>
        </View>

        {/* Lifecycle Status Banners */}
        {isAssigned ? (
          <View style={[styles.bannerCard, { backgroundColor: Palette.amberBg, borderColor: Palette.amberBorder }]}>
            <ThemedText type="bodyMedium" style={{ color: Palette.amberText, fontWeight: '600' }}>
              Assignment Awaiting Your Response
            </ThemedText>
            <ThemedText type="caption" style={{ color: Palette.amberText }}>
              Review the service site and instructions below. Accept to confirm your visit, or decline to return it to dispatch.
            </ThemedText>
          </View>
        ) : isAccepted ? (
          <View style={[styles.bannerCard, { backgroundColor: Palette.greenBg, borderColor: Palette.greenBorder }]}>
            <ThemedText type="bodyMedium" style={{ color: Palette.greenText, fontWeight: '600' }}>
              Assignment Confirmed
            </ThemedText>
            <ThemedText type="caption" style={{ color: Palette.greenText }}>
              You have accepted this service visit. Tap "Start Travel" below when you are en route to the site.
            </ThemedText>
          </View>
        ) : isTravelling ? (
          <View style={[styles.bannerCard, { backgroundColor: Palette.blueBg, borderColor: Palette.blueBorder }]}>
            <ThemedText type="bodyMedium" style={{ color: Palette.blueText, fontWeight: '600' }}>
              En Route to Service Site
            </ThemedText>
            <ThemedText type="caption" style={{ color: Palette.blueText }}>
              Travel is in progress. Tap "Record Arrival" once you arrive at the customer location.
            </ThemedText>
          </View>
        ) : isArrived ? (
          <View style={[styles.bannerCard, { backgroundColor: Palette.blueBg, borderColor: Palette.blueBorder }]}>
            <ThemedText type="bodyMedium" style={{ color: Palette.blueText, fontWeight: '600' }}>
              Arrived at Service Site
            </ThemedText>
            <ThemedText type="caption" style={{ color: Palette.blueText }}>
              You have reached the site. Prepare tools and tap "Start Work" when ready to begin.
            </ThemedText>
          </View>
        ) : isInProgress ? (
          <View style={[styles.bannerCard, { backgroundColor: Palette.blueBg, borderColor: Palette.blueBorder }]}>
            <ThemedText type="bodyMedium" style={{ color: Palette.blueText, fontWeight: '600' }}>
              Service Visit In Progress
            </ThemedText>
            <ThemedText type="caption" style={{ color: Palette.blueText }}>
              Work is actively underway. Tap "Complete Work" when service is finished.
            </ThemedText>
          </View>
        ) : isCompleted ? (
          <View style={[styles.bannerCard, { backgroundColor: Palette.greenBg, borderColor: Palette.greenBorder }]}>
            <ThemedText type="bodyMedium" style={{ color: Palette.greenText, fontWeight: '600' }}>
              Service Visit Completed
            </ThemedText>
            <ThemedText type="caption" style={{ color: Palette.greenText }}>
              This visit was completed successfully. Terminal status reached.
            </ThemedText>
          </View>
        ) : isCancelled ? (
          <View style={[styles.bannerCard, { backgroundColor: theme.dangerBackground, borderColor: theme.dangerBorder }]}>
            <ThemedText type="bodyMedium" style={{ color: theme.danger, fontWeight: '600' }}>
              Service Visit Cancelled
            </ThemedText>
            <ThemedText type="caption" style={{ color: theme.danger }}>
              This job was cancelled by dispatch.{job.cancellation_reason ? ` Reason: ${job.cancellation_reason}` : ''}
            </ThemedText>
          </View>
        ) : null}

        {/* M11.4 & M11.5: Foreground & Background Location Tracking Status Indicator */}
        {(isTravelling || isArrived || isInProgress) && isAssignedToCurrentWorker ? (
          <TrackingStatusIndicator
            isTracking={tracker.isTracking}
            isBackgroundActive={tracker.isBackgroundActive}
            trackingMode={tracker.trackingMode}
            lastPosition={tracker.lastPosition}
            lastSubmittedAt={tracker.lastSubmittedAt}
            isWriting={tracker.isWriting}
            trackingError={tracker.trackingError}
            permissionState={permissionState}
          />
        ) : null}

        {/* Service Scope Card */}
        <Card variant="surface" style={styles.card}>
          <ThemedText type="label" themeColor="textSecondary">
            SERVICE SCOPE
          </ThemedText>
          <ThemedText type="title">{job.service}</ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Scheduled: {formatScheduledDateTime(job.scheduled_at)}
          </ThemedText>
        </Card>

        {/* Customer & Location Card */}
        <Card variant="surface" style={styles.card}>
          <ThemedText type="label" themeColor="textSecondary">
            CUSTOMER & SERVICE SITE
          </ThemedText>
          <ThemedText type="bodyMedium">{job.customer_name}</ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            {job.customer_phone}
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary" style={styles.addressText}>
            {job.address}
          </ThemedText>

          {/* Native Launcher Actions */}
          <View style={styles.launcherRow}>
            <Button
              label="Call Customer"
              variant="secondary"
              size="sm"
              onPress={() => launchPhoneCall(job.customer_phone)}
              style={styles.launcherButton}
            />
            <Button
              label="Open in Maps"
              variant="secondary"
              size="sm"
              onPress={() =>
                launchNativeMaps(job.address, {
                  latitude: job.latitude,
                  longitude: job.longitude,
                })
              }
              style={styles.launcherButton}
            />
          </View>
        </Card>

        {/* Special Instructions / Notes */}
        <Card variant="surface" style={styles.card}>
          <ThemedText type="label" themeColor="textSecondary">
            SPECIAL INSTRUCTIONS & NOTES
          </ThemedText>
          {job.notes ? (
            <ThemedText type="body" style={styles.notesText}>
              {job.notes}
            </ThemedText>
          ) : (
            <ThemedText type="caption" themeColor="textSecondary" style={styles.emptyNotesText}>
              No special instructions provided for this job.
            </ThemedText>
          )}
        </Card>

        {/* Actions Area */}
        <View style={styles.actionsArea}>
          {isAssigned ? (
            <>
              <Button
                label="Accept Job"
                variant="primary"
                fullWidth
                loading={isExecutingAction}
                disabled={isExecutingAction || isDeclining}
                onPress={() => handleAdvanceStatus('accepted')}
              />
              <Button
                label="Decline Assignment"
                variant="danger"
                fullWidth
                loading={isDeclining}
                disabled={isExecutingAction || isDeclining}
                onPress={handleDecline}
              />
            </>
          ) : nextWorkerAction ? (
            <Button
              label={nextWorkerAction.label}
              variant="primary"
              fullWidth
              loading={isExecutingAction}
              disabled={isExecutingAction || isDeclining}
              onPress={() => handleAdvanceStatus(nextWorkerAction.targetStatus)}
            />
          ) : isCompleted ? (
            <ThemedText type="bodyMedium" style={styles.terminalNotice}>
              Service visit completed. Terminal state reached.
            </ThemedText>
          ) : isCancelled ? (
            <ThemedText type="bodyMedium" style={styles.terminalNotice}>
              This service job was cancelled by dispatch.
            </ThemedText>
          ) : null}
        </View>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: Spacing.base,
    gap: Spacing.base,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  bannerCard: {
    padding: Spacing.sm + 2,
    borderRadius: Radii.sm,
    borderWidth: 1,
    gap: 4,
  },
  card: {
    padding: Spacing.base,
    gap: Spacing.xs,
  },
  addressText: {
    lineHeight: 18,
    marginTop: 2,
  },
  launcherRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  launcherButton: {
    flex: 1,
  },
  notesText: {
    lineHeight: 20,
  },
  emptyNotesText: {
    fontStyle: 'italic',
  },
  actionsArea: {
    gap: Spacing.sm,
    marginTop: Spacing.xs,
    paddingBottom: Spacing.xl,
  },
  activeNotice: {
    textAlign: 'center',
    marginVertical: Spacing.sm,
    fontWeight: '500',
  },
  terminalNotice: {
    textAlign: 'center',
    marginVertical: Spacing.sm,
  },
});
