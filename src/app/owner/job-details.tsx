import { router } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, ScreenContainer, StatusBadge } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function OwnerJobDetailsScreen() {
  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        {/* Status Header */}
        <View style={styles.statusRow}>
          <StatusBadge status="unassigned" size="md" />
          <ThemedText type="caption" themeColor="textSecondary">
            Job #JOB-1001
          </ThemedText>
        </View>

        {/* Job Information Card */}
        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Service Details</ThemedText>
          <ThemedText type="body">Emergency pipe leak inspection</ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Address: 123 Service Road, Suite 4
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Customer: Customer Contact Name • (555) 012-3456
          </ThemedText>
        </Card>

        {/* Worker Assignment Card */}
        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Worker Assignment</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            No technician currently assigned to this job.
          </ThemedText>
          <Button
            label="Assign Worker"
            variant="primary"
            onPress={() => router.push('/owner/assign-worker')}
            style={styles.actionButton}
          />
        </Card>

        {/* Cancellation Action */}
        <Button
          label="Cancel Job"
          variant="danger"
          fullWidth
          onPress={() => {
            // Placeholder: Cancellation with mandatory reason in later phase
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
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  card: {
    padding: Spacing.base,
    gap: Spacing.xs,
  },
  actionButton: {
    marginTop: Spacing.sm,
  },
});
