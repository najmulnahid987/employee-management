import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, Input, Loading } from '@/components/ui';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { AssignableWorker } from '@/lib/jobs';

export interface WorkerSelectorSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelectWorker: (worker: AssignableWorker | null) => void;
  selectedWorkerId: string | null;
  workers: AssignableWorker[];
  isLoading: boolean;
  onRefresh?: () => void;
}

export function WorkerSelectorSheet({
  visible,
  onClose,
  onSelectWorker,
  selectedWorkerId,
  workers,
  isLoading,
  onRefresh,
}: WorkerSelectorSheetProps) {
  const theme = useTheme();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredWorkers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return workers;
    return workers.filter(
      (w) =>
        w.full_name.toLowerCase().includes(q) ||
        (w.phone && w.phone.toLowerCase().includes(q))
    );
  }, [workers, searchQuery]);

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

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}>
      <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
        <View style={styles.header}>
          <View style={styles.headerTitleGroup}>
            <ThemedText type="headline">Assign Field Technician</ThemedText>
            <ThemedText type="caption" themeColor="textSecondary">
              Select an active technician from your business roster
            </ThemedText>
          </View>
          <Button label="Close" variant="ghost" size="sm" onPress={onClose} />
        </View>

        <View style={styles.searchContainer}>
          <Input
            placeholder="Search workers by name or phone..."
            value={searchQuery}
            onChangeText={setSearchQuery}
            containerStyle={styles.searchInputWrapper}
          />
        </View>

        {isLoading ? (
          <Loading label="Loading technicians and current workload..." style={styles.loadingContainer} />
        ) : (
          <FlatList
            data={filteredWorkers}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              <Pressable
                onPress={() => {
                  onSelectWorker(null);
                  onClose();
                }}
                style={({ pressed }) => [
                  styles.workerCard,
                  {
                    backgroundColor: theme.surface,
                    borderColor: selectedWorkerId === null ? theme.primary : theme.border,
                    borderWidth: selectedWorkerId === null ? 2 : 1,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}>
                <View style={styles.workerRow}>
                  <View style={[styles.avatarDot, { backgroundColor: theme.surfaceSecondary }]}>
                    <ThemedText type="captionMedium" style={{ color: theme.textSecondary }}>
                      Ø
                    </ThemedText>
                  </View>
                  <View style={styles.workerInfo}>
                    <ThemedText type="headline" style={styles.workerName}>
                      No Worker (Keep Unassigned)
                    </ThemedText>
                    <ThemedText type="caption" themeColor="textSecondary">
                      Save as unassigned to dispatch at a later time
                    </ThemedText>
                  </View>
                  {selectedWorkerId === null ? (
                    <View style={[styles.checkCircle, { backgroundColor: theme.primary }]}>
                      <ThemedText type="caption" style={{ color: theme.primaryForeground }}>
                        ✓
                      </ThemedText>
                    </View>
                  ) : null}
                </View>
              </Pressable>
            }
            ListEmptyComponent={
              workers.length === 0 ? (
                <EmptyState
                  title="No Field Workers Found"
                  description="You have not added any technicians to your business roster yet. Invite workers from your team settings to dispatch them."
                  actionLabel="Close"
                  onAction={onClose}
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
                  disabled={isDisabled}
                  onPress={() => {
                    onSelectWorker(item);
                    onClose();
                  }}
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
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Palette.neutral200,
  },
  headerTitleGroup: {
    gap: Spacing.xxs,
    flex: 1,
  },
  searchContainer: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
  },
  searchInputWrapper: {
    marginBottom: 0,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  listContent: {
    padding: Spacing.base,
    gap: Spacing.sm,
  },
  workerCard: {
    padding: Spacing.base,
    borderRadius: Radii.base,
    marginBottom: Spacing.xs,
  },
  workerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  avatarDot: {
    width: 40,
    height: 40,
    borderRadius: Radii.full,
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
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radii.pill,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 11,
    lineHeight: 14,
  },
  checkCircle: {
    width: 24,
    height: 24,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptySearch: {
    paddingVertical: Spacing.xl,
    alignItems: 'center',
  },
});
