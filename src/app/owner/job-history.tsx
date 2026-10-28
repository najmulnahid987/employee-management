import { router, useFocusEffect } from 'expo-router';
import React, { useCallback } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { RealtimeStatusBanner } from '@/components/realtime-status-banner';
import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, Loading, ScreenContainer, StatusBadge } from '@/components/ui';
import { JobStatus, Palette, Radii, Spacing } from '@/constants/theme';
import { useJobHistory } from '@/hooks/use-job-history';
import { useTheme } from '@/hooks/use-theme';
import { JobHistoryDatePreset, JobHistoryStatusFilter, JobWithWorker } from '@/lib/jobs';

const STATUS_OPTIONS: { key: JobHistoryStatusFilter; label: string }[] = [
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All Statuses' },
];

const DATE_OPTIONS: { key: JobHistoryDatePreset; label: string }[] = [
  { key: 'all', label: 'All Time' },
  { key: 'today', label: 'Today' },
  { key: 'past_7_days', label: 'Past 7 Days' },
  { key: 'past_30_days', label: 'Past 30 Days' },
  { key: 'this_month', label: 'This Month' },
];

/**
 * Formats the actual completion timestamp into a localized, user-friendly string.
 */
function formatCompletionTimestamp(completedAt: string | null): string {
  if (!completedAt) return 'Time not recorded';
  try {
    const d = new Date(completedAt);
    if (isNaN(d.getTime())) return 'Completed';
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return 'Completed';
  }
}

/**
 * Dedicated Card component for historical job records showing
 * customer, service, worker, and completion timestamp.
 */
function HistoryJobCard({
  job,
  onPress,
}: {
  job: JobWithWorker;
  onPress: (job: JobWithWorker) => void;
}) {
  const theme = useTheme();
  const workerName = job.worker?.full_name?.trim();
  const isCompleted = job.status === 'completed';
  const isCancelled = job.status === 'cancelled';

  const timeLabel = isCompleted
    ? `Completed: ${formatCompletionTimestamp(job.completed_at)}`
    : isCancelled
      ? `Cancelled: ${formatCompletionTimestamp(job.cancelled_at)}`
      : `Created: ${formatCompletionTimestamp(job.created_at)}`;

  return (
    <Card
      variant="surface"
      onPress={() => onPress(job)}
      style={styles.card}>
      {/* Top Header: Service Scope & Real Status Badge */}
      <View style={styles.cardHeader}>
        <ThemedText type="headline" style={styles.serviceTitle} numberOfLines={1}>
          {job.service}
        </ThemedText>
        <StatusBadge status={job.status as JobStatus} size="sm" />
      </View>

      {/* Customer Name & Actual Lifecycle Timestamp */}
      <View style={styles.detailsRow}>
        <ThemedText type="bodyMedium" numberOfLines={1} style={styles.customerName}>
          {job.customer_name}
        </ThemedText>
        <ThemedText
          type="caption"
          style={[styles.timestampText, { color: isCompleted ? Palette.greenText : theme.textSecondary }]}>
          {timeLabel}
        </ThemedText>
      </View>

      {/* Physical Address */}
      <View style={styles.addressContainer}>
        <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1}>
          {job.address}
        </ThemedText>
      </View>

      {/* Footer: Assigned Technician with Unassigned/Missing Safe Fallback */}
      <View style={[styles.footerRow, { borderTopColor: theme.borderSubtle }]}>
        <ThemedText type="label" themeColor="textSecondary">
          TECHNICIAN
        </ThemedText>
        {workerName ? (
          <View style={styles.workerBadge}>
            <View style={[styles.workerDot, { backgroundColor: theme.primary }]} />
            <ThemedText type="captionMedium" numberOfLines={1}>
              {workerName}
            </ThemedText>
          </View>
        ) : (
          <View style={[styles.unassignedBadge, { backgroundColor: theme.surfaceSecondary }]}>
            <ThemedText type="label" themeColor="textSecondary">
              Unassigned
            </ThemedText>
          </View>
        )}
      </View>
    </Card>
  );
}

