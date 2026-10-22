import { router } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function WorkerProfileScreen() {
  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Worker Profile</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Your technician account details and application settings.
          </ThemedText>
        </View>

        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Account Information</ThemedText>
          <ThemedText type="body">Technician Member</ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Role: Field Worker
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Account: worker@business.com
          </ThemedText>
        </Card>

        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Application Info</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Dispatcher Mobile App v1.0.0
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
