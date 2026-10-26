/**
 * Dispatcher Owner Live Territory Map Screen
 *
 * Implements M12.5 Marker Selection & Worker/Job Bottom Sheet:
 * - Authoritative display of current worker GPS locations for active field visits.
 * - Marker selection with stable IDs matching the authoritative worker/job data model.
 * - Opens reusable LiveMapBottomSheet on marker tap (Android & iOS 18+) or card tap (iOS 17 & accessible fallback).
 * - Displays worker name, job service, customer name, M9 status badge, address, telemetry freshness, and distance.
 * - Primary "View Job" action deep-links to existing Owner Job Details route (/owner/job-details).
 * - Dynamically updates freshness and gracefully reflects completed, cancelled, or reassigned jobs.
 * - Strict business tenancy; zero fake markers or fallback coordinates.
 * - Safe areas, pull-to-refresh, retry action, and native mapping launchers.
 */

import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import { LiveMapBottomSheet } from '@/components/map/live-map-bottom-sheet';
import { LiveMapViewport } from '@/components/map/live-map-viewport';
import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, Loading, ScreenContainer, StatusBadge } from '@/components/ui';
import { JobStatus, Palette, Radii, Spacing } from '@/constants/theme';
import { useOwnerLiveMap } from '@/hooks/use-owner-live-map';
import { useTheme } from '@/hooks/use-theme';
import { launchNativeMaps } from '@/lib/launchers';
import {
  findWorkerMapItemById,
  formatDistance,
  getMapLifecycleStatusLabel,
  MAP_STATUS_COLORS,
  OwnerLiveMapWorkerItem,
} from '@/lib/owner-locations-core';

