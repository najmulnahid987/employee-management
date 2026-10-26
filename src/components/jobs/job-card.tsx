import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Card, StatusBadge } from '@/components/ui';
import { JobStatus, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatScheduledTime, JobWithWorker } from '@/lib/jobs';

export interface JobCardProps {
  job: JobWithWorker;
  onPress?: (job: JobWithWorker) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function JobCard({ job, onPress, style, testID }: JobCardProps) {
  const theme = useTheme();

  const handlePress = onPress ? () => onPress(job) : undefined;
  const scheduledTimeStr = formatScheduledTime(job.scheduled_at);
  const workerName = job.worker?.full_name?.trim();

  return (
    <Card
      variant="surface"
      onPress={handlePress}
      style={[styles.card, style]}
      testID={testID}>
      {/* Top Header: Service Scope & Status Badge */}
      <View style={styles.headerRow}>
        <ThemedText type="headline" style={styles.serviceTitle} numberOfLines={1}>
          {job.service}
        </ThemedText>
        <StatusBadge status={job.status as JobStatus} size="sm" />
      </View>

      {/* Customer & Scheduled Time */}
      <View style={styles.detailsRow}>
        <ThemedText type="bodyMedium" numberOfLines={1} style={styles.customerName}>
          {job.customer_name}
        </ThemedText>
        <ThemedText type="caption" themeColor="textSecondary" style={styles.timeText}>
          {scheduledTimeStr}
        </ThemedText>
      </View>

      {/* Physical Service Address */}
      <View style={styles.addressContainer}>
        <ThemedText
          type="caption"
          themeColor="textSecondary"
          numberOfLines={2}
          style={styles.addressText}>
          {job.address}
        </ThemedText>
      </View>

      {/* Footer: Assigned Field Technician or Clear Unassigned Warning */}
      <View style={[styles.footerRow, { borderTopColor: theme.borderSubtle }]}>
        <ThemedText type="label" themeColor="textSecondary">
          TECHNICIAN
        </ThemedText>
        {workerName ? (
          <View style={styles.workerBadge}>
            <View style={[styles.workerDot, { backgroundColor: theme.primary }]} />
            <ThemedText type="captionMedium" numberOfLines={1}>
              {workerName}
            </ThemedText>
          </View>
        ) : (
          <View style={[styles.unassignedBadge, { backgroundColor: theme.surfaceSecondary }]}>
            <ThemedText type="label" themeColor="textSecondary">
              Unassigned
            </ThemedText>
          </View>
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: Spacing.base,
    gap: Spacing.xs + 2,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  serviceTitle: {
    flex: 1,
  },
  detailsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: Spacing.sm,
  },
  customerName: {
    flex: 1,
  },
  timeText: {
    fontWeight: '500',
  },
  addressContainer: {
    marginTop: 2,
  },
  addressText: {
    lineHeight: 18,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: Spacing.xs,
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
  },
  workerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '65%',
  },
  workerDot: {
    width: 6,
    height: 6,
    borderRadius: Radii.full,
  },
  unassignedBadge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radii.pill,
  },
});
