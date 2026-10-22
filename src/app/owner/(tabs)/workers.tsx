import { router } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function OwnerWorkersScreen() {
  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Field Workers</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Manage field technicians and view team assignments.
          </ThemedText>
        </View>

        <EmptyState
          title="No Workers on Your Team"
          description="You haven't added any technicians to your business roster yet. Invite workers to start assigning jobs."
          actionLabel="+ Invite Worker"
          onAction={() => router.push('/owner/setup')}
        />

        {/* Development test shortcut to stack screen */}
        <Card variant="subtle" style={styles.devCard}>
          <ThemedText type="label" themeColor="textSecondary">
            STACK ROUTE PREVIEW
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary" style={styles.devText}>
            Inspect the individual Worker Details screen:
          </ThemedText>
          <Button
            label="Open Worker Details Placeholder"
            variant="outline"
            size="sm"
            onPress={() => router.push('/owner/worker-details')}
          />
        </Card>
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
  devCard: {
    padding: Spacing.base,
    marginTop: Spacing.lg,
  },
  devText: {
    marginVertical: Spacing.xs,
  },
});