export default function OwnerLiveMapScreen() {
  const theme = useTheme();
  const { data, summary, isLoading, isRefreshing, error, onRefresh, refetch } =
    useOwnerLiveMap();

  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);

  // Reconcile and reload map data automatically whenever the screen gains focus
  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  if (isLoading && !isRefreshing) {
    return <Loading fullScreen label="Loading territory live map..." />;
  }

  // Filter markers strictly: valid coordinates on active field jobs with fresh telemetry (Requirement 2 & 4)
  const liveMarkers =
    data?.activeMarkers.filter(
      (m) =>
        m.isLive &&
        m.workerLatitude !== null &&
        m.workerLongitude !== null &&
        !isNaN(m.workerLatitude) &&
        !isNaN(m.workerLongitude)
    ) ?? [];

  const untrackedWorkers = data?.untrackedWorkers ?? [];

  // Authoritative lookup of selected worker using stable ID (Requirement: stable ID lookup)
  const selectedWorker = findWorkerMapItemById(data?.workers || [], selectedWorkerId);

  return (
    <ScreenContainer
      scrollable
      withPadding
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />}>
      <View style={styles.container}>
        {/* Territory Header */}
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <ThemedText type="headline">Live Territory Map</ThemedText>
            {liveMarkers.length > 0 ? (
              <View
                style={[
                  styles.liveBadge,
                  { backgroundColor: Palette.blueBg, borderColor: Palette.blueBorder },
                ]}>
                <View style={[styles.pulsingDot, { backgroundColor: Palette.blueText }]} />
                <ThemedText type="caption" style={{ color: Palette.blueText, fontWeight: '600' }}>
                  {liveMarkers.length} LIVE MARKER{liveMarkers.length === 1 ? '' : 'S'}
                </ThemedText>
              </View>
            ) : null}
          </View>
          <ThemedText type="body" themeColor="textSecondary">
            Operational real-time view of field technicians and customer destinations.
          </ThemedText>
        </View>

        {/* Operational Metrics Bar */}
        <View style={styles.summaryBar}>
          <View style={[styles.metricCard, { backgroundColor: theme.surfaceSecondary }]}>
            <ThemedText type="caption" themeColor="textSecondary">
              TRAVELLING
            </ThemedText>
            <ThemedText type="headline" style={{ color: Palette.blueText }}>
              {summary.enRouteCount}
            </ThemedText>
          </View>

          <View style={[styles.metricCard, { backgroundColor: theme.surfaceSecondary }]}>
            <ThemedText type="caption" themeColor="textSecondary">
              ON-SITE
            </ThemedText>
            <ThemedText type="headline" style={{ color: Palette.greenText }}>
              {summary.onSiteCount}
            </ThemedText>
          </View>

          <View style={[styles.metricCard, { backgroundColor: theme.surfaceSecondary }]}>
            <ThemedText type="caption" themeColor="textSecondary">
              OFF-MAP
            </ThemedText>
            <ThemedText
              type="headline"
              style={{
                color:
                  summary.staleTracked > 0 || summary.awaitingFixCount > 0
                    ? Palette.amberText
                    : theme.textSecondary,
              }}>
              {summary.staleTracked + summary.awaitingFixCount}
            </ThemedText>
          </View>
        </View>

        {/* Compact Status Legend (Requirement 6: text labels with restrained colors) */}
        <View
          style={[
            styles.legendContainer,
            { backgroundColor: theme.surfaceSecondary, borderColor: theme.border },
          ]}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: MAP_STATUS_COLORS.on_the_way }]} />
            <ThemedText type="caption" style={{ fontWeight: '600' }}>
              Travelling
            </ThemedText>
          </View>

          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: MAP_STATUS_COLORS.arrived }]} />
            <ThemedText type="caption" style={{ fontWeight: '600' }}>
              Arrived
            </ThemedText>
          </View>

          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: MAP_STATUS_COLORS.in_progress }]} />
            <ThemedText type="caption" style={{ fontWeight: '600' }}>
              Working
            </ThemedText>
          </View>
        </View>

        {/* Territory Map Viewport with Marker Selection (Requirement 1, 2, 8, 14 & M12.5) */}
        <LiveMapViewport
          items={liveMarkers}
          selectedWorkerId={selectedWorkerId}
          onSelectMarker={(workerId) => setSelectedWorkerId(workerId)}
          style={styles.mapViewport}
        />

        {/* Database Error Banner */}
        {error ? (
          <Card
            variant="outline"
            style={[
              styles.errorCard,
              { borderColor: theme.dangerBorder, backgroundColor: theme.dangerBackground },
            ]}>
            <ThemedText type="label" style={{ color: theme.danger }}>
              FAILED TO LOAD LOCATIONS
            </ThemedText>
            <ThemedText type="caption" style={{ color: theme.danger }}>
              {error}
            </ThemedText>
            <Button
              label="Retry"
              variant="outline"
              size="sm"
              onPress={refetch}
              style={{ marginTop: Spacing.xs, alignSelf: 'flex-start' }}
            />
          </Card>
        ) : null}

        {/* Section 1: Active Field Technicians (Markers on Map) */}
        <View style={styles.sectionHeader}>
          <ThemedText type="subtitle">
            Active Field Technicians ({liveMarkers.length})
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Tap a technician card or map pin to open the live job sheet.
          </ThemedText>
        </View>

        {liveMarkers.length === 0 ? (
          <EmptyState
            title="No Active Field Markers"
            description="Technician positions appear here once jobs are dispatched and workers enter field travel (Travelling) or arrive on site with active GPS telemetry."
          />
        ) : (
          <View style={styles.locationList}>
            {liveMarkers.map((worker) => (
              <LiveWorkerCard
                key={worker.workerId}
                item={worker}
                isSelected={selectedWorkerId === worker.workerId}
                onSelectWorker={() => setSelectedWorkerId(worker.workerId)}
              />
            ))}
          </View>
        )}

        {/* Section 2: Team Roster & Telemetry Status (Requirement 9 & 10) */}
        {untrackedWorkers.length > 0 ? (
          <View style={styles.untrackedSection}>
            <View style={styles.sectionHeader}>
              <ThemedText type="subtitle">
                Team Roster & Telemetry Status ({untrackedWorkers.length})
              </ThemedText>
              <ThemedText type="caption" themeColor="textSecondary">
                Workers awaiting GPS fixes, with stale signals, or scheduled for upcoming visits.
              </ThemedText>
            </View>

            <View style={styles.locationList}>
              {untrackedWorkers.map((worker) => (
                <UntrackedWorkerCard
                  key={worker.workerId}
                  item={worker}
                  isSelected={selectedWorkerId === worker.workerId}
                  onSelectWorker={() => setSelectedWorkerId(worker.workerId)}
                />
              ))}
            </View>
          </View>
        ) : null}

        {/* Reusable Marker / Worker Details Bottom Sheet (M12.5) */}
        <LiveMapBottomSheet
          visible={selectedWorker !== null}
          item={selectedWorker}
          onClose={() => setSelectedWorkerId(null)}
          onRefresh={refetch}
          isRefreshing={isRefreshing}
        />
      </View>
    </ScreenContainer>
  );
}

