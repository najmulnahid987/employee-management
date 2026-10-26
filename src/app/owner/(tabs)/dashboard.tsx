import { router, useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import React, { useCallback } from 'react';
import {
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';

import { JobCard } from '@/components/jobs/job-card';
import { RealtimeStatusBanner } from '@/components/realtime-status-banner';
import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, Loading, ScreenContainer } from '@/components/ui';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useOwnerDashboard } from '@/hooks/use-owner-dashboard';
import { useTheme } from '@/hooks/use-theme';
import { formatHeaderDate, JobWithWorker } from '@/lib/jobs';

export default function OwnerDashboardScreen() {
  const theme = useTheme();
  const {
    jobs,
    sections,
    summary,
    isLoading,
    isRefreshing,
    error,
    selectedDay,
    businessName,
    refetch,
    onRefresh,
  } = useOwnerDashboard();

  // Invalidate and reload operations automatically whenever the screen gains focus
  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  const handleJobPress = (job: JobWithWorker) => {
    router.push({
      pathname: '/owner/job-details',
      params: { id: job.id },
    });
  };

  const activeSitesCount = jobs.filter(
    (j) => j.status === 'on_the_way' || j.status === 'arrived' || j.status === 'in_progress'
  ).length;

  return (
    <ScreenContainer
      scrollable
      withPadding
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={onRefresh}
          tintColor={theme.primary}
          colors={[theme.primary]}
        />
      }>
      <View style={styles.container}>
        <RealtimeStatusBanner />

        {/* Header Section */}
        <View style={styles.header}>
          <View style={styles.headerTextGroup}>
            {businessName ? (
              <ThemedText type="label" themeColor="textSecondary" style={styles.businessContext}>
                {businessName.toUpperCase()}
              </ThemedText>
            ) : null}
            <ThemedText type="title">Operations Dashboard</ThemedText>
            <ThemedText type="body" themeColor="textSecondary">
              {formatHeaderDate(selectedDay)}
            </ThemedText>
          </View>

          <Button
            label="+ Create Job"
            variant="primary"
            size="md"
            onPress={() => router.push('/owner/create-job')}
            style={styles.createButton}
          />
        </View>

        {/* Error State */}
        {error ? (
          <Card variant="outline" style={[styles.errorCard, { borderColor: theme.dangerBorder, backgroundColor: theme.dangerBackground }]}>
            <ThemedText type="headline" style={{ color: theme.danger }}>
              Failed to load operations
            </ThemedText>
            <ThemedText type="caption" style={{ color: theme.danger }}>
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

        {/* Initial Loading State */}
        {isLoading && !isRefreshing ? (
          <Loading label="Loading operations for today..." style={styles.loadingContainer} />
        ) : summary.total === 0 && !error ? (
          /* Zero-Data Empty State */
          <EmptyState
            title="No Operations Scheduled for Today"
            description="You do not have any jobs scheduled or active today. Create a service job to dispatch your field technicians."
            actionLabel="+ Create Job"
            onAction={() => router.push('/owner/create-job')}
          />
        ) : (
          /* Populated Dashboard Content */
          <>
            {/* Today's Summary Metrics Row */}
            <View style={styles.summaryRow}>
              <Card variant="subtle" style={styles.summaryCard}>
                <ThemedText type="title" style={styles.metricValue}>
                  {summary.upcoming}
                </ThemedText>
                <ThemedText type="label" themeColor="textSecondary">
                  UPCOMING
                </ThemedText>
              </Card>

              <Card variant="subtle" style={styles.summaryCard}>
                <ThemedText type="title" style={[styles.metricValue, { color: Palette.orangeText }]}>
                  {summary.active}
                </ThemedText>
                <ThemedText type="label" themeColor="textSecondary">
                  ACTIVE
                </ThemedText>
              </Card>

              <Card variant="subtle" style={styles.summaryCard}>
                <ThemedText type="title" style={[styles.metricValue, { color: Palette.greenText }]}>
                  {summary.completed}
                </ThemedText>
                <ThemedText type="label" themeColor="textSecondary">
                  COMPLETED
                </ThemedText>
              </Card>
            </View>

            {/* Unassigned Warning Strip */}
            {summary.unassigned > 0 ? (
              <View style={[styles.warningStrip, { backgroundColor: Palette.amberBg, borderColor: Palette.amberBorder }]}>
                <View style={[styles.warningDot, { backgroundColor: Palette.amberDot }]} />
                <ThemedText type="captionMedium" style={{ color: Palette.amberText }}>
                  {summary.unassigned} {summary.unassigned === 1 ? 'job requires' : 'jobs require'} worker assignment
                </ThemedText>
              </View>
            ) : null}

            {/* Compact Territory Map Preview Card */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open territory live map"
              onPress={() => router.push('/owner/(tabs)/map')}
              style={({ pressed }) => [styles.mapPreviewWrapper, pressed && styles.pressed]}>
              <Card variant="surface" style={styles.mapCard}>
                <View style={styles.mapCardLeft}>
                  <View style={[styles.mapIconCircle, { backgroundColor: theme.surfaceSecondary }]}>
                    <SymbolView
                      name={{ ios: 'map', android: 'map', web: 'map' }}
                      tintColor={theme.primary}
                      size={20}
                    />
                  </View>
                  <View style={styles.mapCardText}>
                    <ThemedText type="headline">Territory Live Map</ThemedText>
                    <ThemedText type="caption" themeColor="textSecondary">
                      {activeSitesCount > 0
                        ? `${activeSitesCount} active job ${activeSitesCount === 1 ? 'site' : 'sites'} in the field`
                        : 'View all scheduled service locations'}
                    </ThemedText>
                  </View>
                </View>
                <Button
                  label="View Map"
                  variant="outline"
                  size="sm"
                  onPress={() => router.push('/owner/(tabs)/map')}
                />
              </Card>
            </Pressable>

            {/* SECTION 1: Active Operations */}
            <View style={styles.sectionContainer}>
              <View style={styles.sectionHeader}>
                <ThemedText type="subtitle">Active Operations</ThemedText>
                <View style={[styles.countBadge, { backgroundColor: theme.surfaceSecondary }]}>
                  <ThemedText type="label">{sections.active.length}</ThemedText>
                </View>
              </View>

              {sections.active.length > 0 ? (
                <View style={styles.cardList}>
                  {sections.active.map((job) => (
                    <JobCard key={job.id} job={job} onPress={handleJobPress} />
                  ))}
                </View>
              ) : (
                <Card variant="outline" style={styles.sectionEmptyCard}>
                  <ThemedText type="caption" themeColor="textSecondary" style={styles.sectionEmptyText}>
                    No field technicians actively on-site or in transit right now.
                  </ThemedText>
                </Card>
              )}
            </View>

            {/* SECTION 2: Upcoming Jobs */}
            <View style={styles.sectionContainer}>
              <View style={styles.sectionHeader}>
                <ThemedText type="subtitle">Upcoming Jobs</ThemedText>
                <View style={[styles.countBadge, { backgroundColor: theme.surfaceSecondary }]}>
                  <ThemedText type="label">{sections.upcoming.length}</ThemedText>
                </View>
              </View>

              {sections.upcoming.length > 0 ? (
                <View style={styles.cardList}>
                  {sections.upcoming.map((job) => (
                    <JobCard key={job.id} job={job} onPress={handleJobPress} />
                  ))}
                </View>
              ) : (
                <Card variant="outline" style={styles.sectionEmptyCard}>
                  <ThemedText type="caption" themeColor="textSecondary" style={styles.sectionEmptyText}>
                    No upcoming service visits awaiting assignment or travel.
                  </ThemedText>
                </Card>
              )}
            </View>

            {/* SECTION 3: Completed Today */}
            <View style={styles.sectionContainer}>
              <View style={styles.sectionHeader}>
                <ThemedText type="subtitle">Completed Today</ThemedText>
                <View style={[styles.countBadge, { backgroundColor: theme.surfaceSecondary }]}>
                  <ThemedText type="label">{sections.completed.length}</ThemedText>
                </View>
              </View>

              {sections.completed.length > 0 ? (
                <View style={styles.cardList}>
                  {sections.completed.map((job) => (
                    <JobCard key={job.id} job={job} onPress={handleJobPress} />
                  ))}
                </View>
              ) : (
                <Card variant="outline" style={styles.sectionEmptyCard}>
                  <ThemedText type="caption" themeColor="textSecondary" style={styles.sectionEmptyText}>
                    No service visits completed yet today.
                  </ThemedText>
                </Card>
              )}
            </View>
          </>
        )}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: Spacing.base,
    gap: Spacing.lg,
  },
  header: {
    gap: Spacing.md,
  },
  headerTextGroup: {
    gap: Spacing.xxs,
  },
  businessContext: {
    letterSpacing: 0.5,
  },
  createButton: {
    marginTop: Spacing.xs,
  },
  errorCard: {
    padding: Spacing.base,
    gap: Spacing.xs,
    borderWidth: 1,
  },
  retryButton: {
    alignSelf: 'flex-start',
    marginTop: Spacing.xs,
  },
  loadingContainer: {
    paddingVertical: Spacing.huge,
  },
  summaryRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  summaryCard: {
    flex: 1,
    padding: Spacing.sm + 2,
    alignItems: 'center',
    gap: Spacing.xxs,
  },
  metricValue: {
    fontSize: 24,
    lineHeight: 28,
  },
  warningStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    borderRadius: Radii.md,
    borderWidth: 1,
  },
  warningDot: {
    width: 8,
    height: 8,
    borderRadius: Radii.full,
  },
  mapPreviewWrapper: {
    width: '100%',
  },
  mapCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: Spacing.base,
    gap: Spacing.sm,
  },
  mapCardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.base,
    flex: 1,
  },
  mapIconCircle: {
    width: 40,
    height: 40,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapCardText: {
    flex: 1,
    gap: 2,
  },
  sectionContainer: {
    gap: Spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  countBadge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radii.pill,
  },
  cardList: {
    gap: Spacing.sm,
  },
  sectionEmptyCard: {
    padding: Spacing.base,
    alignItems: 'center',
  },
  sectionEmptyText: {
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.88,
  },
});
