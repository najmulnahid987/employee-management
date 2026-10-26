/**
 * Dispatcher Realtime Status Banner
 *
 * Displays a non-intrusive warning when Realtime live updates are degraded,
 * timed out, or in an error state. Allows the user to trigger immediate
 * channel reconnection while preserving full view and pull-to-refresh capabilities.
 */

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useRealtime } from '@/hooks/use-realtime';

export interface RealtimeStatusBannerProps {
  style?: StyleProp<ViewStyle>;
}

export function RealtimeStatusBanner({ style }: RealtimeStatusBannerProps) {
  const { status, error, reconnect } = useRealtime();
  const [isReconnecting, setIsReconnecting] = useState(false);

  // Invisible when connected, connecting, or disconnected cleanly
  if (status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT') {
    return null;
  }

  const handleReconnectPress = async () => {
    if (isReconnecting) return;
    setIsReconnecting(true);
    try {
      await reconnect();
    } finally {
      setIsReconnecting(false);
    }
  };

  return (
    <View style={[styles.banner, style]}>
      <View style={styles.textContainer}>
        <View style={styles.titleRow}>
          <View style={styles.dot} />
          <ThemedText type="label" style={styles.titleText}>
            LIVE UPDATES OFFLINE
          </ThemedText>
        </View>
        <ThemedText type="caption" style={styles.subText}>
          {error ? error : 'Connection interrupted. Data may be out of date.'}
        </ThemedText>
      </View>

      <Pressable
        onPress={handleReconnectPress}
        disabled={isReconnecting}
        style={styles.reconnectButton}>
        {isReconnecting ? (
          <ActivityIndicator size="small" color={Palette.amberText} />
        ) : (
          <ThemedText type="label" style={styles.buttonText}>
            Reconnect
          </ThemedText>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Palette.amberBg,
    borderColor: Palette.amberBorder,
    borderWidth: 1,
    borderRadius: Radii.sm,
    paddingHorizontal: Spacing.sm + 2,
    paddingVertical: Spacing.xs + 2,
    marginBottom: Spacing.xs,
    gap: Spacing.xs,
  },
  textContainer: {
    flex: 1,
    gap: 2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Palette.amberText,
  },
  titleText: {
    color: Palette.amberText,
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  subText: {
    color: Palette.amberText,
    fontSize: 12,
    lineHeight: 16,
  },
  reconnectButton: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 5,
    backgroundColor: Palette.amberBorder,
    borderRadius: Radii.xs,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 70,
  },
  buttonText: {
    color: Palette.amberText,
    fontSize: 11,
    fontWeight: '600',
  },
});
