/**
 * Dispatcher Live Map Worker/Job Bottom Sheet
 *
 * Implements M12.5 Marker Selection & Worker/Job Bottom Sheet:
 * - Slides up on marker selection or worker card selection.
 * - Displays:
 *   - Worker name & initial avatar.
 *   - Current job service.
 *   - Customer name when available.
 *   - Job status with M9 lifecycle badge (Travelling, Arrived, Working).
 *   - Customer address.
 *   - Telemetry update time and accuracy.
 *   - Distance to customer destination.
 * - Clear "View Job" primary action deep-linking to existing Owner Job Details route (/owner/job-details).
 * - "Open in Maps" launcher for native navigation.
 * - Dynamic freshness evaluation (accurately reflects stale coordinates while open).
 * - Graceful presentation if job is reassigned or completed while open.
 * - Zero raw coordinates displayed (protects customer/worker operational view).
 */

import { router } from 'expo-router';
import React, { useMemo } from 'react';
import {
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, StatusBadge } from '@/components/ui';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { launchNativeMaps } from '@/lib/launchers';
import {
  formatDistance,
  formatTimeAgo,
  getMapLifecycleStatusLabel,
  isWorkerLocationStale,
  OwnerLiveMapWorkerItem,
} from '@/lib/owner-locations-core';

export interface LiveMapBottomSheetProps {
  visible: boolean;
  item: OwnerLiveMapWorkerItem | null;
  onClose: () => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export function LiveMapBottomSheet({
  visible,
  item,
  onClose,
  onRefresh,
  isRefreshing = false,
}: LiveMapBottomSheetProps) {
  const theme = useTheme();

  // Dynamically re-evaluate freshness if item is open
  const isCurrentlyStale = useMemo(() => {
    if (!item) return false;
    return isWorkerLocationStale(item);
  }, [item]);

  if (!item) {
    return null;
  }

  const handleViewJob = () => {
    if (!item.jobId) return;
    onClose();
    router.push({
      pathname: '/owner/job-details',
      params: { id: item.jobId },
    });
  };

  const handleOpenMaps = () => {
    if (!item.jobAddress) return;
    launchNativeMaps(item.jobAddress, {
      latitude: item.workerLatitude,
      longitude: item.workerLongitude,
    });
  };

  const statusLabel = getMapLifecycleStatusLabel(item.jobStatus);
  const hasActiveJob = Boolean(item.jobId);

  // Dynamic telemetry label
  const telemetryTimeAgo = item.recordedAt ? formatTimeAgo(item.recordedAt) : 'Unknown';
  let dynamicFreshnessText = `Updated ${telemetryTimeAgo}`;
  if (isCurrentlyStale) {
    dynamicFreshnessText = `Stale — updated ${telemetryTimeAgo}`;
  } else if (item.isInaccurate) {
    dynamicFreshnessText = `Low accuracy (±${Math.round(item.accuracy || 0)}m) — updated ${telemetryTimeAgo}`;
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheetContainer, { backgroundColor: theme.surface }]}
          onPress={(e) => e.stopPropagation()}>
          <SafeAreaView style={styles.safeArea}>
            {/* Top Drag Handle */}
            <View style={styles.dragHandleContainer}>
              <View style={[styles.dragHandle, { backgroundColor: theme.borderStrong }]} />
            </View>

            {/* Header: Worker Identity & Close */}
            <View style={styles.header}>
              <View style={styles.workerIdentity}>
                <View style={[styles.avatarCircle, { backgroundColor: theme.surfaceSecondary }]}>
                  <ThemedText type="label" style={{ fontWeight: '700' }}>
                    {item.workerName.charAt(0).toUpperCase()}
                  </ThemedText>
                </View>
                <View style={styles.nameGroup}>
                  <ThemedText type="bodyMedium" style={{ fontWeight: '700' }}>
                    {item.workerName}
                  </ThemedText>
                  {item.jobStatus ? (
                    <StatusBadge status={item.jobStatus} label={statusLabel} size="sm" />
                  ) : (
                    <View
                      style={[
                        styles.neutralBadge,
                        { backgroundColor: theme.surfaceSecondary, borderColor: theme.border },
                      ]}>
                      <ThemedText type="caption" themeColor="textSecondary" style={{ fontWeight: '600' }}>
                        OFF-DUTY
                      </ThemedText>
                    </View>
                  )}
                </View>
              </View>

              <Button label="Close" variant="ghost" size="sm" onPress={onClose} />
            </View>

