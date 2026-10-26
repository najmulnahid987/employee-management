/**
 * Dispatcher In-App Notification Banner
 *
 * Displays a lightweight, non-intrusive banner at the top of the viewport
 * when a push notification is received while the application is in the foreground.
 *
 * Invariants:
 * 1. Minimal professional B2B styling consistent with the design system.
 * 2. Tapping the banner triggers navigation to the role-correct Job Details screen.
 * 3. Automatically dismisses after 5 seconds if not interacted with.
 * 4. Includes an explicit dismiss button.
 */

import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ForegroundNotificationAlert } from '@/lib/notification-navigation';

export interface InAppNotificationBannerProps {
  alert: ForegroundNotificationAlert | null;
  onPress: (jobId: string) => void;
  onDismiss: () => void;
  autoDismissMs?: number;
}

export function InAppNotificationBanner({
  alert,
  onPress,
  onDismiss,
  autoDismissMs = 5000,
}: InAppNotificationBannerProps) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  useEffect(() => {
    if (!alert) return;

    const timer = setTimeout(() => {
      onDismiss();
    }, autoDismissMs);

    return () => clearTimeout(timer);
  }, [alert, autoDismissMs, onDismiss]);

  if (!alert) {
    return null;
  }

  return (
    <View style={[styles.wrapper, { top: insets.top + Spacing.xs }]}>
      <Pressable
        onPress={() => onPress(alert.jobId)}
        style={({ pressed }) => [
          styles.container,
          {
            backgroundColor: theme.surface,
            borderColor: Palette.neutral300,
            opacity: pressed ? 0.92 : 1,
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`${alert.title}: ${alert.body}. Tap to view job.`}>
        <View style={styles.indicatorDot} />

        <View style={styles.textContainer}>
          <ThemedText type="label" style={styles.titleText}>
            {alert.title}
          </ThemedText>
          <ThemedText type="caption" numberOfLines={2} style={styles.bodyText}>
            {alert.body}
          </ThemedText>
        </View>

        <Pressable
          onPress={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          hitSlop={8}
          style={styles.closeButton}
          accessibilityLabel="Dismiss notification banner">
          <ThemedText type="caption" style={styles.closeText}>
            ✕
          </ThemedText>
        </Pressable>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: Spacing.md,
    right: Spacing.md,
    zIndex: 9999,
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    borderRadius: Radii.md,
    borderWidth: 1,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 6,
    gap: Spacing.sm,
  },
  indicatorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Palette.black,
  },
  textContainer: {
    flex: 1,
    gap: 2,
  },
  titleText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  bodyText: {
    fontSize: 12,
    lineHeight: 16,
    color: Palette.neutral700,
  },
  closeButton: {
    padding: Spacing.xs,
  },
  closeText: {
    fontSize: 13,
    color: Palette.neutral500,
  },
});
