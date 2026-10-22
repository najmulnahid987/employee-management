import { router } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function WorkerJobsScreen() {
  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">My Assigned Jobs</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            All service assignments dispatched to you.
          </ThemedText>
        </View>

        <EmptyState
          title="No Assigned Jobs"
          description="You do not have any upcoming or past completed jobs in your personal queue yet."
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
