import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform, RefreshControl, Share, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, Loading, ScreenContainer, StatusBadge } from '@/components/ui';
import { JobEventTimeline } from '@/components/jobs/job-event-timeline';
import { WorkerSelectorSheet } from '@/components/jobs/worker-selector-sheet';
import { JobStatus, Palette, Radii, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import {
  AssignableWorker,
  assignJobWorker,
  cancelJob,
  fetchAssignableWorkers,
  fetchJobDetails,
  formatScheduledTime,
  JobWithWorker,
  subscribeToJobTransitions,
  unassignJobWorker,
} from '@/lib/jobs';
import { isTerminalJobStatus } from '@/lib/lifecycle';
import { subscribeToJobSignals } from '@/lib/realtime';
import {
  buildFullTrackingUrl,
  generateTrackingSession,
  IssuedTrackingSession,
  revokeTrackingSession,
} from '@/lib/tracking-session-service';

export default function OwnerJobDetailsScreen() {
  const theme = useTheme();
  const { businessId } = useAuth();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const [job, setJob] = useState<JobWithWorker | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(id));
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isCancelling, setIsCancelling] = useState<boolean>(false);
  const [isAssigning, setIsAssigning] = useState<boolean>(false);
  const [isUnassigning, setIsUnassigning] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous double-tap lock preventing concurrent action executions
  const actionLockRef = useRef<boolean>(false);
  // Concurrency request guard preventing out-of-order responses from race conditions
  const activeRequestRef = useRef<number>(0);

  // Worker Selection Sheet State
  const [isWorkerSheetVisible, setIsWorkerSheetVisible] = useState<boolean>(false);
  const [assignableWorkers, setAssignableWorkers] = useState<AssignableWorker[]>([]);
  const [isLoadingWorkers, setIsLoadingWorkers] = useState<boolean>(false);

  // Customer Tracking Session State
  const [trackingSession, setTrackingSession] = useState<IssuedTrackingSession | null>(null);
  const [isGeneratingTracking, setIsGeneratingTracking] = useState<boolean>(false);
  const [isRevokingTracking, setIsRevokingTracking] = useState<boolean>(false);

  const loadJob = useCallback(
    async (isPullRefresh: boolean = false) => {
      if (!id || !businessId) {
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
        const { job: loadedJob, error: loadErr } = await fetchJobDetails(id, businessId);
        if (activeRequestRef.current === requestId) {
          if (loadErr) {
            setError(loadErr);
          } else {
            setJob(loadedJob);
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
    [id, businessId]
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

  // Reconcile on screen focus (e.g. returning from worker picker or another tab)
  useFocusEffect(
    useCallback(() => {
      loadJob(false);
    }, [loadJob])
  );

  // Invalidate and reload job details if this job transitions locally or via remote Realtime signal
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

  // Load assignable workers for the selector sheet
  const loadAssignableWorkers = useCallback(async () => {
    if (!businessId) return;
    setIsLoadingWorkers(true);
    try {
      const scheduledDate = job?.scheduled_at ? new Date(job.scheduled_at) : new Date();
      const { workers: loadedWorkers, error: err } = await fetchAssignableWorkers(
        businessId,
        isNaN(scheduledDate.getTime()) ? new Date() : scheduledDate
      );
      if (!err) {
        setAssignableWorkers(loadedWorkers);
      }
    } finally {
      setIsLoadingWorkers(false);
    }
  }, [businessId, job?.scheduled_at]);

  const handleOpenAssignSheet = async () => {
    await loadAssignableWorkers();
    setIsWorkerSheetVisible(true);
  };

  const handleSelectWorker = async (worker: AssignableWorker | null) => {
    if (!job || actionLockRef.current) return;

    if (!worker) {
      // Selected "Keep Unassigned"
      if (job.status === 'assigned') {
        await handleUnassignWorker();
      }
      return;
    }

    actionLockRef.current = true;
    setIsAssigning(true);
    try {
      const result = await assignJobWorker(job.id, worker.id, job.status as JobStatus);
      if (result.success && result.job) {
        setJob({ ...job, ...result.job });
        Alert.alert('Worker Assigned', `${worker.full_name} has been assigned to this job.`);
        await loadJob(false);
      } else {
        Alert.alert(
          'Unable to Assign Worker',
          result.error || 'The job status has changed. Refreshing current state.'
        );
        await loadJob(false);
      }
    } catch (err) {
      Alert.alert(
        'Unable to Assign Worker',
        err instanceof Error ? err.message : 'An unexpected error occurred.'
      );
      await loadJob(false);
    } finally {
      actionLockRef.current = false;
      setIsAssigning(false);
    }
  };

  const handleUnassignWorker = async () => {
    if (!job || isUnassigning || isAssigning || actionLockRef.current) return;

    Alert.alert(
      'Unassign Field Technician?',
      `Are you sure you want to remove ${job.worker?.full_name || 'the technician'} from this job? The job will return to unassigned status.`,
      [
        { text: 'Keep Assignment', style: 'cancel' },
        {
          text: 'Unassign',
          style: 'destructive',
          onPress: async () => {
            if (actionLockRef.current) return;
            actionLockRef.current = true;
            setIsUnassigning(true);
            try {
              const result = await unassignJobWorker(job.id, job.status as JobStatus);
              if (result.success && result.job) {
                setJob({ ...job, ...result.job, worker: null });
                Alert.alert('Technician Unassigned', 'The job has been returned to the unassigned queue.');
                await loadJob(false);
              } else {
                Alert.alert(
                  'Unable to Unassign',
                  result.error || 'The job status has changed. Refreshing current state.'
                );
                await loadJob(false);
              }
            } catch (err) {
              Alert.alert(
                'Unable to Unassign',
                err instanceof Error ? err.message : 'An unexpected error occurred.'
              );
              await loadJob(false);
            } finally {
              actionLockRef.current = false;
              setIsUnassigning(false);
            }
          },
        },
      ]
    );
  };

  const handleCancelJob = () => {
    if (!job || isCancelling || isAssigning || isUnassigning || actionLockRef.current) return;

    if (isTerminalJobStatus(job.status as JobStatus)) {
      Alert.alert(
        'Cannot Cancel Job',
        `This job is already in a terminal status (${job.status}) and cannot be modified.`
      );
      return;
    }

    Alert.alert(
      'Cancel Service Job?',
      'Are you sure you want to cancel this job? This status transition is terminal and cannot be undone.',
      [
        { text: 'Keep Job', style: 'cancel' },
        {
          text: 'Cancel Job',
          style: 'destructive',
          onPress: async () => {
            if (actionLockRef.current) return;
            actionLockRef.current = true;
            setIsCancelling(true);
            try {
              const result = await cancelJob(
                job.id,
                'Cancelled by business owner',
                job.status as JobStatus
              );
              if (result.success && result.job) {
                setJob({ ...job, ...result.job });
                Alert.alert('Job Cancelled', 'The service visit has been marked as cancelled.');
                await loadJob(false);
              } else {
                Alert.alert(
                  'Unable to Cancel Job',
                  result.error || 'The job status has changed. Refreshing current state.'
                );
                await loadJob(false);
              }
            } catch (err) {
              Alert.alert(
                'Unable to Cancel Job',
                err instanceof Error ? err.message : 'An unexpected error occurred.'
              );
              await loadJob(false);
            } finally {
              actionLockRef.current = false;
              setIsCancelling(false);
            }
          },
        },
      ]
    );
  };

  // Clear local tracking session state if job enters terminal or unassigned status
  useEffect(() => {
    if (job && (job.status === 'completed' || job.status === 'cancelled' || job.status === 'unassigned' || !job.worker_id)) {
      setTrackingSession(null);
    }
  }, [job]);

  const handleCreateTrackingLink = async () => {
    if (!job || actionLockRef.current) return;
    actionLockRef.current = true;
    setIsGeneratingTracking(true);
    try {
      const res = await generateTrackingSession(job.id);
      if (res.success && res.session) {
        setTrackingSession(res.session);
        Alert.alert(
          'Tracking Link Created',
          'A secure customer tracking link has been issued. You can now copy or share it with your customer.'
        );
      } else {
        Alert.alert('Unable to Create Link', res.error || 'Failed to generate tracking session.');
      }
    } finally {
      actionLockRef.current = false;
      setIsGeneratingTracking(false);
    }
  };

  const handleCopyTrackingLink = async () => {
    if (!trackingSession) return;
    const fullUrl = buildFullTrackingUrl(trackingSession.rawToken || trackingSession.trackingUrl);
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(fullUrl);
      } else {
        await Clipboard.setStringAsync(fullUrl);
      }
      Alert.alert('Link Copied', 'Customer tracking link copied to clipboard.');
    } catch {
      Alert.alert('Copy Failed', 'Unable to copy tracking link to clipboard.');
    }
  };

  const handleRotateTrackingLink = () => {
    if (!job || actionLockRef.current) return;
    Alert.alert(
      'Create Replacement Link?',
      'Generating a replacement link will permanently invalidate the earlier link. Any customer using the previous link will immediately lose tracking access.\n\nDo you want to continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Replace & Invalidate Earlier Link',
          style: 'destructive',
          onPress: async () => {
            if (actionLockRef.current) return;
            actionLockRef.current = true;
            setIsGeneratingTracking(true);
            try {
              const res = await generateTrackingSession(job.id);
              if (res.success && res.session) {
                setTrackingSession(res.session);
                Alert.alert(
                  'Replacement Link Issued',
                  'A new tracking link has been issued. The previous link has been permanently revoked.'
                );
              } else {
                Alert.alert('Unable to Replace Link', res.error || 'Failed to rotate tracking session.');
              }
            } finally {
              actionLockRef.current = false;
              setIsGeneratingTracking(false);
            }
          },
        },
      ]
    );
  };

  const handleRevokeTrackingLink = () => {
    if (!job || actionLockRef.current) return;
    Alert.alert(
      'Revoke Tracking Link?',
      'This will immediately terminate customer tracking access for this visit. The customer tracking page will stop displaying live information.\n\nAre you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke Link',
          style: 'destructive',
          onPress: async () => {
            if (actionLockRef.current) return;
            actionLockRef.current = true;
            setIsRevokingTracking(true);
            try {
              const res = await revokeTrackingSession(job.id, 'owner_manual_revocation');
              if (res.success) {
                setTrackingSession(null);
                Alert.alert('Link Revoked', 'The customer tracking link has been deactivated.');
              } else {
                Alert.alert('Unable to Revoke Link', res.error || 'Failed to revoke tracking session.');
              }
            } finally {
              actionLockRef.current = false;
              setIsRevokingTracking(false);
            }
          },
        },
      ]
    );
  };

  const handleShareTrackingLink = async () => {
    if (!trackingSession || !job) return;
    const fullUrl = buildFullTrackingUrl(trackingSession.rawToken || trackingSession.trackingUrl);
    const message = `Track your ${job.service} appointment live: ${fullUrl}`;
    try {
      await Share.share({
        title: `Live Tracking for ${job.service}`,
        message,
        url: fullUrl,
      });
    } catch {
      // User dismissed share sheet or share cancelled
    }
  };

  if (isLoading && !isRefreshing) {
    return <Loading fullScreen label="Loading service job..." />;
  }

  // If a real job was loaded dynamically
  if (job) {
    const isUnassigned = job.status === 'unassigned';
    const isAssigned = job.status === 'assigned';
    const isFieldExecution =
      job.status === 'accepted' ||
      job.status === 'on_the_way' ||
      job.status === 'arrived' ||
      job.status === 'in_progress';
    const isCompleted = job.status === 'completed';
    const isCancelled = job.status === 'cancelled';
    const isTerminal = isCompleted || isCancelled;

    const workerName = job.worker?.full_name?.trim();
    const shortJobId = `JOB-${job.id.slice(0, 6).toUpperCase()}`;

    // Look for previous decline event for decline review (newest first from reverse)
    const latestDeclineEvent = isUnassigned
      ? [...(job.events || [])].reverse().find(
          (e) =>
            e.event_type === 'declined' ||
            (e.previous_status === 'assigned' && e.new_status === 'unassigned' && e.actor_role === 'worker')
        )
      : null;

    const isActionInProgress = isCancelling || isAssigning || isUnassigning;

    return (
      <ScreenContainer
        scrollable
        withPadding
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => loadJob(true)} />}>
        <View style={styles.container}>
          {/* Status Header */}
          <View style={styles.statusRow}>
            <StatusBadge status={job.status as JobStatus} size="md" />
            <ThemedText type="caption" themeColor="textSecondary">
              Job #{shortJobId}
            </ThemedText>
          </View>

          {/* Decline Review Banner (if technician previously declined) */}
          {latestDeclineEvent ? (
            <View style={[styles.bannerCard, { backgroundColor: Palette.amberBg, borderColor: Palette.amberBorder }]}>
              <ThemedText type="bodyMedium" style={{ color: Palette.amberText, fontWeight: '600' }}>
                Technician Declined Assignment
              </ThemedText>
              <ThemedText type="caption" style={{ color: Palette.amberText }}>
                {typeof latestDeclineEvent.metadata?.reason === 'string'
                  ? `Technician noted: "${latestDeclineEvent.metadata.reason}". Review schedule and reassign another technician.`
                  : 'The previous technician declined this assignment. Please review and assign another technician.'}
              </ThemedText>
            </View>
          ) : null}

          {/* Service Details Card */}
          <Card variant="surface" style={styles.card}>
            <ThemedText type="headline">Service Details</ThemedText>
            <ThemedText type="body">{job.service}</ThemedText>
            <ThemedText type="caption" themeColor="textSecondary">
              Address: {job.address}
            </ThemedText>
            <ThemedText type="caption" themeColor="textSecondary">
              Customer: {job.customer_name} • {job.customer_phone}
            </ThemedText>
            <ThemedText type="caption" themeColor="textSecondary">
              Scheduled: {formatScheduledTime(job.scheduled_at)}
            </ThemedText>
          </Card>

          {/* Worker Assignment Card */}
          <Card variant="surface" style={styles.card}>
            <ThemedText type="headline">Worker Assignment</ThemedText>

            {isUnassigned ? (
              <>
                <ThemedText type="body" themeColor="textSecondary">
                  No technician currently assigned to this job.
                </ThemedText>
                <Button
                  label="Assign Worker"
                  variant="primary"
                  loading={isAssigning}
                  disabled={isActionInProgress}
                  onPress={handleOpenAssignSheet}
                  style={styles.actionButton}
                />
              </>
            ) : isAssigned ? (
              <>
                <View style={styles.workerDetails}>
                  <ThemedText type="bodyMedium">{workerName || 'Assigned Technician'}</ThemedText>
                  {job.worker?.phone ? (
                    <ThemedText type="caption" themeColor="textSecondary">
                      Phone: {job.worker.phone}
                    </ThemedText>
                  ) : null}
                </View>

                <View style={[styles.bannerCard, { backgroundColor: Palette.amberBg, borderColor: Palette.amberBorder }]}>
                  <ThemedText type="captionMedium" style={{ color: Palette.amberText }}>
                    Awaiting technician acceptance. You may reassign or unassign before they accept.
                  </ThemedText>
                </View>

                <View style={styles.buttonRow}>
                  <Button
                    label="Reassign"
                    variant="outline"
                    loading={isAssigning}
                    disabled={isActionInProgress}
                    onPress={handleOpenAssignSheet}
                    style={styles.flexButton}
                  />
                  <Button
                    label="Unassign"
                    variant="danger"
                    loading={isUnassigning}
                    disabled={isActionInProgress}
                    onPress={handleUnassignWorker}
                    style={styles.flexButton}
                  />
                </View>
              </>
            ) : isFieldExecution ? (
              <>
                <View style={styles.workerDetails}>
                  <ThemedText type="bodyMedium">{workerName || 'Assigned Technician'}</ThemedText>
                  {job.worker?.phone ? (
                    <ThemedText type="caption" themeColor="textSecondary">
                      Phone: {job.worker.phone}
                    </ThemedText>
                  ) : null}
                </View>

                <View style={[styles.bannerCard, { backgroundColor: Palette.blueBg, borderColor: Palette.blueBorder }]}>
                  <ThemedText type="captionMedium" style={{ color: Palette.blueText }}>
                    Technician is active in the field ({job.status.replace(/_/g, ' ')}). Worker assignment is locked during field execution.
                  </ThemedText>
                </View>
              </>
            ) : isCompleted ? (
              <>
                <View style={styles.workerDetails}>
                  <ThemedText type="bodyMedium">{workerName || 'Assigned Technician'}</ThemedText>
                </View>
                <View style={[styles.bannerCard, { backgroundColor: Palette.greenBg, borderColor: Palette.greenBorder }]}>
                  <ThemedText type="captionMedium" style={{ color: Palette.greenText }}>
                    Service visit completed successfully by technician. Terminal status reached.
                  </ThemedText>
                </View>
              </>
            ) : isCancelled ? (
              <View style={[styles.bannerCard, { backgroundColor: theme.dangerBackground, borderColor: theme.dangerBorder }]}>
                <ThemedText type="captionMedium" style={{ color: theme.danger }}>
                  This service visit was cancelled.{job.cancellation_reason ? ` Reason: ${job.cancellation_reason}` : ''}
                </ThemedText>
              </View>
            ) : null}
          </Card>

          {/* Internal Notes Card */}
          {job.notes ? (
            <Card variant="surface" style={styles.card}>
              <ThemedText type="headline">Internal Notes</ThemedText>
              <ThemedText type="body" themeColor="textSecondary">
                {job.notes}
              </ThemedText>
            </Card>
          ) : null}

          {/* Customer Tracking Section */}
          <Card variant="surface" style={styles.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.xs }}>
              <ThemedText type="headline">Customer Tracking</ThemedText>
              {trackingSession ? (
                <View
                  style={{
                    backgroundColor: trackingSession.isActivated ? Palette.greenBg : Palette.blueBg,
                    borderColor: trackingSession.isActivated ? Palette.greenBorder : Palette.blueBorder,
                    borderWidth: 1,
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    borderRadius: Radii.pill,
                  }}>
                  <ThemedText
                    type="caption"
                    style={{
                      color: trackingSession.isActivated ? Palette.greenText : Palette.blueText,
                      fontWeight: '600',
                    }}>
                    {trackingSession.isActivated ? 'LIVE TRACKING ACTIVE' : 'PENDING TECHNICIAN TRAVEL'}
                  </ThemedText>
                </View>
              ) : null}
            </View>

            {isTerminal ? (
              <ThemedText type="caption" themeColor="textSecondary">
                Customer tracking is closed for completed and cancelled jobs.
              </ThemedText>
            ) : isUnassigned ? (
              <ThemedText type="caption" themeColor="textSecondary">
                Assign an active technician above to enable customer tracking link generation.
              </ThemedText>
            ) : trackingSession ? (
              <View style={{ gap: Spacing.sm }}>
                <View
                  style={{
                    backgroundColor: theme.surfaceSecondary,
                    padding: Spacing.sm,
                    borderRadius: Radii.sm,
                    borderWidth: 1,
                    borderColor: theme.border,
                  }}>
                  <ThemedText type="captionMedium" themeColor="textSecondary">
                    CUSTOMER TRACKING LINK
                  </ThemedText>
                  <ThemedText
                    type="caption"
                    style={{ fontFamily: 'monospace', marginTop: 2 }}>
                    {buildFullTrackingUrl(trackingSession.rawToken || trackingSession.trackingUrl)}
                  </ThemedText>
                  <ThemedText type="caption" themeColor="textSecondary" style={{ marginTop: 4, fontSize: 11 }}>
                    Expires: {new Date(trackingSession.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ({new Date(trackingSession.expiresAt).toLocaleDateString()})
                  </ThemedText>
                </View>

                <ThemedText type="caption" themeColor="textSecondary" style={{ fontSize: 12, lineHeight: 16 }}>
                  Anyone with this link can view the technician's arrival status and real-time location. Internal notes and customer contact details are never revealed.
                </ThemedText>

                <ThemedText type="caption" themeColor="textSecondary" style={{ fontSize: 11, fontStyle: 'italic' }}>
                  Notice: Generating a replacement link immediately invalidates the earlier link.
                </ThemedText>

                <View style={{ flexDirection: 'row', gap: Spacing.xs }}>
                  <View style={{ flex: 1 }}>
                    <Button
                      label="Copy Link"
                      variant="primary"
                      size="sm"
                      fullWidth
                      onPress={handleCopyTrackingLink}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      label="Share Link"
                      variant="secondary"
                      size="sm"
                      fullWidth
                      onPress={handleShareTrackingLink}
                    />
                  </View>
                </View>

                <Button
                  label="Create Replacement Link"
                  variant="outline"
                  size="sm"
                  fullWidth
                  loading={isGeneratingTracking}
                  disabled={isActionInProgress || isRevokingTracking}
                  onPress={handleRotateTrackingLink}
                />

                <Button
                  label="Revoke Link"
                  variant="outline"
                  size="sm"
                  fullWidth
                  loading={isRevokingTracking}
                  disabled={isActionInProgress || isGeneratingTracking}
                  onPress={handleRevokeTrackingLink}
                />
              </View>
            ) : (
              <View style={{ gap: Spacing.xs }}>
                <ThemedText type="caption" themeColor="textSecondary">
                  Create a secure, non-guessable link for your customer to track technician arrival in real time.
                </ThemedText>
                <Button
                  label="Create Tracking Link"
                  variant="primary"
                  size="sm"
                  loading={isGeneratingTracking}
                  disabled={isActionInProgress}
                  onPress={handleCreateTrackingLink}
                />
              </View>
            )}
          </Card>

          {/* Activity Event Timeline */}
          <JobEventTimeline
            events={job.events}
            isLoading={isLoading && !isRefreshing}
            error={job.eventsError}
            onRetry={() => loadJob(false)}
          />

          {/* Cancellation Action (Non-terminal jobs only) */}
          {!isTerminal ? (
            <Button
              label="Cancel Job"
              variant="danger"
              fullWidth
              loading={isCancelling}
              disabled={isActionInProgress}
              onPress={handleCancelJob}
            />
          ) : (
            <ThemedText
              type="caption"
              themeColor="textSecondary"
              style={{ textAlign: 'center', marginVertical: Spacing.xs }}>
              This job is in terminal status: {job.status}. It cannot be modified.
            </ThemedText>
          )}

          {/* Worker Selector Sheet Modal */}
          <WorkerSelectorSheet
            visible={isWorkerSheetVisible}
            onClose={() => setIsWorkerSheetVisible(false)}
            onSelectWorker={handleSelectWorker}
            selectedWorkerId={job.worker_id}
            workers={assignableWorkers}
            isLoading={isLoadingWorkers}
            onRefresh={loadAssignableWorkers}
          />
        </View>
      </ScreenContainer>
    );
  }

  // Fallback to placeholder view if no ID provided or error
  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        {error ? (
          <Card
            variant="outline"
            style={[
              styles.card,
              { borderColor: theme.dangerBorder, backgroundColor: theme.dangerBackground },
            ]}>
            <ThemedText type="captionMedium" style={{ color: theme.danger }}>
              {error}
            </ThemedText>
            <Button
              label="Retry"
              variant="outline"
              size="sm"
              onPress={() => loadJob(false)}
              style={{ marginTop: Spacing.xs, alignSelf: 'flex-start' }}
            />
          </Card>
        ) : null}

        {/* Status Header */}
        <View style={styles.statusRow}>
          <StatusBadge status="unassigned" size="md" />
          <ThemedText type="caption" themeColor="textSecondary">
            Job #JOB-1001
          </ThemedText>
        </View>

        {/* Job Information Card */}
        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Service Details</ThemedText>
          <ThemedText type="body">Emergency pipe leak inspection</ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Address: 123 Service Road, Suite 4
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Customer: Customer Contact Name • (555) 012-3456
          </ThemedText>
        </Card>

        {/* Worker Assignment Card */}
        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Worker Assignment</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            No technician currently assigned to this job.
          </ThemedText>
          <Button
            label="Assign Worker"
            variant="primary"
            disabled
            style={styles.actionButton}
          />
        </Card>
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
  card: {
    padding: Spacing.base,
    gap: Spacing.xs,
  },
  actionButton: {
    marginTop: Spacing.sm,
  },
  workerDetails: {
    gap: Spacing.xxs,
  },
  bannerCard: {
    padding: Spacing.sm,
    borderRadius: Radii.sm,
    borderWidth: 1,
    marginTop: Spacing.xs,
    gap: 4,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  flexButton: {
    flex: 1,
  },
});
