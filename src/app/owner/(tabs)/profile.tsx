import { router } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function OwnerProfileScreen() {
  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Business Profile & Settings</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Manage company preferences, operating defaults, and account session.
          </ThemedText>
        </View>

        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Business Information</ThemedText>
          <ThemedText type="body">Acme Service Operations</ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Role: Business Owner
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Account: owner@business.com
          </ThemedText>
        </Card>

        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Dispatch Settings</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Single-worker manual dispatch enabled. Append-only event history active.
          </ThemedText>
        </Card>

        <Button
          label="Sign Out"
          variant="outline"
          fullWidth
          onPress={() => router.replace('/sign-in')}
          style={styles.signOutButton}
        />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: Spacing.base,
    gap: Spacing.base,
  },
  header: {
    gap: Spacing.xs,
  },
  card: {
    padding: Spacing.base,
    gap: Spacing.xs,
  },
  signOutButton: {
    marginTop: Spacing.md,
  },
});
