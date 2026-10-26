import { router, useFocusEffect } from 'expo-router';
import React, { useCallback } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { WorkerJobCard } from '@/components/jobs/worker-job-card';
import { RealtimeStatusBanner } from '@/components/realtime-status-banner';
import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, Loading, ScreenContainer } from '@/components/ui';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useWorkerJobs, WorkerJobTab } from '@/hooks/use-worker-jobs';
import { Job } from '@/lib/jobs';

export default function WorkerJobsScreen() {
  const theme = useTheme();
  const {
    activeAndUpcoming,
    completed,
    displayedJobs,
    selectedTab,
    setSelectedTab,
    isLoading,
    isRefreshing,
    error,
    refetch,
    onRefresh,
  } = useWorkerJobs();

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  const handleJobPress = (job: Job) => {
    router.push({
      pathname: '/worker/job-details',
      params: { id: job.id },
    });
  };

  const renderJobItem = ({ item }: { item: Job }) => (
    <WorkerJobCard job={item} onPress={handleJobPress} style={styles.jobItem} />
  );

  return (
    <ScreenContainer scrollable={false} withPadding={false}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <RealtimeStatusBanner />
          <ThemedText type="headline">My Assigned Jobs</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            All service assignments dispatched to you.
          </ThemedText>

          {/* Segmented Filter Pills */}
          <View style={[styles.segmentContainer, { backgroundColor: theme.surfaceSecondary }]}>
            <Pressable
              onPress={() => setSelectedTab('active')}
              style={[
                styles.segmentButton,
                selectedTab === 'active' && [
                  styles.segmentButtonActive,
                  { backgroundColor: theme.surface, borderColor: theme.border },
                ],
              ]}>
              <ThemedText
                type="label"
                themeColor={selectedTab === 'active' ? 'text' : 'textSecondary'}>
                ACTIVE & UPCOMING ({activeAndUpcoming.length})
              </ThemedText>
            </Pressable>

            <Pressable
              onPress={() => setSelectedTab('completed')}
              style={[
                styles.segmentButton,
                selectedTab === 'completed' && [
                  styles.segmentButtonActive,
                  { backgroundColor: theme.surface, borderColor: theme.border },
                ],
              ]}>
              <ThemedText
                type="label"
                themeColor={selectedTab === 'completed' ? 'text' : 'textSecondary'}>
                COMPLETED ({completed.length})
              </ThemedText>
            </Pressable>
          </View>
        </View>

        {/* Error Notification */}
        {error ? (
          <View style={styles.errorPadding}>
            <Card
              variant="outline"
              style={[
                styles.errorCard,
                { borderColor: theme.dangerBorder, backgroundColor: theme.dangerBackground },
              ]}>
              <ThemedText type="bodyMedium" style={{ color: theme.danger }}>
                Failed to load assignments
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
          </View>
        ) : null}

        {/* Content Area */}
        {isLoading && !isRefreshing ? (
          <Loading fullScreen label="Loading assigned jobs..." />
        ) : (
          <FlatList
            data={displayedJobs}
            keyExtractor={(item) => item.id}
            renderItem={renderJobItem}
            contentContainerStyle={styles.listContent}
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />}
            ListEmptyComponent={
              !error ? (
                <EmptyState
                  title={
                    selectedTab === 'active'
                      ? 'No Active Assignments'
                      : 'No Completed Jobs'
                  }
                  description={
                    selectedTab === 'active'
                      ? 'You currently do not have any pending, accepted, or active service jobs.'
                      : 'You have not completed any service visits yet.'
                  }
                />
              ) : null
            }
          />
        )}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.base,
    paddingBottom: Spacing.sm,
    gap: Spacing.xs,
  },
  segmentContainer: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: Radii.sm,
    marginTop: Spacing.xs,
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radii.sm - 2,
  },
  segmentButtonActive: {
    borderWidth: 1,
  },
  errorPadding: {
    paddingHorizontal: Spacing.base,
    marginBottom: Spacing.xs,
  },
  errorCard: {
    padding: Spacing.base,
    gap: Spacing.xs,
  },
  retryButton: {
    alignSelf: 'flex-start',
    marginTop: Spacing.xs,
  },
  listContent: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xl,
    gap: Spacing.sm,
  },
  jobItem: {
    marginBottom: 0,
  },
});