/**
 * Card for an active technician with a live marker on the map.
 * Also serves as the accessible tap target for iOS 17 & screen readers.
 */
function LiveWorkerCard({
  item,
  isSelected = false,
  onSelectWorker,
}: {
  item: OwnerLiveMapWorkerItem;
  isSelected?: boolean;
  onSelectWorker?: () => void;
}) {
  const theme = useTheme();

  const handleOpenJob = () => {
    if (!item.jobId) return;
    router.push({
      pathname: '/owner/job-details',
      params: { id: item.jobId },
    });
  };

  const handleOpenNativeMap = () => {
    if (!item.jobAddress) return;
    launchNativeMaps(item.jobAddress, {
      latitude: item.workerLatitude,
      longitude: item.workerLongitude,
    });
  };

  const statusLabel = getMapLifecycleStatusLabel(item.jobStatus);

  return (
    <Card
      variant="surface"
      onPress={onSelectWorker}
      style={[
        styles.card,
        isSelected && {
          borderColor: Palette.blueText,
          borderWidth: 2,
        },
      ]}>
      {/* Top Header Row: Worker & Job Status */}
      <View style={styles.cardHeader}>
        <View style={styles.workerIdentity}>
          <View style={[styles.avatarPlaceholder, { backgroundColor: theme.surfaceSecondary }]}>
            <ThemedText type="label" style={{ fontWeight: '700' }}>
              {item.workerName.charAt(0).toUpperCase()}
            </ThemedText>
          </View>
          <View style={{ gap: 2 }}>
            <ThemedText type="bodyMedium" style={{ fontWeight: '600' }}>
              {item.workerName}
            </ThemedText>
            <ThemedText type="caption" themeColor="textSecondary">
              {item.jobService || 'Service Visit'}
            </ThemedText>
          </View>
        </View>

        {item.jobStatus ? (
          <StatusBadge status={item.jobStatus} label={statusLabel} size="sm" />
        ) : null}
      </View>

      {/* Freshness & Quality Telemetry Badge */}
      <View
        style={[
          styles.freshnessBadge,
          { backgroundColor: Palette.blueBg, borderColor: Palette.blueBorder },
        ]}>
        <View style={[styles.freshnessDot, { backgroundColor: Palette.blueText }]} />
        <ThemedText
          type="caption"
          style={{ color: Palette.blueText, fontWeight: '600' }}>
          {item.freshnessLabel}
          {item.accuracy !== null ? ` (±${Math.round(item.accuracy)}m)` : ''}
        </ThemedText>
      </View>

      {/* Location Details */}
      <View style={[styles.telemetrySection, { borderColor: theme.border }]}>
        {item.customerName ? (
          <View style={styles.telemetryRow}>
            <ThemedText type="caption" themeColor="textSecondary">
              Customer:
            </ThemedText>
            <ThemedText type="caption" style={{ fontWeight: '500' }}>
              {item.customerName}
            </ThemedText>
          </View>
        ) : null}

        {item.jobAddress ? (
          <View style={styles.telemetryRow}>
            <ThemedText type="caption" themeColor="textSecondary">
              Destination:
            </ThemedText>
            <ThemedText type="caption" style={{ flex: 1, textAlign: 'right' }} numberOfLines={1}>
              {item.jobAddress}
            </ThemedText>
          </View>
        ) : null}

        {item.distanceToDestinationMeters !== null ? (
          <View style={styles.telemetryRow}>
            <ThemedText type="caption" themeColor="textSecondary">
              Distance to Site:
            </ThemedText>
            <ThemedText type="bodyMedium" style={{ fontWeight: '600', color: Palette.blueText }}>
              {formatDistance(item.distanceToDestinationMeters)}
            </ThemedText>
          </View>
        ) : null}
      </View>

      {/* Actions Row */}
      <View style={styles.actionsRow}>
        <Button
          label="Details & Sheet"
          variant="secondary"
          size="sm"
          onPress={onSelectWorker}
          style={styles.actionButton}
        />
        {item.jobAddress ? (
          <Button
            label="Maps"
            variant="outline"
            size="sm"
            onPress={handleOpenNativeMap}
            style={styles.actionButton}
          />
        ) : null}
        {item.jobId ? (
          <Button
            label="Job Details"
            variant="outline"
            size="sm"
            onPress={handleOpenJob}
            style={styles.actionButton}
          />
        ) : null}
      </View>
    </Card>
  );
}

