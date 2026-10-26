/**
 * Dispatcher Notification Permission Prompt
 *
 * User-friendly onboarding prompt explaining the operational benefits
 * of dispatch notifications before invoking the native system permission dialog.
 *
 * Guarantees:
 * 1. Never prompts immediately upon app launch; shown in dashboard / context.
 * 2. Displays clear business reasons (assignments, arrival, completion).
 * 3. Gracefully dismissed if the user selects "Not now".
 * 4. Application remains 100% usable if permission is denied or dismissed.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card } from '@/components/ui';
import { Palette, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  NOTIFICATION_PERMISSION_EXPLANATION,
  NotificationPermissionState,
} from '@/lib/notifications-core';
import {
  getNotificationPermissionStatusAsync,
  registerPushTokenForAuthenticatedUserAsync,
  requestNotificationPermissionAsync,
} from '@/lib/notifications';

export interface NotificationPermissionPromptProps {
  onPermissionChange?: (state: NotificationPermissionState) => void;
}

export function NotificationPermissionPrompt({
  onPermissionChange,
}: NotificationPermissionPromptProps) {
  const theme = useTheme();
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [isRequesting, setIsRequesting] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;
    getNotificationPermissionStatusAsync().then((status) => {
      if (isMounted && status === 'UNDETERMINED') {
        setIsVisible(true);
      }
    });
    return () => {
      isMounted = false;
    };
  }, []);

  if (!isVisible) {
    return null;
  }

  const handleEnablePress = async () => {
    setIsRequesting(true);
    try {
      const state = await requestNotificationPermissionAsync();
      if (state === 'GRANTED') {
        // Register token with backend
        await registerPushTokenForAuthenticatedUserAsync();
      }
      setIsVisible(false);
      onPermissionChange?.(state);
    } finally {
      setIsRequesting(false);
    }
  };

  const handleDismissPress = () => {
    setIsVisible(false);
  };

  return (
    <Card variant="outline" style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.iconDot} />
        <ThemedText type="headline" style={styles.title}>
          {NOTIFICATION_PERMISSION_EXPLANATION.title}
        </ThemedText>
      </View>

      <ThemedText type="body" themeColor="textSecondary" style={styles.subtitle}>
        {NOTIFICATION_PERMISSION_EXPLANATION.subtitle}
      </ThemedText>

      <View style={styles.reasonsList}>
        {NOTIFICATION_PERMISSION_EXPLANATION.reasons.map((reason, idx) => (
          <View key={idx} style={styles.reasonRow}>
            <ThemedText style={styles.bullet}>•</ThemedText>
            <ThemedText type="caption" themeColor="textSecondary" style={styles.reasonText}>
              {reason}
            </ThemedText>
          </View>
        ))}
      </View>

      <View style={styles.buttonRow}>
        <Button
          label={isRequesting ? 'Enabling...' : 'Enable Notifications'}
          variant="primary"
          size="sm"
          onPress={handleEnablePress}
          disabled={isRequesting}
          style={styles.enableButton}
        />
        <Button
          label="Not Now"
          variant="ghost"
          size="sm"
          onPress={handleDismissPress}
          disabled={isRequesting}
          style={styles.dismissButton}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Palette.neutral300,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs + 2,
    marginBottom: Spacing.xs,
  },
  iconDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Palette.black,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: Spacing.sm,
  },
  reasonsList: {
    gap: 4,
    marginBottom: Spacing.md,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  bullet: {
    fontSize: 12,
    color: Palette.neutral500,
    lineHeight: 16,
  },
  reasonText: {
    fontSize: 12,
    lineHeight: 16,
    flex: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  enableButton: {
    flex: 1,
  },
  dismissButton: {
    minWidth: 80,
  },
});
