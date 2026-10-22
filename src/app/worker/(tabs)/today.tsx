import { router } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function WorkerTodayScreen() {
  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Today's Schedule</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Your active service assignments and execution queue.
          </ThemedText>
        </View>

        <EmptyState
          title="You're All Caught Up"
          description="No jobs are currently scheduled for you today. New service dispatches from your business owner will appear here."
        />

        {/* Development test shortcut to stack screen */}
        <Card variant="subtle" style={styles.devCard}>
          <ThemedText type="label" themeColor="textSecondary">
            STACK ROUTE PREVIEW
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary" style={styles.devText}>
            Inspect the field execution Worker Job Details screen:
          </ThemedText>
          <Button
            label="Open Worker Job Details Placeholder"
            variant="outline"
            size="sm"
            onPress={() => router.push('/worker/job-details')}
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
