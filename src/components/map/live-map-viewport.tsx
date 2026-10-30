/**
 * Dispatcher Live Map Viewport (Native)
 *
 * Implements M12.4 Native Map UI via react-native-maps:
 * - MapView and Marker on iOS (Apple Maps) and Android.
 * - Always renders the native map viewport so the owner has full territory visibility.
 * - Renders markers for field technicians with valid coordinates on operational visits.
 * - Status-coded marker pins: Travelling (Blue), Arrived (Cyan), Working (Orange), Stale (Amber).
 * - Floating status badge displays active technician count.
 * - Tapping a marker triggers onSelectMarker to open LiveMapBottomSheet.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';

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

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class MapNativeErrorBoundary extends React.Component<
  {
    children: React.ReactNode;
    fallback: (message: string) => React.ReactNode;
  },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, errorMessage: '' };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'Native map view failed to load.',
    };
  }

  componentDidCatch(_error: Error) {
    // Catch native module exceptions without crashing the screen
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback(this.state.errorMessage);
    }
    return this.props.children;
  }
}

export function LiveMapViewport({
  style,
  items = [],
  initialCoordinates,
  selectedWorkerId,
  onSelectMarker,
}: LiveMapViewportProps) {
  const theme = useTheme();
  const mapRef = useRef<MapView | null>(null);

  // Filter valid items with actual coordinates
  const validLiveItems = useMemo(
    () =>
      items.filter(
        (item) =>
          item.workerLatitude !== null &&
          item.workerLongitude !== null &&
          !isNaN(item.workerLatitude) &&
          !isNaN(item.workerLongitude)
      ),
    [items]
  );

  // Stable initial region
  const initialRegion = useMemo(() => {
    if (initialCoordinates) {
      return {
        latitude: initialCoordinates.latitude,
        longitude: initialCoordinates.longitude,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      };
    }
    const firstValid = validLiveItems[0];
    if (firstValid && firstValid.workerLatitude && firstValid.workerLongitude) {
      return {
        latitude: firstValid.workerLatitude,
        longitude: firstValid.workerLongitude,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      };
    }
    // Default territory center (e.g. SF Metro)
    return {
      latitude: 37.7749,
      longitude: -122.4194,
      latitudeDelta: 0.08,
      longitudeDelta: 0.08,
    };
  }, [initialCoordinates, validLiveItems]);

  // Fit camera bounds when live markers change
  useEffect(() => {
    if (mapRef.current && validLiveItems.length > 0) {
      const coords = validLiveItems.map((item) => ({
        latitude: item.workerLatitude!,
        longitude: item.workerLongitude!,
      }));
      if (coords.length === 1) {
        mapRef.current.animateToRegion(
          {
            latitude: coords[0].latitude,
            longitude: coords[0].longitude,
            latitudeDelta: 0.02,
            longitudeDelta: 0.02,
          },
          400
        );
      } else {
        mapRef.current.fitToCoordinates(coords, {
          edgePadding: { top: 50, right: 50, bottom: 50, left: 50 },
          animated: true,
        });
      }
    }
  }, [validLiveItems]);

  return (
    <MapNativeErrorBoundary
      fallback={(msg) => (
        <View
          style={[
            styles.container,
            {
              backgroundColor: theme.surfaceSecondary,
              borderColor: theme.border,
            },
            style,
          ]}>
          <View style={styles.warningBadge}>
            <ThemedText type="caption" style={{ color: Palette.amberText, fontWeight: '600' }}>
              MAP NOTICE
            </ThemedText>
          </View>
          <ThemedText type="bodyMedium" style={{ fontWeight: '600', marginTop: Spacing.xs }}>
            Unable to initialize native map view
          </ThemedText>
          <ThemedText
            type="caption"
            themeColor="textSecondary"
            style={{ textAlign: 'center', maxWidth: 360 }}>
            {msg}
          </ThemedText>
        </View>
      )}>
      <View style={[styles.wrapper, { borderColor: theme.border }, style]}>
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          provider={PROVIDER_DEFAULT}
          initialRegion={initialRegion}
          showsUserLocation={false}
          showsMyLocationButton={false}
          showsCompass={true}>
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
              <Marker
                key={item.workerId}
                identifier={item.workerId}
                coordinate={{
                  latitude: item.workerLatitude!,
                  longitude: item.workerLongitude!,
                }}
                title={`${item.workerName} • ${statusLabel}`}
                description={
                  item.jobService
                    ? `${item.jobService}${item.jobAddress ? ` — ${item.jobAddress}` : ''}`
                    : item.jobAddress || ''
                }
                pinColor={isSelected ? '#171717' : color}
                onPress={() => {
                  onSelectMarker?.(item.workerId);
                }}
              />
            );
          })}
        </MapView>

        {/* Floating Status Badge Overlay */}
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
    </MapNativeErrorBoundary>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    height: 320,
    borderRadius: Radii.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
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
  warningBadge: {
    backgroundColor: Palette.amberBg,
    borderColor: Palette.amberBorder,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radii.pill,
  },
  floatingOverlay: {
    position: 'absolute',
    top: Spacing.sm,
    left: Spacing.sm,
    right: Spacing.sm,
    alignItems: 'center',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    borderRadius: Radii.full,
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  pulsingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
