import React from 'react';
import {
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';

import {
  JobStatus,
  Radii,
  Spacing,
  StatusColors,
  Typography,
} from '@/constants/theme';

export type StatusBadgeSize = 'sm' | 'md';

export interface StatusBadgeProps {
  status: JobStatus;
  label?: string;
  size?: StatusBadgeSize;
  showDot?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function StatusBadge({
  status,
  label,
  size = 'md',
  showDot = true,
  style,
}: StatusBadgeProps) {
  const config = StatusColors[status] ?? StatusColors.unassigned;
  const displayLabel = label ?? config.label;

  return (
    <View
      style={[
        styles.badge,
        badgeSizes[size],
        {
          backgroundColor: config.background,
          borderColor: config.border,
        },
        style,
      ]}>
      {showDot && (
        <View
          style={[
            styles.dot,
            dotSizes[size],
            { backgroundColor: config.dot },
          ]}
        />
      )}
      <Text
        style={[
          styles.label,
          labelSizes[size],
          { color: config.text },
        ]}>
        {displayLabel}
      </Text>
    </View>
  );
}

const badgeSizes: Record<StatusBadgeSize, ViewStyle> = {
  md: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    gap: Spacing.xs,
  },
  sm: {
    paddingHorizontal: Spacing.xs + 2,
    paddingVertical: 2,
    gap: 4,
  },
};

const dotSizes: Record<StatusBadgeSize, ViewStyle> = {
  md: {
    width: 6,
    height: 6,
  },
  sm: {
    width: 5,
    height: 5,
  },
};

const labelSizes: Record<StatusBadgeSize, TextStyle> = {
  md: {
    ...Typography.captionMedium,
    fontSize: 12,
    lineHeight: 16,
  },
  sm: {
    ...Typography.caption,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '500',
  },
};

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: Radii.pill,
    borderWidth: 1,
  },
  dot: {
    borderRadius: Radii.full,
  },
  label: {
    fontWeight: '600',
  },
});
