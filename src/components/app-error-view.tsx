/**
 * Dispatcher M18.4 — Application Error Boundary Screen
 *
 * Minimal professional fallback screen rendered when an unexpected render
 * or component error occurs within the application tree.
 *
 * Privacy & Security Guarantees:
 * - Never shows raw SQL queries, stack traces, tokens, or credentials.
 * - Displays a sanitized, user-friendly message.
 * - In development (__DEV__), shows safe diagnostic hints without secrets.
 * - Provides immediate actions to retry or return to the main dashboard.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, ScreenContainer } from '@/components/ui';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { toUserFacingErrorMessage } from '@/lib/logger';

declare const __DEV__: boolean | undefined;

export interface AppErrorViewProps {
  /** Error object captured by boundary */
  error: Error | unknown;
  /** Callback to reset boundary and retry rendering */
  onRetry?: () => Promise<void> | void;
  /** Callback to navigate back or to home screen */
  onGoHome?: () => void;
}

export function AppErrorView({ error, onRetry, onGoHome }: AppErrorViewProps) {
  const theme = useTheme();
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
  const userMessage = toUserFacingErrorMessage(
    error,
    'An unexpected error occurred while displaying this screen.'
  );

  return (
    <ScreenContainer withPadding contentContainerStyle={styles.centerContainer}>
      <Card variant="surface" style={styles.card}>
        <View style={styles.header}>
          <ThemedText type="headline" style={[styles.title, { color: theme.text }]}>
            Something went wrong
          </ThemedText>
          <ThemedText type="body" style={[styles.message, { color: theme.textSecondary }]}>
            {userMessage}
          </ThemedText>
        </View>

        {isDev && error instanceof Error && (
          <View style={[styles.diagnosticBox, { backgroundColor: theme.surfaceSecondary, borderColor: theme.border }]}>
            <ThemedText type="caption" style={[styles.diagnosticTitle, { color: theme.textMuted }]}>
              Diagnostics (Dev Only):
            </ThemedText>
            <ThemedText type="caption" style={[styles.diagnosticText, { color: theme.textSecondary }]}>
              {error.name}: {error.message}
            </ThemedText>
          </View>
        )}

        <View style={styles.actions}>
          {onRetry && (
            <Button
              label={retrying ? 'Retrying...' : 'Try Again'}
              onPress={handleRetry}
              disabled={retrying}
              style={styles.button}
            />
          )}
          {onGoHome && (
            <Button
              label="Return to Dashboard"
              variant="outline"
              onPress={onGoHome}
              style={styles.button}
            />
          )}
        </View>
      </Card>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  centerContainer: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: Spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    padding: Spacing.xl,
    borderRadius: Radii.lg,
  },
  header: {
    marginBottom: Spacing.lg,
  },
  title: {
    marginBottom: Spacing.sm,
    fontWeight: '700',
  },
  message: {
    lineHeight: 22,
  },
  diagnosticBox: {
    padding: Spacing.md,
    borderRadius: Radii.md,
    borderWidth: 1,
    marginBottom: Spacing.lg,
  },
  diagnosticTitle: {
    fontWeight: '600',
    marginBottom: Spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  diagnosticText: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 16,
  },
  actions: {
    gap: Spacing.md,
    marginTop: Spacing.sm,
  },
  button: {
    width: '100%',
  },
});
