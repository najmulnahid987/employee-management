import { router, useFocusEffect } from 'expo-router';
import React, { useCallback } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { WorkerJobCard } from '@/components/jobs/worker-job-card';
import { InAppNotificationsSheet } from '@/components/in-app-notifications-sheet';
import { NotificationPermissionPrompt } from '@/components/notification-permission-prompt';
import { RealtimeStatusBanner } from '@/components/realtime-status-banner';
import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, Loading, ScreenContainer, StatusBadge } from '@/components/ui';
import { JobStatus, Palette, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useWorkerToday } from '@/hooks/use-worker-today';
import { formatScheduledTime, Job } from '@/lib/jobs';
import { getNextWorkerAction } from '@/lib/lifecycle';

export default function WorkerTodayScreen() {
  const theme = useTheme();
  const [isNotificationsVisible, setIsNotificationsVisible] = React.useState<boolean>(false);
  const {
    heroJob,
    queue,
    todayCompletedCount,
    isLoading,
    isRefreshing,
    error,
    refetch,
    onRefresh,
  } = useWorkerToday();

  // Invalidate and reload operations automatically whenever the screen gains focus
  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  const handleOpenDetails = (job: Job) => {
    router.push({
      pathname: '/worker/job-details',
      params: { id: job.id },
    });
  };

  if (isLoading && !isRefreshing) {
    return <Loading fullScreen label="Loading your schedule..." />;
  }

  // Determine hero card badge label & styling
  const isActionRequired = heroJob?.status === 'assigned';
  const isActiveVisit =
    heroJob?.status === 'on_the_way' ||
    heroJob?.status === 'arrived' ||
    heroJob?.status === 'in_progress';

  const heroBadgeLabel = isActionRequired
    ? 'ACTION REQUIRED'
    : isActiveVisit
    ? 'ACTIVE VISIT'
    : 'NEXT SCHEDULED VISIT';

  const heroBadgeBg = isActionRequired
    ? Palette.amberBg
    : isActiveVisit
    ? Palette.blueBg
    : theme.surfaceSecondary;

  const heroBadgeText = isActionRequired
    ? Palette.amberText
    : isActiveVisit
    ? Palette.blueText
    : theme.textSecondary;

  return (
    <ScreenContainer
      scrollable
      withPadding
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />}>
      <View style={styles.container}>
        <RealtimeStatusBanner />
        <NotificationPermissionPrompt />

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerTextGroup}>
            <ThemedText type="headline">Today's Schedule</ThemedText>
            <ThemedText type="body" themeColor="textSecondary">
              Your active service assignments and execution queue.
            </ThemedText>
          </View>

          <Pressable
            onPress={() => setIsNotificationsVisible(true)}
            style={styles.bellButton}
            accessibilityLabel="Open notifications"
            accessibilityRole="button">
            <ThemedText style={styles.bellIcon}>🔔</ThemedText>
          </Pressable>
        </View>

        {/* Error Notification */}
        {error ? (
          <Card
            variant="outline"
            style={[
              styles.errorCard,
              { borderColor: theme.dangerBorder, backgroundColor: theme.dangerBackground },
            ]}>
            <ThemedText type="bodyMedium" style={{ color: theme.danger }}>
              Failed to load schedule
            </ThemedText>
            <ThemedText type="caption" themeColor="textSecondary">
              {error}
            </ThemedText>
            <Button
              label="Retry"
              variant="outline"
              size="sm"
              onPress={refetch}
              style={styles.retryButton}
            />
          </Card>
        ) : null}

        {/* Hero Card: Most Relevant Active or Next Job */}
        {heroJob ? (
          <View style={styles.heroSection}>
            <View style={styles.sectionHeaderRow}>
              <View style={[styles.heroStatusTag, { backgroundColor: heroBadgeBg }]}>
                <ThemedText type="label" style={{ color: heroBadgeText }}>
                  {heroBadgeLabel}
                </ThemedText>
              </View>
              <ThemedText type="caption" themeColor="textSecondary">
                Job #{heroJob.id.slice(0, 6).toUpperCase()}
              </ThemedText>
            </View>

            <Card
              variant="surface"
              style={[
                styles.heroCard,
                isActionRequired && { borderColor: Palette.amberBorder, borderWidth: 1.5 },
                isActiveVisit && { borderColor: Palette.blueBorder, borderWidth: 1.5 },
              ]}>
              <View style={styles.heroCardHeader}>
                <ThemedText type="title" style={styles.heroTitle} numberOfLines={2}>
                  {heroJob.service}
                </ThemedText>
                <StatusBadge status={heroJob.status as JobStatus} size="sm" />
              </View>

              <View style={styles.heroMetaRow}>
                <ThemedText type="bodyMedium" numberOfLines={1} style={styles.heroCustomer}>
                  {heroJob.customer_name}
                </ThemedText>
                <ThemedText type="captionMedium" themeColor="textSecondary">
                  {formatScheduledTime(heroJob.scheduled_at)}
                </ThemedText>
              </View>

              <View style={styles.heroAddressRow}>
                <ThemedText
                  type="caption"
                  themeColor="textSecondary"
                  numberOfLines={2}
                  style={styles.heroAddress}>
                  {heroJob.address}
                </ThemedText>
              </View>

              {heroJob.notes ? (
                <View style={[styles.heroNotesContainer, { backgroundColor: theme.surfaceSecondary }]}>
                  <ThemedText type="label" themeColor="textSecondary">
                    NOTES
                  </ThemedText>
                  <ThemedText type="caption" numberOfLines={2} style={styles.heroNotesText}>
                    {heroJob.notes}
                  </ThemedText>
                </View>
              ) : null}

              {/* Primary Call to Action */}
              <Button
                label={
                  isActionRequired
                    ? 'Review & Accept Assignment'
                    : heroJob
                    ? (() => {
                        const action = getNextWorkerAction(heroJob.status as JobStatus);
                        return action ? `${action.label} (Details)` : 'View Job Details';
                      })()
                    : 'View Job Details'
                }
                variant="primary"
                fullWidth
                onPress={() => handleOpenDetails(heroJob)}
                style={styles.heroActionBtn}
              />
            </Card>
          </View>
        ) : !error ? (
          <EmptyState
            title="You're All Caught Up"
            description="No service jobs are currently scheduled for you today. New dispatches from your business owner will appear here automatically."
          />
        ) : null}

        {/* Remaining Today Queue */}
        {queue.length > 0 ? (
          <View style={styles.queueSection}>
            <ThemedText type="label" themeColor="textSecondary" style={styles.queueHeader}>
              UPCOMING TODAY ({queue.length})
            </ThemedText>
            <View style={styles.queueList}>
              {queue.map((job) => (
                <WorkerJobCard
                  key={job.id}
                  job={job}
                  onPress={() => handleOpenDetails(job)}
                />
              ))}
            </View>
          </View>
        ) : null}

        {/* Daily Completed Summary Notice */}
        {todayCompletedCount > 0 ? (
          <Card variant="subtle" style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <View style={[styles.summaryDot, { backgroundColor: Palette.greenText }]} />
              <ThemedText type="captionMedium" themeColor="textSecondary">
                {todayCompletedCount} service visit{todayCompletedCount > 1 ? 's' : ''} completed today
              </ThemedText>
            </View>
          </Card>
        ) : null}

        <InAppNotificationsSheet
          visible={isNotificationsVisible}
          onClose={() => setIsNotificationsVisible(false)}
          onSelectJob={(jobId) => {
            router.push({
              pathname: '/worker/job-details',
              params: { id: jobId },
            });
          }}
        />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: Spacing.base,
    gap: Spacing.base,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  headerTextGroup: {
    flex: 1,
    gap: Spacing.xxs,
  },
  bellButton: {
    paddingHorizontal: Spacing.sm + 2,
    paddingVertical: Spacing.xs + 2,
    borderRadius: Radii.sm,
    borderWidth: 1,
    borderColor: Palette.neutral300,
    backgroundColor: Palette.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellIcon: {
    fontSize: 16,
  },
  errorCard: {
    padding: Spacing.base,
    gap: Spacing.xs,
  },
  retryButton: {
    alignSelf: 'flex-start',
    marginTop: Spacing.xs,
  },
  heroSection: {
    gap: Spacing.xs,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  heroStatusTag: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radii.pill,
  },
  heroCard: {
    padding: Spacing.base,
    gap: Spacing.sm,
  },
  heroCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: Spacing.sm,
  },
  heroTitle: {
    flex: 1,
  },
  heroMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: Spacing.sm,
  },
  heroCustomer: {
    flex: 1,
  },
  heroAddressRow: {
    marginTop: -2,
  },
  heroAddress: {
    lineHeight: 18,
  },
  heroNotesContainer: {
    padding: Spacing.sm,
    borderRadius: Radii.sm,
    gap: 2,
    marginTop: 2,
  },
  heroNotesText: {
    lineHeight: 16,
  },
  heroActionBtn: {
    marginTop: Spacing.xs,
  },
  queueSection: {
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  queueHeader: {
    letterSpacing: 0.5,
  },
  queueList: {
    gap: Spacing.sm,
  },
  summaryCard: {
    padding: Spacing.sm + 2,
    marginTop: Spacing.xs,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    justifyContent: 'center',
  },
  summaryDot: {
    width: 8,
    height: 8,
    borderRadius: Radii.full,
  },
});
