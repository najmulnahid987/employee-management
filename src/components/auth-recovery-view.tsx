import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, ScreenContainer } from '@/components/ui';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface AuthRecoveryViewProps {
  /** Title summarizing the recovery state */
  title: string;
  /** User-friendly, non-sensitive explanation */
  message: string;
  /** Optional sanitized diagnostic details (rendered only in __DEV__) */
  diagnosticMessage?: string;
  /** Action callback to retry profile loading */
  onRetry?: () => Promise<void> | void;
  /** Action callback to sign out and clear session */
  onSignOut: () => Promise<void> | void;
}

/**
 * Screen displayed when session exists but profile is inaccessible,
 * deactivated, or has an invalid/unrecognized role.
 */
export function AuthRecoveryView({
  title,
  message,
  diagnosticMessage,
  onRetry,
  onSignOut,
}: AuthRecoveryViewProps) {
  const theme = useTheme();
  const [retrying, setRetrying] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const handleRetry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <ScreenContainer withPadding contentContainerStyle={styles.centerContainer}>
      <Card variant="surface" style={styles.card}>
        <View style={styles.header}>
          <ThemedText type="headline" style={styles.title}>
            {title}
          </ThemedText>
          <ThemedText type="body" themeColor="textSecondary" style={styles.message}>
            {message}
          </ThemedText>
        </View>

        {diagnosticMessage && __DEV__ ? (
          <View style={[styles.diagnosticBox, { backgroundColor: theme.surfaceSubtle }]}>
            <ThemedText type="caption" themeColor="textSecondary" style={styles.diagnosticLabel}>
              DIAGNOSTIC (DEV ONLY)
            </ThemedText>
            <ThemedText type="caption" style={styles.diagnosticText}>
              {diagnosticMessage}
            </ThemedText>
          </View>
        ) : null}

        <View style={styles.actions}>
          {onRetry ? (
            <Button
              label="Retry Connection"
              variant="primary"
              fullWidth
              loading={retrying}
              disabled={retrying || signingOut}
              onPress={handleRetry}
            />
          ) : null}

          <Button
            label="Sign Out"
            variant="outline"
            fullWidth
            loading={signingOut}
            disabled={retrying || signingOut}
            onPress={handleSignOut}
          />
        </View>
      </Card>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  centerContainer: {
    justifyContent: 'center',
  },
  card: {
    padding: Spacing.lg,
    width: '100%',
    maxWidth: 420,
    gap: Spacing.base,
  },
  header: {
    gap: Spacing.xs,
    alignItems: 'center',
  },
  title: {
    textAlign: 'center',
  },
  message: {
    textAlign: 'center',
  },
  diagnosticBox: {
    padding: Spacing.sm,
    borderRadius: Radii.sm,
    gap: Spacing.xs,
  },
  diagnosticLabel: {
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  diagnosticText: {
    fontFamily: 'monospace',
    fontSize: 12,
  },
  actions: {
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
});
