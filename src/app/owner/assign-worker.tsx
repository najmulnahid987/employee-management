import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, Input, Loading, ScreenContainer } from '@/components/ui';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import {
  AssignableWorker,
  assignJobWorker,
  fetchAssignableWorkers,
  fetchJobDetails,
} from '@/lib/jobs';

export default function AssignWorkerScreen() {
  const theme = useTheme();
  const { businessId } = useAuth();
  const { jobId, currentWorkerId } = useLocalSearchParams<{
    jobId?: string;
    currentWorkerId?: string;
  }>();

  const [searchQuery, setSearchQuery] = useState('');
  const [workers, setWorkers] = useState<AssignableWorker[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(
    currentWorkerId || null
  );
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isAssigning, setIsAssigning] = useState<boolean>(false);
  const [jobService, setJobService] = useState<string | null>(null);

  // Synchronous double-tap lock preventing concurrent action executions
  const actionLockRef = useRef<boolean>(false);

  const loadData = useCallback(async () => {
    if (!businessId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      if (jobId) {
        const { job } = await fetchJobDetails(jobId, businessId);
        if (job) {
          setJobService(job.service);
          if (job.worker_id) {
            setSelectedWorkerId(job.worker_id);
          }
        }
      }

      const { workers: loadedWorkers } = await fetchAssignableWorkers(
        businessId,
        new Date()
      );
      setWorkers(loadedWorkers || []);
    } finally {
      setIsLoading(false);
    }
  }, [businessId, jobId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const filteredWorkers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return workers;
    return workers.filter(
      (w) =>
        w.full_name.toLowerCase().includes(q) ||
        (w.phone && w.phone.toLowerCase().includes(q))
    );
  }, [workers, searchQuery]);

  const handleConfirmAssignment = async () => {
    if (!jobId || !selectedWorkerId || isAssigning || actionLockRef.current) return;

    actionLockRef.current = true;
    const selectedWorker = workers.find((w) => w.id === selectedWorkerId);
    setIsAssigning(true);
    try {
      const result = await assignJobWorker(jobId, selectedWorkerId);
      if (result.success) {
        Alert.alert(
          'Assignment Confirmed',
          `${selectedWorker?.full_name || 'Technician'} has been assigned to this service visit.`,
          [
            {
              text: 'OK',
              onPress: () => router.back(),
            },
          ]
        );
      } else {
        Alert.alert(
          'Unable to Assign Worker',
          result.error || 'The job status has changed. Please refresh and try again.'
        );
        await loadData();
      }
    } catch (err) {
      Alert.alert(
        'Unable to Assign Worker',
        err instanceof Error ? err.message : 'An unexpected error occurred.'
      );
    } finally {
      actionLockRef.current = false;
      setIsAssigning(false);
    }
  };

  const getBadgeStyle = (variant: AssignableWorker['workloadBadge']['variant']) => {
    switch (variant) {
      case 'available':
        return {
          bg: Palette.greenBg,
          border: Palette.greenBorder,
          text: Palette.greenText,
        };
      case 'active':
        return {
          bg: Palette.amberBg,
          border: Palette.amberBorder,
          text: Palette.amberText,
        };
      case 'upcoming':
        return {
          bg: Palette.blueBg,
          border: Palette.blueBorder,
          text: Palette.blueText,
        };
      case 'ineligible':
      default:
        return {
          bg: theme.surfaceSecondary,
          border: theme.borderSubtle,
          text: theme.textMuted,
        };
    }
  };

  if (!jobId) {
    return (
      <ScreenContainer scrollable withPadding>
        <View style={styles.container}>
          <EmptyState
            title="No Job Specified"
            description="Please select a service job from your Operations Dashboard to assign a field technician."
            actionLabel="Back to Dashboard"
            onAction={() => router.back()}
          />
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer scrollable={false} withPadding={false}>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Assign Field Technician</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            {jobService
              ? `Select a technician for "${jobService}"`
              : 'Select an active technician from your business roster.'}
          </ThemedText>
        </View>

        <View style={styles.searchWrapper}>
          <Input
            placeholder="Search workers by name or phone..."
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>

        {isLoading ? (
          <Loading label="Loading available technicians..." style={styles.loadingContainer} />
        ) : (
          <FlatList
            data={filteredWorkers}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              workers.length === 0 ? (
                <EmptyState
                  title="No Field Workers Registered"
                  description="You have not added any technicians to your business roster yet. Add team members to dispatch jobs."
                  actionLabel="Go Back"
                  onAction={() => router.back()}
                />
              ) : (
                <View style={styles.emptySearch}>
                  <ThemedText type="body" themeColor="textSecondary">
                    No technicians match &quot;{searchQuery}&quot;
                  </ThemedText>
                </View>
              )
            }
            renderItem={({ item }) => {
              const isSelected = selectedWorkerId === item.id;
              const badgeStyle = getBadgeStyle(item.workloadBadge.variant);
              const isDisabled = !item.is_active;

              return (
                <Pressable
                  disabled={isDisabled || isAssigning}
                  onPress={() => setSelectedWorkerId(item.id)}
                  style={({ pressed }) => [
                    styles.workerCard,
                    {
                      backgroundColor: theme.surface,
                      borderColor: isSelected ? theme.primary : theme.border,
                      borderWidth: isSelected ? 2 : 1,
                      opacity: isDisabled ? 0.45 : pressed ? 0.8 : 1,
                    },
                  ]}>
                  <View style={styles.workerRow}>
                    <View style={[styles.avatarDot, { backgroundColor: theme.primary }]}>
                      <ThemedText type="captionMedium" style={{ color: theme.primaryForeground }}>
                        {item.full_name.charAt(0).toUpperCase()}
                      </ThemedText>
                    </View>
                    <View style={styles.workerInfo}>
                      <ThemedText type="headline" style={styles.workerName}>
                        {item.full_name}
                      </ThemedText>
                      {item.phone ? (
                        <ThemedText type="caption" themeColor="textSecondary">
                          {item.phone}
                        </ThemedText>
                      ) : null}
                      <View style={styles.badgeRow}>
                        <View
                          style={[
                            styles.badge,
                            {
                              backgroundColor: badgeStyle.bg,
                              borderColor: badgeStyle.border,
                            },
                          ]}>
                          <ThemedText
                            type="captionMedium"
                            style={[styles.badgeText, { color: badgeStyle.text }]}>
                            {item.workloadBadge.label}
                          </ThemedText>
                        </View>
                      </View>
                    </View>
                    {isSelected ? (
                      <View style={[styles.checkCircle, { backgroundColor: theme.primary }]}>
                        <ThemedText type="caption" style={{ color: theme.primaryForeground }}>
                          ✓
                        </ThemedText>
                      </View>
                    ) : null}
                  </View>
                </Pressable>
              );
            }}
          />
        )}

        <View style={styles.footer}>
          <Button
            label="Confirm Assignment"
            variant="primary"
            disabled={!selectedWorkerId || isAssigning || isLoading}
            loading={isAssigning}
            fullWidth
            onPress={handleConfirmAssignment}
          />
        </View>
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
    paddingBottom: Spacing.xs,
    gap: Spacing.xxs,
  },
  searchWrapper: {
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.xs,
  },
  loadingContainer: {
    paddingVertical: Spacing.xl,
  },
  listContent: {
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
  },
  workerCard: {
    borderRadius: Radii.md,
    padding: Spacing.base,
  },
  workerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.base,
  },
  avatarDot: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  workerInfo: {
    flex: 1,
    gap: Spacing.xxs,
  },
  workerName: {
    fontSize: 15,
  },
  badgeRow: {
    flexDirection: 'row',
    marginTop: 2,
  },
  badge: {
    paddingHorizontal: Spacing.xs,
    paddingVertical: 2,
    borderRadius: Radii.full,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  checkCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptySearch: {
    paddingVertical: Spacing.lg,
    alignItems: 'center',
  },
  footer: {
    padding: Spacing.base,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.06)',
  },
});
