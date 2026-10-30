import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface JobLocationMapPickerProps {
  coordinates: Coordinates | null;
  onCoordinatesChange: (coords: Coordinates) => void;
  address?: string;
  isGeocoding?: boolean;
  onFindAddressOnMap?: () => void;
  onUseCurrentLocation?: () => void;
}

export function JobLocationMapPicker({
  coordinates,
  address,
  isGeocoding = false,
  onFindAddressOnMap,
  onUseCurrentLocation,
}: JobLocationMapPickerProps) {
  const theme = useTheme();

  const iframeSrc = coordinates
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${coordinates.longitude - 0.008}%2C${
        coordinates.latitude - 0.005
      }%2C${coordinates.longitude + 0.008}%2C${
        coordinates.latitude + 0.005
      }&layer=mapnik&marker=${coordinates.latitude}%2C${coordinates.longitude}`
    : '';

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.titleWithBadge}>
          <ThemedText type="captionMedium" style={{ fontWeight: '700' }}>
            LOCATION PIN ON MAP
          </ThemedText>
          {coordinates ? (
            <View style={styles.pinnedBadge}>
              <View style={styles.pinnedDot} />
              <ThemedText type="caption" style={{ color: Palette.greenText, fontWeight: '600' }}>
                PINNED
              </ThemedText>
            </View>
          ) : (
            <View style={styles.unpinnedBadge}>
              <ThemedText type="caption" style={{ color: theme.textSecondary }}>
                NOT PINNED
              </ThemedText>
            </View>
          )}
        </View>

        {onUseCurrentLocation ? (
          <Pressable
            onPress={onUseCurrentLocation}
            style={({ pressed }) => [styles.linkAction, { opacity: pressed ? 0.7 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel="Use device location">
            <ThemedText type="caption" style={{ color: Palette.blueText, fontWeight: '600' }}>
              📍 My Location
            </ThemedText>
          </Pressable>
        ) : null}
      </View>

      {coordinates ? (
        <View style={[styles.mapWrapper, { borderColor: theme.border }]}>
          {/* Web iframe embed for OpenStreetMap */}
          <iframe
            title="Service Location Map"
            width="100%"
            height="100%"
            style={{ border: 'none', borderRadius: 8 }}
            src={iframeSrc}
          />

          <View style={[styles.coordsBanner, { backgroundColor: theme.surface }]}>
            <View style={styles.coordsInfo}>
              <ThemedText type="caption" style={{ fontWeight: '600' }}>
                {coordinates.latitude.toFixed(5)}°, {coordinates.longitude.toFixed(5)}°
              </ThemedText>
              <ThemedText type="caption" themeColor="textSecondary" style={{ fontSize: 11 }}>
                {address || 'Service site address'}
              </ThemedText>
            </View>
          </View>
        </View>
      ) : (
        <View
          style={[
            styles.emptyMapContainer,
            { backgroundColor: theme.surfaceSecondary, borderColor: theme.border },
          ]}>
          <ThemedText type="caption" themeColor="textSecondary" style={{ textAlign: 'center' }}>
            {isGeocoding
              ? 'Finding address coordinates on map...'
              : 'Enter the service address above and tap 📍 to locate it on the map.'}
          </ThemedText>
          {onFindAddressOnMap ? (
            <Button
              label={isGeocoding ? 'Locating...' : 'Locate Address on Map'}
              variant="outline"
              size="sm"
              loading={isGeocoding}
              onPress={onFindAddressOnMap}
              style={{ marginTop: Spacing.sm }}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: Spacing.xs,
    marginBottom: Spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  titleWithBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  pinnedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Palette.greenBg,
    borderColor: Palette.greenBorder,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radii.full,
    gap: 4,
  },
  pinnedDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Palette.greenText,
  },
  unpinnedBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radii.full,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  linkAction: {
    paddingVertical: 2,
    paddingHorizontal: 6,
  },
  mapWrapper: {
    height: 190,
    borderRadius: Radii.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  coordsBanner: {
    position: 'absolute',
    bottom: Spacing.xs,
    left: Spacing.xs,
    right: Spacing.xs,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    borderRadius: Radii.sm,
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  coordsInfo: {
    flex: 1,
  },
  emptyMapContainer: {
    padding: Spacing.md,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

