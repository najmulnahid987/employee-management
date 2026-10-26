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

import { JobCard } from '@/components/jobs/job-card';
import { RealtimeStatusBanner } from '@/components/realtime-status-banner';
import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, Input, Loading, ScreenContainer } from '@/components/ui';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useOwnerJobs } from '@/hooks/use-owner-jobs';
import { useTheme } from '@/hooks/use-theme';
import { JobWithWorker, OwnerJobFilter } from '@/lib/jobs';

const FILTER_OPTIONS: { key: OwnerJobFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

export default function OwnerJobsScreen() {
  const theme = useTheme();
  const {
    jobs,
    filteredJobs,
    filterCounts,
    selectedFilter,
    setSelectedFilter,
    searchQuery,
    setSearchQuery,
    isLoading,
    isRefreshing,
    error,
    refetch,
    onRefresh,
  } = useOwnerJobs();

  // Reconcile and reload jobs automatically whenever the screen gains focus
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

  const renderHeader = () => (
    <View style={styles.headerContainer}>
      <RealtimeStatusBanner />

      {/* Top Header */}
      <View style={styles.headerTop}>
        <View style={styles.headerTitleGroup}>
          <ThemedText type="headline">All Jobs</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            {jobs.length} total service visit{jobs.length === 1 ? '' : 's'} recorded
          </ThemedText>
        </View>

        <Button
          label="+ Create Job"
          variant="primary"
          size="sm"
          onPress={() => router.push('/owner/create-job')}
        />
      </View>

      {/* Search Input */}
      {jobs.length > 0 && (
        <View style={styles.searchContainer}>
          <Input
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search customer, service, address, worker..."
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
        </View>
      )}

      {/* Filter Chips Bar */}
      {jobs.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterBar}>
          {FILTER_OPTIONS.map((opt) => {
            const isSelected = selectedFilter === opt.key;
            const count = filterCounts[opt.key] ?? 0;
            return (
              <Pressable
                key={opt.key}
                onPress={() => setSelectedFilter(opt.key)}
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
                  {opt.label} ({count})
                </ThemedText>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {/* Error Banner */}
      {error && (
        <Card
          variant="outline"
          style={[
            styles.errorCard,
            { borderColor: theme.dangerBorder, backgroundColor: theme.dangerBackground },
          ]}>
          <ThemedText type="headline" style={{ color: theme.danger }}>
            Failed to load jobs
          </ThemedText>
          <ThemedText type="caption" style={{ color: theme.danger }}>
            {error}
          </ThemedText>
          <Button label="Retry" variant="outline" size="sm" onPress={refetch} />
        </Card>
      )}
    </View>
  );

  if (isLoading && !isRefreshing) {
    return (
      <ScreenContainer scrollable={false} withPadding>
        {renderHeader()}
        <View style={styles.loadingContainer}>
          <Loading label="Loading jobs directory..." />
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer scrollable={false} withPadding={false}>
      <FlatList
        data={filteredJobs}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <JobCard job={item} onPress={handleJobPress} style={styles.jobItem} />
        )}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={() => {
          if (jobs.length === 0) {
            return (
              <View style={styles.emptyContainer}>
                <EmptyState
                  title="No Jobs Recorded"
                  description="There are currently no dispatch jobs in your business. Tap below to create and assign your first service visit."
                  actionLabel="+ Create Job"
                  onAction={() => router.push('/owner/create-job')}
                />
              </View>
            );
          }
          return (
            <View style={styles.emptyContainer}>
              <EmptyState
                title="No Matching Jobs"
                description={`No jobs found matching "${selectedFilter}" filter${
                  searchQuery ? ` and search "${searchQuery}"` : ''
                }.`}
                actionLabel="Clear Filter"
                onAction={() => {
                  setSelectedFilter('all');
                  setSearchQuery('');
                }}
              />
            </View>
          );
        }}
        contentContainerStyle={styles.listContent}
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
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  headerTitleGroup: {
    flex: 1,
    gap: 2,
  },
  searchContainer: {
    marginTop: Spacing.xs,
  },
  filterBar: {
    flexDirection: 'row',
    gap: Spacing.xs,
    paddingVertical: Spacing.xs,
  },
  filterChip: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderRadius: Radii.full,
    borderWidth: 1,
  },
  errorCard: {
    padding: Spacing.sm,
    gap: Spacing.xs,
    marginVertical: Spacing.xs,
  },
  jobItem: {
    marginHorizontal: Spacing.base,
    marginBottom: Spacing.sm,
  },
  emptyContainer: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.lg,
  },
  loadingContainer: {
    paddingTop: Spacing.xl,
    alignItems: 'center',
  },
});
