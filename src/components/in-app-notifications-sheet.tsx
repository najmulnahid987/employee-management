/**
 * Dispatcher In-App Notifications Sheet
 *
 * Minimal, RLS-protected in-app notification center displaying the authenticated
 * user's recent notifications from public.notification_deliveries.
 *
 * Responsibilities:
 * 1. Fetches only the authenticated user's deliveries (RLS-enforced).
 * 2. Displays clean title, message, relative timestamp, and status.
 * 3. Tapping a notification navigates to the role-correct Job Details screen.
 * 4. Minimal overlay design consistent with B2B design system tokens.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { EmptyState } from '@/components/ui';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { FormattedInAppNotification } from '@/lib/notification-navigation-core';
import { fetchUserInAppNotifications } from '@/lib/notification-navigation';

export interface InAppNotificationsSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelectJob: (jobId: string) => void;
}

function formatRelativeTime(dateString: string): string {
  try {
    const timestamp = new Date(dateString).getTime();
    if (isNaN(timestamp)) return 'Recently';

    const now = Date.now();
    const diffSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));

    if (diffSeconds < 60) return 'Just now';
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  } catch {
    return 'Recently';
  }
}

export function InAppNotificationsSheet({
  visible,
  onClose,
  onSelectJob,
}: InAppNotificationsSheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [notifications, setNotifications] = useState<FormattedInAppNotification[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const loadNotifications = async () => {
    setIsLoading(true);
    try {
      const items = await fetchUserInAppNotifications();
      setNotifications(items);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (visible) {
      loadNotifications();
    }
  }, [visible]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.dismissArea} onPress={onClose} />

        <View
          style={[
            styles.sheetContainer,
            {
              backgroundColor: theme.background,
              paddingBottom: Math.max(insets.bottom, Spacing.md),
            },
          ]}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View style={styles.headerDot} />
              <ThemedText type="headline" style={styles.headerTitle}>
                Notifications
              </ThemedText>
            </View>

            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={styles.closeButton}
              accessibilityLabel="Close notifications sheet">
              <ThemedText type="body" style={styles.closeButtonText}>
                ✕
              </ThemedText>
            </Pressable>
          </View>

          {/* Notifications List */}
          {isLoading && notifications.length === 0 ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color={Palette.black} />
              <ThemedText type="caption" themeColor="textSecondary">
                Loading notifications...
              </ThemedText>
            </View>
          ) : notifications.length === 0 ? (
            <View style={styles.emptyContainer}>
              <EmptyState
                title="No notifications"
                description="You're all caught up. New dispatch alerts and status changes will appear here."
              />
            </View>
          ) : (
            <ScrollView
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}>
              {notifications.map((item) => (
                <Pressable
                  key={item.id}
                  onPress={() => {
                    onClose();
                    onSelectJob(item.jobId);
                  }}
                  style={({ pressed }) => [
                    styles.notificationCard,
                    {
                      borderColor: Palette.neutral200,
                      backgroundColor: pressed ? Palette.neutral100 : theme.surface,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.title}: ${item.body}. Tap to view job.`}>
                  <View style={styles.cardHeader}>
                    <ThemedText type="label" style={styles.cardTitle}>
                      {item.title}
                    </ThemedText>
                    <ThemedText type="caption" themeColor="textSecondary" style={styles.timeText}>
                      {formatRelativeTime(item.createdAt)}
                    </ThemedText>
                  </View>

                  <ThemedText type="body" numberOfLines={2} style={styles.cardBody}>
                    {item.body}
                  </ThemedText>

                  <ThemedText type="caption" style={styles.actionPrompt}>
                    Tap to view job details &rarr;
                  </ThemedText>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'flex-end',
  },
  dismissArea: {
    flex: 1,
  },
  sheetContainer: {
    borderTopLeftRadius: Radii.lg,
    borderTopRightRadius: Radii.lg,
    maxHeight: '80%',
    minHeight: 300,
    paddingTop: Spacing.md,
    paddingHorizontal: Spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Palette.neutral200,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs + 2,
  },
  headerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Palette.black,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  closeButton: {
    padding: Spacing.xs,
  },
  closeButtonText: {
    fontSize: 14,
    color: Palette.neutral600,
  },
  loadingContainer: {
    paddingVertical: Spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  emptyContainer: {
    paddingVertical: Spacing.lg,
  },
  listContent: {
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
  },
  notificationCard: {
    padding: Spacing.sm + 4,
    borderRadius: Radii.sm,
    borderWidth: 1,
    gap: 4,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  timeText: {
    fontSize: 11,
  },
  cardBody: {
    fontSize: 13,
    lineHeight: 18,
    color: Palette.neutral700,
  },
  actionPrompt: {
    fontSize: 11,
    fontWeight: '600',
    color: Palette.neutral600,
    marginTop: 2,
  },
});