export default function OwnerJobHistoryScreen() {
  const theme = useTheme();

  const {
    jobs,
    totalCount,
    isLoading,
    isRefreshing,
    isLoadingMore,
    hasMore,
    error,
    statusFilter,
    datePreset,
    setStatusFilter,
    setDatePreset,
    refetch,
    onRefresh,
    fetchNextPage,
  } = useJobHistory({
    initialStatus: 'completed',
    initialDatePreset: 'all',
    pageSize: 20,
  });

  // Reconcile and reload when screen gains focus
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

  const resetFilters = () => {
    setStatusFilter('completed');
    setDatePreset('all');
  };

  const renderHeader = () => (
    <View style={styles.headerContainer}>
      <RealtimeStatusBanner />

      {/* Screen Title & Record Counter */}
      <View style={styles.titleGroup}>
        <ThemedText type="title">Job History</ThemedText>
        <ThemedText type="body" themeColor="textSecondary">
          {totalCount} historical service visit{totalCount === 1 ? '' : 's'} recorded
        </ThemedText>
      </View>

      {/* Status Filter Chips Bar */}
      <View style={styles.filterSection}>
        <ThemedText type="label" themeColor="textSecondary" style={styles.filterSectionLabel}>
          STATUS
        </ThemedText>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChipsRow}>
          {STATUS_OPTIONS.map((opt) => {
            const isSelected = statusFilter === opt.key;
            return (
              <Pressable
                key={opt.key}
                onPress={() => setStatusFilter(opt.key)}
                style={[
                  styles.filterChip,
                  {
                    backgroundColor: isSelected ? theme.primary : theme.surfaceSecondary,
                    borderColor: isSelected ? theme.primary : theme.borderSubtle,
                  },
                ]}>
                <ThemedText
                  type="label"
                  style={{
                    color: isSelected ? theme.primaryForeground : theme.text,
                    fontWeight: isSelected ? '600' : '500',
                  }}>
                  {opt.label}
                </ThemedText>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Date Filter Chips Bar */}
      <View style={styles.filterSection}>
        <ThemedText type="label" themeColor="textSecondary" style={styles.filterSectionLabel}>
          DATE RANGE
        </ThemedText>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChipsRow}>
          {DATE_OPTIONS.map((opt) => {
            const isSelected = datePreset === opt.key;
            return (
              <Pressable
                key={opt.key}
                onPress={() => setDatePreset(opt.key)}
                style={[
                  styles.filterChip,
                  {
                    backgroundColor: isSelected ? theme.primary : theme.surfaceSecondary,
                    borderColor: isSelected ? theme.primary : theme.borderSubtle,
                  },
                ]}>
                <ThemedText
                  type="label"
                  style={{
                    color: isSelected ? theme.primaryForeground : theme.text,
                    fontWeight: isSelected ? '600' : '500',
                  }}>
                  {opt.label}
                </ThemedText>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Error / Retry Banner */}
      {error ? (
        <Card
          variant="outline"
          style={[
            styles.errorCard,
            { borderColor: theme.dangerBorder, backgroundColor: theme.dangerBackground },
          ]}>
          <ThemedText type="headline" style={{ color: theme.danger }}>
            Failed to load job history
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
    </View>
  );

  const renderFooter = () => {
    if (isLoadingMore) {
      return (
        <View style={styles.footerLoader}>
          <Loading label="Loading older records..." />
        </View>
      );
    }

    if (hasMore && jobs.length > 0) {
      return (
        <View style={styles.footerLoadMore}>
          <Button
            label="Load More Records"
            variant="outline"
            size="sm"
            onPress={fetchNextPage}
            fullWidth
          />
        </View>
      );
    }

    if (!hasMore && jobs.length > 0) {
      return (
        <View style={styles.footerEnd}>
          <ThemedText type="caption" themeColor="textSecondary">
            Showing all {jobs.length} of {totalCount} historical record{totalCount === 1 ? '' : 's'}
          </ThemedText>
        </View>
      );
    }

    return null;
  };

  if (isLoading && !isRefreshing) {
    return (
      <ScreenContainer scrollable={false} withPadding>
        {renderHeader()}
        <View style={styles.loadingContainer}>
          <Loading label="Loading job history records..." />
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer scrollable={false} withPadding={false}>
      <FlatList
        data={jobs}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <HistoryJobCard job={item} onPress={handleJobPress} />}
        ListHeaderComponent={renderHeader}
        ListFooterComponent={renderFooter}
        ListEmptyComponent={() => {
          if (error) return null;
          return (
            <View style={styles.emptyContainer}>
              <EmptyState
                title="No History Found"
                description={`No ${
                  statusFilter === 'all' ? '' : statusFilter
                } jobs recorded for the selected ${
                  datePreset === 'all' ? 'view' : datePreset.replace(/_/g, ' ')
                }.`}
                actionLabel="Reset to Completed (All Time)"
                onAction={resetFilters}
              />
            </View>
          );
        }}
        contentContainerStyle={styles.listContent}
        onEndReached={fetchNextPage}
        onEndReachedThreshold={0.3}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: Spacing.xl * 2,
  },
  headerContainer: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.base,
    paddingBottom: Spacing.xs,
    gap: Spacing.sm,
  },
  titleGroup: {
    gap: 2,
  },
  filterSection: {
    gap: 4,
  },
  filterSectionLabel: {
    fontSize: 11,
    letterSpacing: 0.5,
  },
  filterChipsRow: {
    flexDirection: 'row',
    gap: Spacing.xs,
    paddingVertical: 2,
  },
  filterChip: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs - 1,
    borderRadius: Radii.full,
    borderWidth: 1,
  },
  card: {
    marginHorizontal: Spacing.base,
    marginVertical: Spacing.xs,
    padding: Spacing.base,
    gap: Spacing.xs + 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  serviceTitle: {
    flex: 1,
  },
  detailsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: Spacing.sm,
  },
  customerName: {
    flex: 1,
  },
  timestampText: {
    fontSize: 11,
    fontWeight: '500',
  },
  addressContainer: {
    marginTop: 2,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: Spacing.xs,
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
  },
  workerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '65%',
  },
  workerDot: {
    width: 6,
    height: 6,
    borderRadius: Radii.full,
  },
  unassignedBadge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radii.pill,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: Spacing.xl * 2,
  },
  emptyContainer: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.xl,
  },
  errorCard: {
    padding: Spacing.sm,
    gap: Spacing.xs,
    marginVertical: Spacing.xs,
  },
  retryButton: {
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  footerLoader: {
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  footerLoadMore: {
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
  },
  footerEnd: {
    paddingVertical: Spacing.lg,
    alignItems: 'center',
  },
});
