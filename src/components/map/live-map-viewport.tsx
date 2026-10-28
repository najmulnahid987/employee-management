/**
 * Dispatcher Live Map Viewport (Native)
 *
 * Implements M12.4 Native Map UI:
 * - GoogleMaps.View on Android (Maps SDK for Android).
 * - AppleMaps.View on iOS (Apple Maps via SwiftUI).
 * - Renders markers strictly for workers with valid, fresh coordinates on operational jobs.
 * - Restrained marker colors and M9 lifecycle labels: Travelling, Arrived, Working.
 * - Pure data binding: zero sample markers or hardcoded fallback coordinates.
 * - Never prompts owner for GPS permission (isMyLocationEnabled: false).
 * - Meaningful error/setup state if Google Maps API key or native dev build is missing.
 * - Empty state when no eligible workers have usable live coordinates.
 * - Stable camera position preventing camera reset loops on telemetry refreshes.
 */

import Constants, { AppOwnership, ExecutionEnvironment } from 'expo-constants';
import { AppleMaps, GoogleMaps } from 'expo-maps';
import React, { useMemo } from 'react';
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

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
  emptyState,
  initialCoordinates,
  zoom = 13,
  selectedWorkerId,
  onSelectMarker,
}: LiveMapViewportProps) {
  const theme = useTheme();

  // Stable initial camera position to prevent resetting camera on telemetry refreshes
  const cameraPosition = useMemo(() => {
    if (initialCoordinates) {
      return { coordinates: initialCoordinates, zoom };
    }
    const firstValid = items.find(
      (item) =>
        item.workerLatitude !== null &&
        item.workerLongitude !== null &&
        Number.isFinite(item.workerLatitude) &&
        Number.isFinite(item.workerLongitude)
    );
    if (firstValid && firstValid.workerLatitude !== null && firstValid.workerLongitude !== null) {
      return {
        coordinates: {
          latitude: firstValid.workerLatitude,
          longitude: firstValid.workerLongitude,
        },
        zoom,
      };
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1. Check if running in standard Expo Go (which lacks native expo-maps binaries)
  const isExpoGo =
    Constants.appOwnership === AppOwnership.Expo ||
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

  if (isExpoGo) {
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
        <View style={styles.warningBadge}>
          <ThemedText type="caption" style={{ color: Palette.amberText, fontWeight: '600' }}>
            DEVELOPMENT BUILD REQUIRED
          </ThemedText>
        </View>
        <ThemedText type="bodyMedium" style={{ fontWeight: '600', marginTop: Spacing.xs }}>
          Native Map Requires Custom Dev Build
        </ThemedText>
        <ThemedText
          type="caption"
          themeColor="textSecondary"
          style={{ textAlign: 'center', maxWidth: 360 }}>
          expo-maps requires a custom development build (npx expo run:android or npx expo run:ios).
          Field worker telemetry is active and listed below.
        </ThemedText>
      </View>
    );
  }

  // 2. Check Android Google Maps API Key configuration
  const isAndroid = Platform.OS === 'android';
  const googleMapsApiKey =
    process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ||
    (Constants.expoConfig?.android?.config as { googleMaps?: { apiKey?: string } } | undefined)
      ?.googleMaps?.apiKey ||
    '';

  if (isAndroid && !googleMapsApiKey) {
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
        <View style={styles.warningBadge}>
          <ThemedText type="caption" style={{ color: Palette.amberText, fontWeight: '600' }}>
            CONFIGURATION REQUIRED
          </ThemedText>
        </View>
        <ThemedText type="bodyMedium" style={{ fontWeight: '600', marginTop: Spacing.xs }}>
          Google Maps API Key Missing
        </ThemedText>
        <ThemedText
          type="caption"
          themeColor="textSecondary"
          style={{ textAlign: 'center', maxWidth: 360 }}>
          Android requires a Google Maps API key to render native tiles. Set
          EXPO_PUBLIC_GOOGLE_MAPS_API_KEY in your environment. Telemetry data remains accessible
          below.
        </ThemedText>
      </View>
    );
  }

  // 3. Filter valid live marker items strictly (Requirement 2 & 4: zero fake pins)
  const validLiveItems = items.filter(
    (item) =>
      item.isLive &&
      item.workerLatitude !== null &&
      item.workerLongitude !== null &&
      !isNaN(item.workerLatitude) &&
      !isNaN(item.workerLongitude)
  );

  // 4. Empty State: No eligible workers currently have a usable live fix
  if (validLiveItems.length === 0) {
    if (emptyState) {
      return <View style={[styles.wrapper, style]}>{emptyState}</View>;
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
          Live markers appear when technicians enter field travel (Travelling) or arrive on site
          with active GPS telemetry.
        </ThemedText>
      </View>
    );
  }

  // 6. Native Map Rendering with Error Boundary
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
              MAP INITIALIZATION FAILED
            </ThemedText>
          </View>
          <ThemedText type="bodyMedium" style={{ fontWeight: '600', marginTop: Spacing.xs }}>
            Unable to display native map
          </ThemedText>
          <ThemedText
            type="caption"
            themeColor="textSecondary"
            style={{ textAlign: 'center', maxWidth: 360 }}>
            {msg}
          </ThemedText>
        </View>
      )}>
      <View style={[styles.wrapper, style]}>
        {isAndroid ? (
          <GoogleMaps.View
            style={StyleSheet.absoluteFill}
            cameraPosition={cameraPosition}
            markers={validLiveItems.map((item) => {
              const statusLabel = getMapLifecycleStatusLabel(item.jobStatus);
              return {
                id: item.workerId,
                coordinates: {
                  latitude: item.workerLatitude!,
                  longitude: item.workerLongitude!,
                },
                title: `${item.workerName} • ${statusLabel}`,
                snippet: item.jobService
                  ? `${item.jobService}${item.jobAddress ? ` — ${item.jobAddress}` : ''}`
                  : item.jobAddress || '',
                showCallout: true,
              };
            })}
            properties={{
              isMyLocationEnabled: false,
            }}
            uiSettings={{
              myLocationButtonEnabled: false,
              compassEnabled: true,
            }}
            onMarkerClick={(marker) => {
              if (marker.id) {
                onSelectMarker?.(marker.id);
              }
            }}
          />
        ) : (
          <AppleMaps.View
            style={StyleSheet.absoluteFill}
            cameraPosition={cameraPosition}
            markers={validLiveItems.map((item) => {
              const statusLabel = getMapLifecycleStatusLabel(item.jobStatus);
              const color =
                item.jobStatus && item.jobStatus in MAP_STATUS_COLORS
                  ? MAP_STATUS_COLORS[item.jobStatus as keyof typeof MAP_STATUS_COLORS]
                  : '#1D4ED8';
              const initial = item.workerName ? item.workerName.charAt(0).toUpperCase() : 'W';

              return {
                id: item.workerId,
                coordinates: {
                  latitude: item.workerLatitude!,
                  longitude: item.workerLongitude!,
                },
                title: `${item.workerName} • ${statusLabel}`,
                monogram: initial,
                tintColor: color,
              };
            })}
            properties={{
              isMyLocationEnabled: false,
            }}
            uiSettings={{
              myLocationButtonEnabled: false,
              compassEnabled: true,
            }}
            onMarkerClick={(marker) => {
              if (marker.id) {
                onSelectMarker?.(marker.id);
              }
            }}
          />
        )}
      </View>
    </MapNativeErrorBoundary>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    overflow: 'hidden',
    borderRadius: Radii.md,
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
  neutralBadge: {
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radii.pill,
  },
});
