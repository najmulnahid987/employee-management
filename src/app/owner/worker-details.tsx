import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function WorkerDetailsScreen() {
  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Worker Profile</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Technician contact details and assignment activity.
          </ThemedText>
        </View>

        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Technician Information</ThemedText>
          <ThemedText type="body">Technician Name Placeholder</ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Status: Active Member
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Contact: worker@business.com • (555) 018-4729
          </ThemedText>
        </Card>

        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Active Assignments</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            No active jobs currently assigned to this worker.
          </ThemedText>
        </Card>

        <Button
          label="Edit Worker"
          variant="outline"
          fullWidth
          onPress={() => {
            // Placeholder: Worker profile editing
          }}
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
});
