import { router } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, ScreenContainer, StatusBadge } from '@/components/ui';
import { JobStatus, Spacing } from '@/constants/theme';

export default function WorkerJobDetailsScreen() {
  const [currentStatus, setCurrentStatus] = useState<JobStatus>('assigned');

  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        {/* Status Header */}
        <View style={styles.statusRow}>
          <StatusBadge status={currentStatus} size="md" />
          <ThemedText type="caption" themeColor="textSecondary">
            Assigned Visit #JOB-1001
          </ThemedText>
        </View>

        {/* Customer & Address Details */}
        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Service Location & Customer</ThemedText>
          <ThemedText type="body">Emergency Water Leak Service</ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Customer Contact Name • (555) 012-3456
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            742 Evergreen Terrace, Springfield
          </ThemedText>

          {/* Native Launcher Placeholders */}
          <View style={styles.launcherRow}>
            <Button
              label="Call Customer"
              variant="secondary"
              size="sm"
              onPress={() => {
                // Placeholder: Native tel: launcher in later phase
              }}
            />
            <Button
              label="Open in Maps"
              variant="secondary"
              size="sm"
              onPress={() => {
                // Placeholder: Native maps: launcher in later phase
              }}
            />
          </View>
        </Card>

        {/* Job Notes */}
        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Job Instructions</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Check main shutoff valve in basement upon arrival. Customer noted water pooling near hot water tank.
          </ThemedText>
        </Card>

        {/* Permitted Sequential Execution Action */}
        <View style={styles.executionActions}>
          {currentStatus === 'assigned' ? (
            <>
              <Button
                label="Accept Job"
                variant="primary"
                fullWidth
                onPress={() => setCurrentStatus('accepted')}
              />
              <Button
                label="Decline Assignment"
                variant="danger"
                fullWidth
                onPress={() => {
                  // Declining transitions assigned -> unassigned
                  router.back();
                }}
              />
            </>
          ) : currentStatus === 'accepted' ? (
            <Button
              label="I'm On My Way"
              variant="primary"
              fullWidth
              onPress={() => setCurrentStatus('on_the_way')}
            />
          ) : currentStatus === 'on_the_way' ? (
            <Button
              label="Mark Arrived"
              variant="primary"
              fullWidth
              onPress={() => setCurrentStatus('arrived')}
            />
          ) : currentStatus === 'arrived' ? (
            <Button
              label="Start Work"
              variant="primary"
              fullWidth
              onPress={() => setCurrentStatus('in_progress')}
            />
          ) : currentStatus === 'in_progress' ? (
            <Button
              label="Complete Work"
              variant="primary"
              fullWidth
              onPress={() => setCurrentStatus('completed')}
            />
          ) : (
            <ThemedText type="bodyMedium" style={styles.completedNotice}>
              Service visit completed. Terminal state reached.
            </ThemedText>
          )}
        </View>
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
  launcherRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  executionActions: {
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  completedNotice: {
    textAlign: 'center',
    marginVertical: Spacing.sm,
  },
});
