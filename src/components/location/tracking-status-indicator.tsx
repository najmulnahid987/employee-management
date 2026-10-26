/**
 * Dispatcher Live Location Tracking Indicator
 *
 * Truthful, real-time indicator displayed on the technician's job execution screen.
 *
 * Invariants:
 * - Never fakes location or displays old fixes as live.
 * - Truthfully reports upload state, accuracy, and throttling modes.
 * - Accurately conveys degraded states: accuracy warnings, disabled services, denied permissions, and network errors.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Card } from '@/components/ui';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { RawCoordinates } from '@/lib/location-tracker-core';
import { LocationPermissionState } from '@/lib/location-policy';

export interface TrackingStatusIndicatorProps {
  isTracking: boolean;
  isBackgroundActive?: boolean;
  trackingMode: 'INACTIVE' | 'HIGH_FREQUENCY' | 'LOW_FREQUENCY';
  lastPosition: RawCoordinates | null;
  lastSubmittedAt: string | null;
  isWriting: boolean;
  trackingError: string | null;
  permissionState: LocationPermissionState;
}

function formatTimeAgo(isoString: string | null): string {
  if (!isoString) return 'Pending first upload';
  const timestamp = new Date(isoString).getTime();
  if (isNaN(timestamp)) return 'Recently';

  const secondsAgo = Math.floor((Date.now() - timestamp) / 1000);
  if (secondsAgo < 10) return 'Just now';
  if (secondsAgo < 60) return `${secondsAgo}s ago`;
  const minutesAgo = Math.floor(secondsAgo / 60);
  if (minutesAgo < 60) return `${minutesAgo}m ago`;
  return `${Math.floor(minutesAgo / 60)}h ago`;
}

export function TrackingStatusIndicator({
  isTracking,
  isBackgroundActive = false,
  trackingMode,
  lastPosition,
  lastSubmittedAt,
  isWriting,
  trackingError,
  permissionState,
}: TrackingStatusIndicatorProps) {
  const theme = useTheme();

  // 1. Permission Denied / Blocked Notice
  if (permissionState === 'DENIED' || permissionState === 'BLOCKED') {
    return (
      <Card
        variant="surface"
        style={[
          styles.container,
          { backgroundColor: theme.surfaceSecondary, borderColor: theme.border },
        ]}>
        <View style={styles.headerRow}>
          <View style={[styles.statusDot, { backgroundColor: theme.textSecondary }]} />
          <ThemedText type="label" themeColor="textSecondary">
            LOCATION SHARING INACTIVE
          </ThemedText>
        </View>
        <ThemedText type="caption" themeColor="textSecondary" style={styles.detailText}>
          Location permission is disabled. Dispatch will not see live arrival progress, but you can continue updating your job status as normal.
        </ThemedText>
      </Card>
    );
  }

  // 2. Location Services Turned Off at OS Level
  if (permissionState === 'SERVICES_DISABLED') {
    return (
      <Card
        variant="surface"
        style={[
          styles.container,
          { backgroundColor: Palette.amberBg, borderColor: Palette.amberBorder },
        ]}>
        <View style={styles.headerRow}>
          <View style={[styles.statusDot, { backgroundColor: Palette.amberText }]} />
          <ThemedText type="label" style={{ color: Palette.amberText }}>
            DEVICE GPS SERVICES OFF
          </ThemedText>
        </View>
        <ThemedText type="caption" style={[{ color: Palette.amberText }, styles.detailText]}>
          Device location services are turned off. Enable GPS in your device settings to share live arrival progress with dispatch.
        </ThemedText>
      </Card>
    );
  }

  // 3. Active Live Tracking
  if (isTracking) {
    const isTravel = trackingMode === 'HIGH_FREQUENCY';
    const accuracyNumber = lastPosition?.accuracy ? Math.round(lastPosition.accuracy) : null;

    return (
      <Card
        variant="surface"
        style={[
          styles.container,
          { backgroundColor: Palette.blueBg, borderColor: Palette.blueBorder },
        ]}>
        <View style={styles.headerRow}>
          <View style={[styles.statusDot, { backgroundColor: Palette.blueText }]} />
          <ThemedText type="label" style={{ color: Palette.blueText }}>
            LIVE LOCATION SHARING ACTIVE ({isTravel ? 'TRAVEL MODE' : 'ON-SITE MODE'})
          </ThemedText>
        </View>

        <ThemedText type="caption" style={[{ color: Palette.blueText }, styles.detailText]}>
          {isTravel
            ? 'Updating position during travel (target: every ~30s or 50m of movement).'
            : 'Arrival recorded. Updates throttled to low-frequency heartbeat (target: ~3m or 150m).'}
        </ThemedText>

        {/* Telemetry Status Line */}
        <View style={styles.metaRow}>
          <ThemedText type="caption" style={{ color: Palette.blueText }}>
            {isWriting
              ? 'Uploading latest fix...'
              : `Last shared: ${formatTimeAgo(lastSubmittedAt)}${accuracyNumber !== null ? ` (±${accuracyNumber}m)` : ''}`}
          </ThemedText>

          {lastPosition ? (
            <ThemedText type="caption" style={{ color: Palette.blueText, fontVariant: ['tabular-nums'] }}>
              {lastPosition.latitude.toFixed(4)}, {lastPosition.longitude.toFixed(4)}
            </ThemedText>
          ) : null}
        </View>

        {/* Background Location Delivery Badge */}
        <View style={styles.backgroundBadgeRow}>
          <View
            style={[
              styles.backgroundDot,
              { backgroundColor: isBackgroundActive ? '#10B981' : Palette.amberText },
            ]}
          />
          <ThemedText
            type="caption"
            style={{
              color: isBackgroundActive ? Palette.blueText : Palette.amberText,
              fontWeight: '500',
            }}>
            {isBackgroundActive
              ? 'Background updates active (shares location when app is minimized).'
              : 'Foreground only (updates pause when app is closed or minimized).'}
          </ThemedText>
        </View>

        {/* Approximate Accuracy Notice */}
        {permissionState === 'APPROXIMATE' ? (
          <View style={[styles.warningBox, { backgroundColor: Palette.amberBg, borderColor: Palette.amberBorder }]}>
            <ThemedText type="caption" style={{ color: Palette.amberText }}>
              Location sharing is operating in approximate mode. Precise location provides the best dispatch accuracy.
            </ThemedText>
          </View>
        ) : null}

        {/* Transient Error or Accuracy Warning */}
        {trackingError ? (
          <View style={[styles.warningBox, { backgroundColor: Palette.amberBg, borderColor: Palette.amberBorder }]}>
            <ThemedText type="caption" style={{ color: Palette.amberText }}>
              {trackingError}
            </ThemedText>
          </View>
        ) : null}
      </Card>
    );
  }

  // 4. Inactive with error
  if (trackingError) {
    return (
      <Card
        variant="surface"
        style={[
          styles.container,
          { backgroundColor: Palette.amberBg, borderColor: Palette.amberBorder },
        ]}>
        <View style={styles.headerRow}>
          <View style={[styles.statusDot, { backgroundColor: Palette.amberText }]} />
          <ThemedText type="label" style={{ color: Palette.amberText }}>
            LOCATION TRACKING PAUSED
          </ThemedText>
        </View>
        <ThemedText type="caption" style={[{ color: Palette.amberText }, styles.detailText]}>
          {trackingError}
        </ThemedText>
      </Card>
    );
  }

  // 5. Inactive or Idle
  return null;
}

const styles = StyleSheet.create({
  container: {
    padding: Spacing.sm + 2,
    borderRadius: Radii.sm,
    borderWidth: 1,
    gap: 4,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  detailText: {
    lineHeight: 18,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 2,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  warningBox: {
    marginTop: 4,
    padding: 6,
    borderRadius: Radii.xs,
    borderWidth: 1,
  },
  backgroundBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    paddingVertical: 2,
  },
  backgroundDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
