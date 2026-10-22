import { router } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function OwnerJobsScreen() {
  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">All Jobs</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Filter and track all service jobs across lifecycle stages.
          </ThemedText>
        </View>

        <EmptyState
          title="No Jobs Recorded"
          description="There are currently no dispatch jobs in your business. Tap below to create and assign your first service visit."
          actionLabel="+ Create Job"
          onAction={() => router.push('/owner/create-job')}
        />

        {/* Development test shortcut to stack screen */}
        <Card variant="subtle" style={styles.devCard}>
          <ThemedText type="label" themeColor="textSecondary">
            STACK ROUTE PREVIEW
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary" style={styles.devText}>
            Directly inspect the Owner Job Details screen:
          </ThemedText>
          <Button
            label="Open Owner Job Details Placeholder"
            variant="outline"
            size="sm"
            onPress={() => router.push('/owner/job-details')}
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
