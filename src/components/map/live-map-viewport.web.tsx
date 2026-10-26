/**
 * Dispatcher Live Map Viewport (Web Fallback)
 *
 * Web fallback for Expo Maps:
 * - Prevents runtime crashes from native requireNativeModule('ExpoMaps') on web.
 * - Displays an informative fallback container indicating native map support on iOS/Android.
 * - Truthfully reports the number of active markers and their status without inventing fake map tiles.
 */

import React from 'react';
import { Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  getMapLifecycleStatusLabel,
  MAP_STATUS_COLORS,
  OwnerLiveMapWorkerItem,
} from '@/lib/owner-locations-core';

export interface LiveMapViewportProps {
  style?: StyleProp<ViewStyle>;
  items?: OwnerLiveMapWorkerItem[];
  emptyState?: React.ReactNode;
  initialCoordinates?: {
    latitude: number;
    longitude: number;
  };
  zoom?: number;
  selectedWorkerId?: string | null;
  onSelectMarker?: (workerId: string) => void;
}

export function LiveMapViewport({
  style,
  items = [],
  emptyState,
  selectedWorkerId,
  onSelectMarker,
}: LiveMapViewportProps) {
  const theme = useTheme();

  const validLiveItems = items.filter(
    (item) =>
      item.isLive &&
      item.workerLatitude !== null &&
      item.workerLongitude !== null &&
      !isNaN(item.workerLatitude) &&
      !isNaN(item.workerLongitude)
  );

  if (validLiveItems.length === 0) {
    if (emptyState) {
      return <View style={[styles.container, style]}>{emptyState}</View>;
    }
    return (
      <View
        style={[
          styles.container,
          {
            backgroundColor: theme.surfaceSecondary,
            borderColor: theme.border,
          },
          style,
        ]}>
        <View
          style={[
            styles.neutralBadge,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}>
          <ThemedText type="caption" themeColor="textSecondary" style={{ fontWeight: '600' }}>
            NO LIVE FIXES
          </ThemedText>
        </View>
        <ThemedText type="bodyMedium" style={{ fontWeight: '600', marginTop: Spacing.xs }}>
          No Active Worker Markers
        </ThemedText>
        <ThemedText
          type="caption"
          themeColor="textSecondary"
          style={{ textAlign: 'center', maxWidth: 360 }}>
          Live markers appear when technicians enter field travel (Travelling) or arrive on site with active GPS telemetry.
        </ThemedText>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.surfaceSecondary,
          borderColor: theme.border,
        },
        style,
      ]}>
      <View style={styles.badge}>
        <ThemedText type="caption" style={{ color: Palette.blueText, fontWeight: '600' }}>
          LIVE WEB VIEWPORT • {validLiveItems.length} ACTIVE FIX{validLiveItems.length === 1 ? '' : 'ES'}
        </ThemedText>
      </View>
      <ThemedText type="bodyMedium" style={{ fontWeight: '600', marginTop: Spacing.xs }}>
        Native Map (Google Maps on Android / Apple Maps on iOS)
      </ThemedText>
      <ThemedText
        type="caption"
        themeColor="textSecondary"
        style={{ textAlign: 'center', maxWidth: 420 }}>
        The interactive live territory map renders natively on mobile devices. Review real-time worker telemetry and destinations below.
      </ThemedText>

      {/* Mini Marker Indicators */}
      <View style={styles.markersSummary}>
        {validLiveItems.map((item) => {
          const statusLabel = getMapLifecycleStatusLabel(item.jobStatus);
          const color =
            item.jobStatus && item.jobStatus in MAP_STATUS_COLORS
              ? MAP_STATUS_COLORS[item.jobStatus as keyof typeof MAP_STATUS_COLORS]
              : '#1D4ED8';

          const isSelected = selectedWorkerId === item.workerId;

          return (
            <Pressable
              key={item.workerId}
              onPress={() => onSelectMarker?.(item.workerId)}
              style={[
                styles.markerTag,
                {
                  borderColor: isSelected ? Palette.blueText : theme.border,
                  backgroundColor: isSelected ? Palette.blueBg : theme.surface,
                  borderWidth: isSelected ? 2 : 1,
                },
              ]}>
              <View style={[styles.markerDot, { backgroundColor: color }]} />
              <ThemedText type="caption" style={{ fontWeight: '600' }}>
                {item.workerName}
              </ThemedText>
              <ThemedText type="caption" style={{ color }}>
                ({statusLabel})
              </ThemedText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 240,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.base,
    gap: Spacing.xs,
  },
  badge: {
    backgroundColor: Palette.blueBg,
    borderColor: Palette.blueBorder,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radii.pill,
  },
  neutralBadge: {
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radii.pill,
  },
  markersSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.xs,
    justifyContent: 'center',
    marginTop: Spacing.xs,
  },
  markerTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radii.pill,
    borderWidth: 1,
  },
  markerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
