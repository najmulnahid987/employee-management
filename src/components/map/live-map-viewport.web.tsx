/**
 * Dispatcher Live Map Viewport (Web)
 *
 * Interactive web map viewport using OpenStreetMap:
 * - Always renders the territory map so the owner has full visibility.
 * - Renders active technician indicators with status colors.
 * - Provides interactive pan/zoom OpenStreetMap tiles.
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
  initialCoordinates,
  selectedWorkerId,
  onSelectMarker,
}: LiveMapViewportProps) {
  const theme = useTheme();

  const validLiveItems = items.filter(
    (item) =>
      item.workerLatitude !== null &&
      item.workerLongitude !== null &&
      !isNaN(item.workerLatitude) &&
      !isNaN(item.workerLongitude)
  );

  // Calculate center coordinates
  let centerLat = 37.7749;
  let centerLon = -122.4194;

  if (initialCoordinates) {
    centerLat = initialCoordinates.latitude;
    centerLon = initialCoordinates.longitude;
  } else if (validLiveItems.length > 0) {
    centerLat =
      validLiveItems.reduce((acc, curr) => acc + curr.workerLatitude!, 0) / validLiveItems.length;
    centerLon =
      validLiveItems.reduce((acc, curr) => acc + curr.workerLongitude!, 0) / validLiveItems.length;
  }

  const osmSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${centerLon - 0.04}%2C${
    centerLat - 0.03
  }%2C${centerLon + 0.04}%2C${centerLat + 0.03}&layer=mapnik&marker=${centerLat}%2C${centerLon}`;

  return (
    <View
      style={[
        styles.webContainer,
        {
          backgroundColor: theme.surfaceSecondary,
          borderColor: theme.border,
        },
        style,
      ]}>
      {/* Mini Marker Indicators Bar (if active workers exist) */}
      {validLiveItems.length > 0 ? (
        <View style={styles.markersSummary}>
          {validLiveItems.map((item) => {
            const statusLabel = getMapLifecycleStatusLabel(item.jobStatus);
            let color =
              item.jobStatus && item.jobStatus in MAP_STATUS_COLORS
                ? MAP_STATUS_COLORS[item.jobStatus as keyof typeof MAP_STATUS_COLORS]
                : '#16A34A';

            if (item.isStale) {
              color = '#D97706';
            }

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
      ) : null}

      {/* Interactive Web Map Viewport */}
      <View style={styles.iframeWrapper}>
        <iframe
          title="Owner Live Territory Map"
          width="100%"
          height="100%"
          style={{ border: 'none', borderRadius: 8 }}
          src={osmSrc}
        />

        {/* Floating Status Pill */}
        <View style={styles.floatingOverlay}>
          {validLiveItems.length > 0 ? (
            <View style={[styles.statusBadge, { backgroundColor: theme.surface }]}>
              <View style={[styles.pulsingDot, { backgroundColor: Palette.blueText }]} />
              <ThemedText type="caption" style={{ fontWeight: '700', color: Palette.blueText }}>
                {validLiveItems.length} LIVE TECHNICIAN{validLiveItems.length === 1 ? '' : 'S'}
              </ThemedText>
            </View>
          ) : (
            <View style={[styles.statusBadge, { backgroundColor: theme.surface }]}>
              <ThemedText type="caption" style={{ fontWeight: '600', color: theme.textSecondary }}>
                📍 Territory Map • 0 Technicians Currently Active
              </ThemedText>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  webContainer: {
    height: 340,
    borderRadius: Radii.md,
    borderWidth: 1,
    overflow: 'hidden',
    padding: Spacing.xs,
  },
  markersSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.xs,
    paddingBottom: Spacing.xs,
  },
  markerTag: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: Radii.pill,
    gap: 6,
  },
  markerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  iframeWrapper: {
    flex: 1,
    borderRadius: Radii.sm,
    overflow: 'hidden',
    position: 'relative',
  },
  floatingOverlay: {
    position: 'absolute',
    top: Spacing.xs,
    left: Spacing.xs,
    right: Spacing.xs,
    alignItems: 'center',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 5,
    borderRadius: Radii.full,
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  pulsingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
