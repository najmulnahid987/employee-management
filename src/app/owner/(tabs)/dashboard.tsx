import { router } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function OwnerDashboardScreen() {
  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Operations Dashboard</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Real-time overview of current service jobs and team availability.
          </ThemedText>
        </View>

        <EmptyState
          title="No Active Operations"
          description="You do not have any jobs scheduled or active today. Create a new service job to dispatch your field technicians."
          actionLabel="+ Create Job"
          onAction={() => router.push('/owner/create-job')}
        />

        {/* Development test shortcut to stack screen */}
        <Card variant="subtle" style={styles.devCard}>
          <ThemedText type="label" themeColor="textSecondary">
            STACK ROUTE PREVIEW
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary" style={styles.devText}>
            Inspect owner detail screens that are normally accessed from active items:
          </ThemedText>
          <View style={styles.devButtons}>
            <Button
              label="Preview Owner Job Details"
              variant="outline"
              size="sm"
              onPress={() => router.push('/owner/job-details')}
            />
            <Button
              label="Preview Assign Worker Modal"
              variant="outline"
              size="sm"
              onPress={() => router.push('/owner/assign-worker')}
            />
          </View>
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
  devButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
});
