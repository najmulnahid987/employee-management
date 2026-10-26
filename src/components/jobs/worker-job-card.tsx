import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Card, StatusBadge } from '@/components/ui';
import { JobStatus, Palette, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatScheduledTime, Job } from '@/lib/jobs';

export interface WorkerJobCardProps {
  job: Job;
  onPress?: (job: Job) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  isHero?: boolean;
}

export function WorkerJobCard({ job, onPress, style, testID, isHero }: WorkerJobCardProps) {
  const theme = useTheme();

  const handlePress = onPress ? () => onPress(job) : undefined;
  const scheduledTimeStr = formatScheduledTime(job.scheduled_at);
  const isAssignedPending = job.status === 'assigned';
  const isActive =
    job.status === 'on_the_way' || job.status === 'arrived' || job.status === 'in_progress';

  return (
    <Card
      variant="surface"
      onPress={handlePress}
      style={[
        styles.card,
        isHero && styles.heroCard,
        isAssignedPending && {
          borderColor: Palette.amberBorder,
        },
        style,
      ]}
      testID={testID}>
      {/* Top Header: Service Scope & Status Badge */}
      <View style={styles.headerRow}>
        <ThemedText
          type={isHero ? 'title' : 'headline'}
          style={styles.serviceTitle}
          numberOfLines={1}>
          {job.service}
        </ThemedText>
        <StatusBadge status={job.status as JobStatus} size="sm" />
      </View>

      {/* Customer Name & Scheduled Time */}
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

      {/* Footer Banner for Action Required or Active Visit */}
      {isAssignedPending ? (
        <View style={[styles.actionBanner, { backgroundColor: Palette.amberBg }]}>
          <View style={[styles.statusDot, { backgroundColor: Palette.amberText }]} />
          <ThemedText type="captionMedium" style={{ color: Palette.amberText }}>
            Action Required: Accept or Decline Assignment
          </ThemedText>
        </View>
      ) : isActive ? (
        <View style={[styles.actionBanner, { backgroundColor: Palette.blueBg }]}>
          <View style={[styles.statusDot, { backgroundColor: Palette.blueText }]} />
          <ThemedText type="captionMedium" style={{ color: Palette.blueText }}>
            Active Service Visit in Progress
          </ThemedText>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: Spacing.base,
    gap: Spacing.xs + 2,
  },
  heroCard: {
    borderWidth: 1.5,
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
  actionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    borderRadius: Radii.sm,
    marginTop: Spacing.xs,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: Radii.full,
  },
});