/**
 * Card for an untracked worker (stale telemetry, awaiting GPS fix, scheduled, idle, inactive).
 * Requirement 9 & 10: Truthful representation without assigning fabricated map positions.
 */
function UntrackedWorkerCard({
  item,
  isSelected = false,
  onSelectWorker,
}: {
  item: OwnerLiveMapWorkerItem;
  isSelected?: boolean;
  onSelectWorker?: () => void;
}) {
  const theme = useTheme();

  const handleOpenJob = () => {
    if (!item.jobId) return;
    router.push({
      pathname: '/owner/job-details',
      params: { id: item.jobId },
    });
  };

  const handleOpenNativeMap = () => {
    if (!item.jobAddress) return;
    launchNativeMaps(item.jobAddress, {
      latitude: item.workerLatitude,
      longitude: item.workerLongitude,
    });
  };

  // Status-specific badge colors and labels
  let badgeLabel = 'IDLE';
  let badgeBg: string = theme.surfaceSecondary;
  let badgeBorder: string = theme.border;
  let badgeText: string = theme.textSecondary;
  let statusNote = 'No active assignments';

  if (!item.isActive) {
    badgeLabel = 'INACTIVE';
    statusNote = 'Worker account is inactive';
  } else if (item.positionStatus === 'STALE') {
    badgeLabel = 'STALE TELEMETRY';
    badgeBg = Palette.amberBg;
    badgeBorder = Palette.amberBorder;
    badgeText = Palette.amberText;
    statusNote = 'Last coordinates older than 5 minutes — hidden from live map';
  } else if (item.positionStatus === 'LOW_ACCURACY') {
    badgeLabel = 'LOW ACCURACY';
    badgeBg = Palette.amberBg;
    badgeBorder = Palette.amberBorder;
    badgeText = Palette.amberText;
    statusNote = `Accuracy (±${Math.round(item.accuracy || 0)}m) exceeds threshold — hidden from live map`;
  } else if (item.positionStatus === 'NO_FIX') {
    badgeLabel = 'AWAITING GPS';
    badgeBg = Palette.slateBg;
    badgeBorder = Palette.slateBorder;
    badgeText = Palette.slateText;
    statusNote = 'Active visit in progress — awaiting device GPS signal';
  } else if (item.jobStatus === 'assigned' || item.jobStatus === 'accepted') {
    badgeLabel = 'SCHEDULED';
    badgeBg = Palette.blueBg;
    badgeBorder = Palette.blueBorder;
    badgeText = Palette.blueText;
    statusNote = `${item.jobService || 'Scheduled visit'} (field travel not started)`;
  }

  return (
    <Card
      variant="surface"
      onPress={onSelectWorker}
      style={[
        styles.card,
        isSelected && {
          borderColor: Palette.blueText,
          borderWidth: 2,
        },
      ]}>
      <View style={styles.cardHeader}>
        <View style={styles.workerIdentity}>
          <View style={[styles.avatarPlaceholder, { backgroundColor: theme.surfaceSecondary }]}>
            <ThemedText type="label" style={{ fontWeight: '700' }}>
              {item.workerName.charAt(0).toUpperCase()}
            </ThemedText>
          </View>
          <View style={{ gap: 2 }}>
            <ThemedText type="bodyMedium" style={{ fontWeight: '600' }}>
              {item.workerName}
            </ThemedText>
            <ThemedText type="caption" themeColor="textSecondary">
              {item.jobService || 'No active visit'}
            </ThemedText>
          </View>
        </View>

        <View
          style={[
            styles.customStatusBadge,
            { backgroundColor: badgeBg, borderColor: badgeBorder },
          ]}>
          <ThemedText type="caption" style={{ color: badgeText, fontWeight: '600' }}>
            {badgeLabel}
          </ThemedText>
        </View>
      </View>

      {/* Informational Status Note */}
      <View
        style={[
          styles.freshnessBadge,
          { backgroundColor: theme.surfaceSecondary, borderColor: theme.border },
        ]}>
        <ThemedText type="caption" themeColor="textSecondary">
          {statusNote}
        </ThemedText>
      </View>

      {/* Telemetry info if previously recorded */}
      {item.freshnessLabel ? (
        <View style={[styles.telemetrySection, { borderColor: theme.border }]}>
          <View style={styles.telemetryRow}>
            <ThemedText type="caption" themeColor="textSecondary">
              Last Telemetry Status:
            </ThemedText>
            <ThemedText type="caption" themeColor="textSecondary">
              {item.freshnessLabel}
            </ThemedText>
          </View>
        </View>
      ) : null}

      {/* Actions */}
      <View style={styles.actionsRow}>
        <Button
          label="Details & Sheet"
          variant="secondary"
          size="sm"
          onPress={onSelectWorker}
          style={styles.actionButton}
        />
        {item.jobAddress ? (
          <Button
            label="Maps"
            variant="outline"
            size="sm"
            onPress={handleOpenNativeMap}
            style={styles.actionButton}
          />
        ) : null}
        {item.jobId ? (
          <Button
            label="Job Details"
            variant="outline"
            size="sm"
            onPress={handleOpenJob}
            style={styles.actionButton}
          />
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: Spacing.base,
    gap: Spacing.base,
  },
  header: {
    gap: Spacing.xs,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radii.pill,
    borderWidth: 1,
  },
  pulsingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  summaryBar: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  metricCard: {
    flex: 1,
    padding: Spacing.sm,
    borderRadius: Radii.sm,
    alignItems: 'center',
    gap: 2,
  },
  legendContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: Spacing.xs + 2,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radii.pill,
    borderWidth: 1,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  mapViewport: {
    height: 260,
    borderRadius: Radii.md,
  },
  errorCard: {
    padding: Spacing.sm,
    borderRadius: Radii.sm,
    gap: 4,
  },
  sectionHeader: {
    gap: 2,
  },
  locationList: {
    gap: Spacing.md,
  },
  untrackedSection: {
    gap: Spacing.base,
    marginTop: Spacing.sm,
  },
  card: {
    padding: Spacing.base,
    borderRadius: Radii.md,
    gap: Spacing.sm,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  workerIdentity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  avatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  customStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radii.pill,
    borderWidth: 1,
  },
  freshnessBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    borderRadius: Radii.xs,
    borderWidth: 1,
  },
  freshnessDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  telemetrySection: {
    paddingTop: Spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  telemetryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  actionButton: {
    flex: 1,
  },
});