            {/* Freshness & Quality Telemetry Pill */}
            {item.recordedAt ? (
              <View
                style={[
                  styles.freshnessBadge,
                  isCurrentlyStale
                    ? { backgroundColor: Palette.amberBg, borderColor: Palette.amberBorder }
                    : item.isInaccurate
                      ? { backgroundColor: Palette.amberBg, borderColor: Palette.amberBorder }
                      : { backgroundColor: Palette.blueBg, borderColor: Palette.blueBorder },
                ]}>
                <View
                  style={[
                    styles.freshnessDot,
                    {
                      backgroundColor:
                        isCurrentlyStale || item.isInaccurate
                          ? Palette.amberText
                          : Palette.blueText,
                    },
                  ]}
                />
                <ThemedText
                  type="caption"
                  style={{
                    color:
                      isCurrentlyStale || item.isInaccurate
                        ? Palette.amberText
                        : Palette.blueText,
                    fontWeight: '600',
                  }}>
                  {dynamicFreshnessText}
                  {item.accuracy !== null ? ` • ±${Math.round(item.accuracy)}m accuracy` : ''}
                </ThemedText>
              </View>
            ) : null}

            {/* Job Operational Details */}
            {hasActiveJob ? (
              <Card variant="outline" style={[styles.detailsCard, { borderColor: theme.border }]}>
                {/* Service Row */}
                <View style={styles.detailRow}>
                  <ThemedText type="caption" themeColor="textSecondary" style={styles.detailLabel}>
                    Service:
                  </ThemedText>
                  <ThemedText type="bodyMedium" style={{ fontWeight: '600', flex: 1, textAlign: 'right' }}>
                    {item.jobService || 'Service Visit'}
                  </ThemedText>
                </View>

                {/* Customer Name Row */}
                {item.customerName ? (
                  <View style={styles.detailRow}>
                    <ThemedText type="caption" themeColor="textSecondary" style={styles.detailLabel}>
                      Customer:
                    </ThemedText>
                    <ThemedText type="bodyMedium" style={{ flex: 1, textAlign: 'right' }}>
                      {item.customerName}
                    </ThemedText>
                  </View>
                ) : null}

                {/* Destination Address Row */}
                {item.jobAddress ? (
                  <View style={styles.detailRow}>
                    <ThemedText type="caption" themeColor="textSecondary" style={styles.detailLabel}>
                      Destination:
                    </ThemedText>
                    <ThemedText type="caption" style={{ flex: 1, textAlign: 'right' }} numberOfLines={2}>
                      {item.jobAddress}
                    </ThemedText>
                  </View>
                ) : null}

                {/* Distance to Site Row */}
                {item.distanceToDestinationMeters !== null ? (
                  <View style={styles.detailRow}>
                    <ThemedText type="caption" themeColor="textSecondary" style={styles.detailLabel}>
                      Distance to Site:
                    </ThemedText>
                    <ThemedText type="bodyMedium" style={{ fontWeight: '600', color: Palette.blueText }}>
                      {formatDistance(item.distanceToDestinationMeters)}
                    </ThemedText>
                  </View>
                ) : null}
              </Card>
            ) : (
              /* Concluded or Reassigned Job Alert */
              <Card
                variant="outline"
                style={[
                  styles.detailsCard,
                  { backgroundColor: theme.surfaceSecondary, borderColor: theme.border },
                ]}>
                <ThemedText type="headline">No Active Job Assignment</ThemedText>
                <ThemedText type="caption" themeColor="textSecondary">
                  This technician does not currently have an active field visit. The job may have
                  been completed, cancelled, or reassigned.
                </ThemedText>
                {onRefresh ? (
                  <Button
                    label={isRefreshing ? 'Refreshing...' : 'Refresh Status'}
                    variant="outline"
                    size="sm"
                    onPress={onRefresh}
                    disabled={isRefreshing}
                    style={{ alignSelf: 'flex-start', marginTop: Spacing.xs }}
                  />
                ) : null}
              </Card>
            )}

            {/* Actions Bar */}
            <View style={styles.actionsContainer}>
              {hasActiveJob ? (
                <Button
                  label="View Job"
                  variant="primary"
                  onPress={handleViewJob}
                  style={styles.primaryActionButton}
                />
              ) : null}

              {item.jobAddress ? (
                <Button
                  label="Open in Maps"
                  variant="secondary"
                  onPress={handleOpenMaps}
                  style={styles.secondaryActionButton}
                />
              ) : null}
            </View>
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    borderTopLeftRadius: Radii.xl,
    borderTopRightRadius: Radii.xl,
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing.xl,
    paddingTop: Spacing.xs,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 8,
  },
  safeArea: {
    gap: Spacing.md,
  },
  dragHandleContainer: {
    alignItems: 'center',
    paddingVertical: Spacing.xs,
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  workerIdentity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    flex: 1,
  },
  avatarCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  nameGroup: {
    gap: 4,
  },
  neutralBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radii.pill,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  freshnessBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 5,
    borderRadius: Radii.sm,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  freshnessDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  detailsCard: {
    padding: Spacing.base,
    borderRadius: Radii.md,
    gap: Spacing.sm,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  detailLabel: {
    width: 90,
  },
  actionsContainer: {
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  primaryActionButton: {
    width: '100%',
  },
  secondaryActionButton: {
    width: '100%',
  },
});
