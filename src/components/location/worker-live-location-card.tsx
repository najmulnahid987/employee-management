import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleProp, StyleSheet, Switch, View, ViewStyle } from 'react-native';
import * as Location from 'expo-location';

import { ThemedText } from '@/components/themed-text';
import { Button, Card } from '@/components/ui';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import {
  startBackgroundTrackingAsync,
  stopBackgroundTrackingAsync,
} from '@/lib/background-location-task';
import { requestJobTransition } from '@/lib/jobs';
import { requestForegroundLocationPermission } from '@/lib/location-policy';
import { JobStatus } from '@/lib/location-rules';
import { foregroundLocationTracker } from '@/lib/location-tracker';
import { supabase } from '@/lib/supabase';

export interface WorkerLiveLocationCardProps {
  jobId?: string | null;
  jobStatus?: JobStatus | null;
  jobTitle?: string | null;
  onStatusTransitioned?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function WorkerLiveLocationCard({
  jobId,
  jobStatus,
  jobTitle,
  onStatusTransitioned,
  style,
}: WorkerLiveLocationCardProps) {
  const theme = useTheme();
  const { user } = useAuth();

  const [isSharing, setIsSharing] = useState<boolean>(false);
  const [isToggling, setIsToggling] = useState<boolean>(false);
  const [lastPingTime, setLastPingTime] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Check initial state from tracker singleton
  useEffect(() => {
    const trackerState = foregroundLocationTracker.getState();
    if (trackerState.isTracking) {
      setIsSharing(true);
      if (trackerState.lastSubmittedAt) {
        setLastPingTime(new Date(trackerState.lastSubmittedAt).toLocaleTimeString());
      }
    }

    const unsubscribe = foregroundLocationTracker.subscribe((state) => {
      setIsSharing(state.isTracking);
      if (state.lastSubmittedAt) {
        setLastPingTime(new Date(state.lastSubmittedAt).toLocaleTimeString());
      }
      if (state.error) {
        setErrorMessage(state.error);
      }
    });

    return unsubscribe;
  }, []);

  const handleStartTravelAndShare = useCallback(async () => {
    if (!jobId || isToggling) return;
    setIsToggling(true);
    setErrorMessage(null);

    try {
      // 1. Request location permissions
      const permission = await requestForegroundLocationPermission();
      if (permission.state !== 'GRANTED' && permission.state !== 'APPROXIMATE') {
        setErrorMessage('Location permission is required to start travel and share location.');
        setIsToggling(false);
        return;
      }

      // 2. Transition job to on_the_way if in accepted status
      if (jobStatus === 'accepted') {
        const transition = await requestJobTransition({
          jobId,
          currentStatus: 'accepted',
          targetStatus: 'on_the_way',
          role: 'worker',
        });

        if (!transition.success) {
          setErrorMessage(transition.error || 'Failed to start travel.');
          setIsToggling(false);
          return;
        }

        onStatusTransitioned?.();
      }

      // 3. Immediately capture and upload first location fix
      try {
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        await supabase.rpc('record_worker_location', {
          p_job_id: jobId,
          p_latitude: loc.coords.latitude,
          p_longitude: loc.coords.longitude,
          p_accuracy: loc.coords.accuracy ?? null,
        });

        setLastPingTime(new Date().toLocaleTimeString());
      } catch {
        // Tracker will continue subsequent retries
      }

      // 4. Start continuous foreground tracking
      const started = await foregroundLocationTracker.startTracking(jobId, 'on_the_way');

      // 5. Start background tracking if worker ID is present
      if (user?.id) {
        await startBackgroundTrackingAsync(jobId, user.id, 'on_the_way');
      }

      setIsSharing(started);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start travel tracking.');
    } finally {
      setIsToggling(false);
    }
  }, [jobId, jobStatus, isToggling, onStatusTransitioned, user?.id]);

  const handleToggleSharing = useCallback(async () => {
    if (isToggling) return;
    setIsToggling(true);
    setErrorMessage(null);

    try {
      if (isSharing) {
        // Stop sharing
        foregroundLocationTracker.stopTracking();
        await stopBackgroundTrackingAsync();
        setIsSharing(false);
      } else {
        // Start sharing
        const permission = await requestForegroundLocationPermission();
        if (permission.state !== 'GRANTED' && permission.state !== 'APPROXIMATE') {
          setErrorMessage('Location permission is required to share your live location.');
          setIsToggling(false);
          return;
        }

        const activeJobId = jobId;
        const activeStatus: JobStatus = jobStatus || 'on_the_way';

        if (!activeJobId) {
          setErrorMessage('No active job selected to share location.');
          setIsToggling(false);
          return;
        }

        // Capture fix
        try {
          const loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });

          await supabase.rpc('record_worker_location', {
            p_job_id: activeJobId,
            p_latitude: loc.coords.latitude,
            p_longitude: loc.coords.longitude,
            p_accuracy: loc.coords.accuracy ?? null,
          });

          setLastPingTime(new Date().toLocaleTimeString());
        } catch {
          // Tracker will handle subsequent retries
        }

        // Start continuous foreground tracking
        const started = await foregroundLocationTracker.startTracking(activeJobId, activeStatus);

        if (user?.id) {
          await startBackgroundTrackingAsync(activeJobId, user.id, activeStatus);
        }

        setIsSharing(started);
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'An error occurred updating location sharing.'
      );
    } finally {
      setIsToggling(false);
    }
  }, [isSharing, isToggling, jobId, jobStatus, user?.id]);

  const isEligibleActiveVisit =
    jobStatus === 'on_the_way' || jobStatus === 'arrived' || jobStatus === 'in_progress';

  return (
    <Card
      variant="outline"
      style={[
        styles.card,
        {
          borderColor: isSharing ? Palette.greenBorder : theme.border,
          backgroundColor: isSharing ? Palette.greenBg : theme.surfaceSecondary,
        },
        style,
      ]}>
      <View style={styles.headerRow}>
        <View style={styles.titleGroup}>
          <View style={styles.titleWithIcon}>
            <ThemedText style={{ fontSize: 18 }}>{isSharing ? '🟢' : '📡'}</ThemedText>
            <ThemedText type="headline" style={{ fontSize: 15 }}>
              Live Location Sharing
            </ThemedText>
          </View>
          <ThemedText type="caption" themeColor="textSecondary" style={{ marginTop: 2 }}>
            {isSharing
              ? 'Broadcasting live GPS to dispatch & territory map'
              : isEligibleActiveVisit
              ? 'Allow owner to see your location in real time'
              : jobStatus === 'accepted'
              ? 'Start travel to begin streaming live location'
              : jobStatus === 'assigned'
              ? 'Accept assignment to enable trip tracking'
              : 'Active during field travel and on-site visits'}
          </ThemedText>
        </View>

        {isEligibleActiveVisit ? (
          isToggling ? (
            <ActivityIndicator size="small" color={theme.primary} />
          ) : (
            <Switch
              value={isSharing}
              onValueChange={handleToggleSharing}
              trackColor={{ false: theme.border, true: Palette.greenText }}
              thumbColor="#FFFFFF"
              accessibilityRole="switch"
              accessibilityLabel="Toggle live location sharing"
            />
          )
        ) : null}
      </View>

      {/* Action button if job is accepted and ready to travel */}
      {jobStatus === 'accepted' ? (
        <View style={{ marginTop: Spacing.sm }}>
          <Button
            label="Start Travel & Share Location"
            variant="primary"
            size="sm"
            loading={isToggling}
            disabled={isToggling}
            onPress={handleStartTravelAndShare}
          />
        </View>
      ) : null}

      {/* Status Details Bar when sharing */}
      {isSharing ? (
        <View style={styles.activeDetailsContainer}>
          <View style={styles.beaconBadge}>
            <View style={styles.pulsingDot} />
            <ThemedText type="caption" style={{ color: Palette.greenText, fontWeight: '700' }}>
              BEACON LIVE
            </ThemedText>
          </View>

          {jobTitle ? (
            <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1}>
              Job: {jobTitle}
            </ThemedText>
          ) : null}

          {lastPingTime ? (
            <ThemedText type="caption" themeColor="textSecondary">
              Last fix: {lastPingTime}
            </ThemedText>
          ) : null}
        </View>
      ) : null}

      {/* Error Notice */}
      {errorMessage ? (
        <ThemedText type="caption" style={{ color: theme.danger, marginTop: Spacing.xs }}>
          {errorMessage}
        </ThemedText>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: Spacing.base,
    borderRadius: Radii.base,
    marginBottom: Spacing.base,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  titleGroup: {
    flex: 1,
    marginRight: Spacing.sm,
  },
  titleWithIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  activeDetailsContainer: {
    marginTop: Spacing.sm,
    paddingTop: Spacing.xs,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0, 0, 0, 0.06)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: Spacing.xs,
  },
  beaconBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radii.full,
  },
  pulsingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Palette.greenText,
  },
});
