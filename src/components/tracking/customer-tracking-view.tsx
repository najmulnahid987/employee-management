/**
 * Dispatcher M13.5 — Customer Tracking Web View
 *
 * Clean, mobile-first, unauthenticated customer tracking screen.
 * Strictly communicates only with the M13.4 server endpoint (/functions/v1/customer-tracking)
 * via POST body { token: "..." }.
 *
 * Security & Privacy Enforcements:
 * - Reads token from URL fragment/hash (or path/query) and transmits only via POST body.
 * - Sets Referrer-Policy: no-referrer, robots: noindex/nofollow/noarchive, Cache-Control: no-store,
 *   and restrictive Content Security Policy.
 * - Never queries database tables directly. Never instantiates service-role clients.
 * - Never sends bearer tokens to third-party APIs, analytics, or fonts.
 * - Never displays customer phone, internal notes, database IDs, business IDs,
 *   worker IDs, internal event history, raw tokens, or admin information.
 * - Does not invent an ETA from distance.
 * - Displays generic messages for unavailable/expired states to prevent enumeration.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { CustomerTrackingMap } from './customer-tracking-map';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  JobStatus,
  Palette,
  Radii,
  Shadows,
  Spacing,
  Typography,
} from '@/constants/theme';
import {
  CustomerTrackingPayload,
  extractTrackingToken,
  fetchCustomerTrackingViaApi,
} from '@/lib/tracking-session-service';

export interface CustomerTrackingViewProps {
  tokenProp?: string;
  endpointBaseUrl?: string;
  pollIntervalMs?: number;
  testID?: string;
}

export type TrackingViewState =
  | 'loading'
  | 'active'
  | 'location_unavailable'
  | 'stale'
  | 'expired'
  | 'network_error';

/**
 * Injects document security headers and metadata on web platforms.
 */
function useBrowserSecurityHeaders() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    // Document title
    document.title = 'Live Service Tracking | Dispatcher';

    const setMetaTag = (
      nameOrProperty: string,
      attr: 'name' | 'property' | 'httpEquiv',
      content: string
    ) => {
      let meta = document.querySelector(`meta[${attr}="${nameOrProperty}"]`) as HTMLMetaElement | null;
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute(attr, nameOrProperty);
        document.head.appendChild(meta);
      }
      meta.content = content;
    };

    // 1. Strict Referrer Policy: no-referrer prevents token leakage in HTTP referrers
    setMetaTag('referrer', 'name', 'no-referrer');

    // 2. Search engine indexing prevention
    setMetaTag('robots', 'name', 'noindex, nofollow, noarchive');

    // 3. No-store caching for private tracking data
    setMetaTag('Cache-Control', 'httpEquiv', 'no-store, no-cache, must-revalidate');
    setMetaTag('Pragma', 'httpEquiv', 'no-cache');

    // 4. Restrictive Content Security Policy compatible with web maps (Leaflet/OSM) and Supabase
    setMetaTag(
      'Content-Security-Policy',
      'httpEquiv',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https: https://*.tile.openstreetmap.org; connect-src 'self' https:; font-src 'self' data:;"
    );
  }, []);
}

/**
 * Formats ISO timestamp to human-friendly time and relative elapsed time.
 */
function formatLocationTimestamp(isoString: string | null | undefined): {
  timeStr: string;
  elapsedStr: string;
  minutesAgo: number;
} {
  if (!isoString) {
    return { timeStr: 'Not recorded yet', elapsedStr: 'Awaiting first update', minutesAgo: 999 };
  }

  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) {
      return { timeStr: 'Recently', elapsedStr: '', minutesAgo: 0 };
    }

    const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const diffMs = Math.max(0, Date.now() - date.getTime());
    const minutesAgo = Math.floor(diffMs / 60000);

    let elapsedStr = '';
    if (minutesAgo < 1) {
      elapsedStr = 'Just now';
    } else if (minutesAgo === 1) {
      elapsedStr = '1 min ago';
    } else if (minutesAgo < 60) {
      elapsedStr = `${minutesAgo} mins ago`;
    } else {
      const hours = Math.floor(minutesAgo / 60);
      elapsedStr = `${hours}h ago`;
    }

    return { timeStr, elapsedStr, minutesAgo };
  } catch {
    return { timeStr: 'Recently', elapsedStr: '', minutesAgo: 0 };
  }
}

export function CustomerTrackingView({
  tokenProp,
  endpointBaseUrl,
  pollIntervalMs = 20000,
  testID = 'customer-tracking-view',
}: CustomerTrackingViewProps) {
  useBrowserSecurityHeaders();

  const [token, setToken] = useState<string | null>(() => tokenProp || extractTrackingToken() || null);
  const [payload, setPayload] = useState<CustomerTrackingPayload | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isNetworkError, setIsNetworkError] = useState<boolean>(false);
  const [isExpiredOrInvalid, setIsExpiredOrInvalid] = useState<boolean>(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRequestTokenRef = useRef<number>(0);
  const latestServerTimestampRef = useRef<number>(0);

  // Synchronize token prop or browser hash on mount
  useEffect(() => {
    if (tokenProp) {
      setToken(tokenProp);
      return;
    }

    const detected = extractTrackingToken();
    if (detected) {
      setToken(detected);
    } else if (typeof window !== 'undefined') {
      const handleHashChange = () => {
        const nextToken = extractTrackingToken();
        if (nextToken) setToken(nextToken);
      };
      window.addEventListener('hashchange', handleHashChange);
      return () => window.removeEventListener('hashchange', handleHashChange);
    }
  }, [tokenProp]);

  // Core API loader with concurrency token and timestamp protection
  const loadTrackingData = useCallback(
    async (isManualRefresh = false) => {
      if (!token) {
        setIsLoading(false);
        setIsExpiredOrInvalid(true);
        return;
      }

      if (isManualRefresh) {
        setIsRefreshing(true);
      }

      const currentRequestToken = ++activeRequestTokenRef.current;
      const res = await fetchCustomerTrackingViaApi(token, endpointBaseUrl);

      // Concurrency check: discard response if a newer request was dispatched while in-flight
      if (currentRequestToken !== activeRequestTokenRef.current) {
        return;
      }

      setIsLoading(false);
      setIsRefreshing(false);

      if (res.isNetworkError) {
        setIsNetworkError(true);
        return;
      }

      if (!res.payload) {
        setIsExpiredOrInvalid(true);
        setPayload(null);
        return;
      }

      // Chronological protection: prevent out-of-order or cached responses from overwriting newer data
      const serverTime = Math.max(
        new Date(res.payload.updated_at || 0).getTime(),
        new Date(res.payload.last_location_updated_at || 0).getTime()
      );
      if (serverTime > 0 && serverTime < latestServerTimestampRef.current) {
        return;
      }
      if (serverTime > 0) {
        latestServerTimestampRef.current = serverTime;
      }

      // Authoritative valid response
      setIsNetworkError(false);
      setIsExpiredOrInvalid(false);
      setPayload(res.payload);
      setLastRefreshedAt(new Date());
    },
    [token, endpointBaseUrl]
  );

  // Initial load
  useEffect(() => {
    loadTrackingData();
  }, [loadTrackingData]);

  // Pause polling when tab is hidden, refresh promptly when visible
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      } else {
        // Tab became visible again: refresh promptly!
        loadTrackingData(false);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [loadTrackingData]);

  // Recurring polling loop (20-30s while page is visible)
  useEffect(() => {
    // Clear any existing poll timer
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    // Do not poll if loading, error, expired, or job is terminal
    if (isLoading || isNetworkError || isExpiredOrInvalid || !payload) {
      return;
    }

    const isTerminalStatus = payload.status === 'completed' || payload.status === 'cancelled';
    if (isTerminalStatus) {
      return;
    }

    // Do not poll if tab is hidden
    if (Platform.OS === 'web' && typeof document !== 'undefined' && document.hidden) {
      return;
    }

    pollTimerRef.current = setInterval(() => {
      loadTrackingData(false);
    }, pollIntervalMs);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isLoading, isNetworkError, isExpiredOrInvalid, payload, loadTrackingData, pollIntervalMs]);

  // Derive active UI state
  const uiState = useMemo<TrackingViewState>(() => {
    if (isLoading) return 'loading';
    if (isNetworkError) return 'network_error';
    if (isExpiredOrInvalid || !payload) return 'expired';

    // Terminal job statuses end active tracking
    if (payload.status === 'completed' || payload.status === 'cancelled') {
      return 'expired';
    }

    // Location unavailable (worker en route or working, but no GPS fix recorded yet)
    if (!payload.worker_location || payload.worker_location.latitude === null) {
      return 'location_unavailable';
    }

    // Stale location check (> 5 mins old or server-flagged as stale)
    const { minutesAgo } = formatLocationTimestamp(payload.worker_location.recorded_at);
    if (payload.worker_location.is_stale || minutesAgo >= 5) {
      return 'stale';
    }

    return 'active';
  }, [isLoading, isNetworkError, isExpiredOrInvalid, payload]);

  // Call dispatch handler
  const handleCallDispatch = () => {
    if (!payload?.business_phone) return;
    const cleanPhone = payload.business_phone.replace(/[^0-9+]/g, '');
    Linking.openURL(`tel:${cleanPhone}`).catch(() => {
      // Ignore unsupported linking (e.g. desktop browsers without telephony client)
    });
  };

  const formattedLocation = useMemo(() => {
    return formatLocationTimestamp(payload?.worker_location?.recorded_at);
  }, [payload?.worker_location?.recorded_at]);

  // ---------------------------------------------------------------------------
  // STATE 1: INITIAL LOADING
  // ---------------------------------------------------------------------------
  if (uiState === 'loading') {
    return (
      <View style={styles.centerContainer} testID={`${testID}-loading`}>
        <View style={styles.brandHeader}>
          <Text style={styles.brandTitle}>Dispatcher</Text>
          <Text style={styles.brandSubtitle}>Live Customer Tracking</Text>
        </View>

        <Card variant="surface" padding="xl" style={styles.stateCard}>
          <ActivityIndicator size="large" color={Palette.neutral900} />
          <Text style={styles.stateHeading}>Connecting to Live Tracking</Text>
          <Text style={styles.stateDescription}>
            Verifying your secure service session. Please wait a moment...
          </Text>
        </Card>
      </View>
    );
  }

  // ---------------------------------------------------------------------------
  // STATE 6: NETWORK ERROR WITH RETRY
  // ---------------------------------------------------------------------------
  if (uiState === 'network_error') {
    return (
      <View style={styles.centerContainer} testID={`${testID}-network-error`}>
        <View style={styles.brandHeader}>
          <Text style={styles.brandTitle}>Dispatcher</Text>
          <Text style={styles.brandSubtitle}>Live Customer Tracking</Text>
        </View>

        <Card variant="surface" padding="xl" style={styles.stateCard}>
          <View style={[styles.iconCircle, { backgroundColor: Palette.redBg }]}>
            <Text style={[styles.iconText, { color: Palette.redText }]}>!</Text>
          </View>
          <Text style={styles.stateHeading}>Connection Error</Text>
          <Text style={styles.stateDescription}>
            Unable to connect to live tracking. Please check your internet connection and try again.
          </Text>
          <Button
            label="Try Again"
            variant="primary"
            size="md"
            fullWidth
            onPress={() => {
              setIsLoading(true);
              setIsNetworkError(false);
              loadTrackingData(false);
            }}
            style={styles.actionButton}
          />
        </Card>
      </View>
    );
  }

  // ---------------------------------------------------------------------------
  // STATE 5: TRACKING EXPIRED, REVOKED, OR ENDED (GENERIC MESSAGE)
  // ---------------------------------------------------------------------------
  if (uiState === 'expired' || !payload) {
    return (
      <View style={styles.centerContainer} testID={`${testID}-expired`}>
        <View style={styles.brandHeader}>
          <Text style={styles.brandTitle}>Dispatcher</Text>
          <Text style={styles.brandSubtitle}>Service Visit</Text>
        </View>

        <Card variant="surface" padding="xl" style={styles.stateCard}>
          <View style={[styles.iconCircle, { backgroundColor: Palette.neutral100 }]}>
            <Text style={[styles.iconText, { color: Palette.neutral600 }]}>—</Text>
          </View>
          <Text style={styles.stateHeading}>Tracking Unavailable</Text>
          <Text style={styles.stateDescription}>
            This tracking link is unavailable, expired, or the service visit has ended.
          </Text>
          <Text style={styles.stateSubtext}>
            If you need assistance or have questions regarding your appointment, please contact
            your service dispatch office.
          </Text>

          {payload?.business_phone ? (
            <Button
              label={`Call Dispatch (${payload.business_phone})`}
              variant="primary"
              size="md"
              fullWidth
              onPress={handleCallDispatch}
              style={styles.actionButton}
            />
          ) : null}
        </Card>
      </View>
    );
  }

  // Valid Job Status for badge
  const validStatus = (
    ['unassigned', 'assigned', 'accepted', 'on_the_way', 'arrived', 'in_progress', 'completed', 'cancelled'].includes(
      payload.status
    )
      ? payload.status
      : 'on_the_way'
  ) as JobStatus;

  // ---------------------------------------------------------------------------
  // STATES 2, 3, 4: VALID ACTIVE / LOCATION UNAVAILABLE / STALE
  // ---------------------------------------------------------------------------
  return (
    <ScrollView
      testID={testID}
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={() => loadTrackingData(true)}
          tintColor={Palette.neutral900}
        />
      }>
      <View style={styles.container}>
        {/* Header: Business & Service */}
        <View style={styles.header}>
          <View style={styles.headerTextGroup}>
            <Text style={styles.businessName} numberOfLines={1}>
              {payload.business_name}
            </Text>
            <Text style={styles.serviceTitle}>{payload.service}</Text>
          </View>
          <View style={styles.headerActionGroup}>
            <TouchableOpacity
              onPress={() => loadTrackingData(true)}
              style={styles.refreshButton}
              accessibilityRole="button"
              accessibilityLabel="Refresh status">
              <Text style={styles.refreshButtonText}>
                {isRefreshing ? '...' : 'Refresh'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Status Card */}
        <Card variant="surface" padding="base" style={styles.card}>
          <View style={styles.statusRow}>
            <StatusBadge status={validStatus} label={payload.status_label} size="md" />
            {lastRefreshedAt ? (
              <Text style={styles.lastRefreshedText}>
                Updated {lastRefreshedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </Text>
            ) : null}
          </View>

          {payload.tracking_message ? (
            <Text style={styles.trackingMessage}>{payload.tracking_message}</Text>
          ) : null}
        </Card>

        {/* Technician Info Card (First Name & Avatar Only) */}
        {payload.worker_first_name ? (
          <Card variant="surface" padding="base" style={styles.card}>
            <View style={styles.workerRow}>
              {payload.worker_avatar_url ? (
                <Image
                  source={{ uri: payload.worker_avatar_url }}
                  style={styles.workerAvatar}
                  accessibilityLabel={`${payload.worker_first_name}'s avatar`}
                />
              ) : (
                <View style={styles.workerAvatarPlaceholder}>
                  <Text style={styles.workerAvatarInitial}>
                    {payload.worker_first_name.charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={styles.workerInfo}>
                <Text style={styles.workerLabel}>Assigned Technician</Text>
                <Text style={styles.workerName}>{payload.worker_first_name}</Text>
              </View>
            </View>
          </Card>
        ) : null}

        {/* Stale Location Notice (State 4) */}
        {uiState === 'stale' ? (
          <View style={styles.staleNotice} testID={`${testID}-stale-banner`}>
            <View style={styles.staleDot} />
            <View style={styles.staleTextGroup}>
              <Text style={styles.staleTitle}>Location Update Delayed</Text>
              <Text style={styles.staleMessage}>
                Last GPS signal was received {formattedLocation.elapsedStr} ({formattedLocation.timeStr}).
                The technician may be driving through an area with weak cell reception.
              </Text>
            </View>
          </View>
        ) : null}

        {/* Location Temporarily Unavailable Notice (State 3) */}
        {uiState === 'location_unavailable' ? (
          <View style={styles.unavailableNotice} testID={`${testID}-unavailable-banner`}>
            <View style={styles.unavailableDot} />
            <View style={styles.unavailableTextGroup}>
              <Text style={styles.unavailableTitle}>GPS Telemetry Pending</Text>
              <Text style={styles.unavailableMessage}>
                Technician has been dispatched. Live map coordinates will appear here as soon as
                their device transmits its first location update.
              </Text>
            </View>
          </View>
        ) : null}

        {/* Map Section Placeholder (Ready for M13.6 Map Integration) */}
        <Card variant="surface" padding="base" style={styles.mapSectionCard}>
          <View style={styles.mapHeaderRow}>
            <Text style={styles.mapSectionTitle}>Live Service Map</Text>
            <View style={styles.mapStatusPill}>
              <View
                style={[
                  styles.mapStatusDot,
                  {
                    backgroundColor:
                      uiState === 'active'
                        ? Palette.greenDot
                        : uiState === 'stale'
                        ? Palette.amberDot
                        : Palette.neutral400,
                  },
                ]}
              />
              <Text style={styles.mapStatusLabel}>
                {uiState === 'active'
                  ? payload.status === 'arrived'
                    ? 'Arrived On-Site'
                    : payload.status === 'in_progress'
                    ? 'In Progress'
                    : 'GPS Active'
                  : uiState === 'stale'
                  ? 'GPS Delayed'
                  : 'Awaiting Telemetry'}
              </Text>
            </View>
          </View>

          {/* Interactive Live Web Map (Leaflet & OpenStreetMap) */}
          <CustomerTrackingMap
            workerLocation={payload.worker_location}
            destination={payload.destination}
            status={payload.status}
            statusLabel={payload.status_label}
            isStale={uiState === 'stale'}
            workerFirstName={payload.worker_first_name}
            businessName={payload.business_name}
            testID={`${testID}-interactive-map`}
          />

          {/* Poor GPS Accuracy Notice (when accuracy > 100m) */}
          {payload.worker_location?.accuracy && payload.worker_location.accuracy > 100 && uiState !== 'stale' ? (
            <View style={styles.accuracyBanner} testID={`${testID}-poor-accuracy-banner`}>
              <Text style={styles.accuracyBannerText}>
                Note: GPS accuracy is approximate (&plusmn;{Math.round(payload.worker_location.accuracy)}m) due to satellite signal reception.
              </Text>
            </View>
          ) : null}

          {/* Location Timestamp Footer */}
          <View style={styles.mapFooterRow}>
            <Text style={styles.mapFooterLabel}>Last Location Update</Text>
            <Text style={styles.mapFooterValue}>
              {payload.worker_location?.recorded_at
                ? `${formattedLocation.timeStr} (${formattedLocation.elapsedStr})`
                : 'Awaiting first update'}
            </Text>
          </View>
        </Card>

        {/* Call Dispatch Action (Primary CTA) */}
        {payload.business_phone ? (
          <View style={styles.actionContainer}>
            <Button
              label={`Call Dispatch (${payload.business_phone})`}
              variant="primary"
              size="lg"
              fullWidth
              onPress={handleCallDispatch}
              testID={`${testID}-call-dispatch`}
            />
          </View>
        ) : null}

        {/* Footer info: no IDs, no admin info, privacy notice */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Dispatcher Secure Tracking • Updates automatically
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centerContainer: {
    flex: 1,
    backgroundColor: Palette.neutral50,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.base,
    minHeight: '100%',
  },
  scrollContent: {
    flexGrow: 1,
    backgroundColor: Palette.neutral50,
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.base,
  },
  container: {
    width: '100%',
    maxWidth: 520,
    gap: Spacing.base,
  },
  brandHeader: {
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  brandTitle: {
    ...Typography.title,
    color: Palette.neutral900,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  brandSubtitle: {
    ...Typography.caption,
    color: Palette.neutral500,
    marginTop: 2,
  },
  stateCard: {
    width: '100%',
    maxWidth: 440,
    alignItems: 'center',
    textAlign: 'center',
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  iconText: {
    fontSize: 24,
    fontWeight: '700',
  },
  stateHeading: {
    ...Typography.title,
    color: Palette.neutral900,
    textAlign: 'center',
    marginBottom: Spacing.xs,
  },
  stateDescription: {
    ...Typography.body,
    color: Palette.neutral600,
    textAlign: 'center',
    marginBottom: Spacing.md,
  },
  stateSubtext: {
    ...Typography.caption,
    color: Palette.neutral500,
    textAlign: 'center',
    marginBottom: Spacing.lg,
  },
  actionButton: {
    marginTop: Spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: Spacing.xs,
  },
  headerTextGroup: {
    flex: 1,
    marginRight: Spacing.sm,
  },
  businessName: {
    ...Typography.captionMedium,
    color: Palette.neutral500,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  serviceTitle: {
    ...Typography.title,
    color: Palette.neutral900,
    fontWeight: '700',
  },
  headerActionGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  refreshButton: {
    minHeight: 36,
    paddingHorizontal: Spacing.sm + 4,
    paddingVertical: 6,
    borderRadius: Radii.pill,
    backgroundColor: Palette.white,
    borderWidth: 1,
    borderColor: Palette.neutral200,
    justifyContent: 'center',
    alignItems: 'center',
  },
  refreshButtonText: {
    ...Typography.captionMedium,
    color: Palette.neutral700,
  },
  card: {
    borderRadius: Radii.lg,
    backgroundColor: Palette.white,
    borderColor: Palette.neutral200,
    borderWidth: 1,
    ...Shadows.subtle,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.xs,
  },
  lastRefreshedText: {
    ...Typography.caption,
    color: Palette.neutral400,
  },
  trackingMessage: {
    ...Typography.body,
    color: Palette.neutral800,
    marginTop: Spacing.xs,
  },
  workerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  workerAvatar: {
    width: 44,
    height: 44,
    borderRadius: Radii.full,
    backgroundColor: Palette.neutral100,
  },
  workerAvatarPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: Radii.full,
    backgroundColor: Palette.neutral900,
    alignItems: 'center',
    justifyContent: 'center',
  },
  workerAvatarInitial: {
    ...Typography.headline,
    color: Palette.white,
    fontWeight: '700',
  },
  workerInfo: {
    flex: 1,
  },
  workerLabel: {
    ...Typography.caption,
    color: Palette.neutral500,
  },
  workerName: {
    ...Typography.headline,
    color: Palette.neutral900,
    fontWeight: '600',
  },
  staleNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: Palette.amberBg,
    borderColor: Palette.amberBorder,
    borderWidth: 1,
    borderRadius: Radii.base,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  staleDot: {
    width: 8,
    height: 8,
    borderRadius: Radii.full,
    backgroundColor: Palette.amberDot,
    marginTop: 5,
  },
  staleTextGroup: {
    flex: 1,
  },
  staleTitle: {
    ...Typography.captionMedium,
    color: Palette.amberText,
    fontWeight: '700',
  },
  staleMessage: {
    ...Typography.caption,
    color: Palette.amberText,
    marginTop: 2,
    lineHeight: 18,
  },
  unavailableNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: Palette.blueBg,
    borderColor: Palette.blueBorder,
    borderWidth: 1,
    borderRadius: Radii.base,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  unavailableDot: {
    width: 8,
    height: 8,
    borderRadius: Radii.full,
    backgroundColor: Palette.blueDot,
    marginTop: 5,
  },
  unavailableTextGroup: {
    flex: 1,
  },
  unavailableTitle: {
    ...Typography.captionMedium,
    color: Palette.blueText,
    fontWeight: '700',
  },
  unavailableMessage: {
    ...Typography.caption,
    color: Palette.blueText,
    marginTop: 2,
    lineHeight: 18,
  },
  mapSectionCard: {
    borderRadius: Radii.lg,
    backgroundColor: Palette.white,
    borderColor: Palette.neutral200,
    borderWidth: 1,
    overflow: 'hidden',
  },
  mapHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  mapSectionTitle: {
    ...Typography.headline,
    color: Palette.neutral900,
  },
  mapStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Palette.neutral100,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radii.pill,
    gap: 5,
  },
  mapStatusDot: {
    width: 6,
    height: 6,
    borderRadius: Radii.full,
  },
  mapStatusLabel: {
    ...Typography.caption,
    fontSize: 11,
    fontWeight: '600',
    color: Palette.neutral700,
  },
  mapCanvas: {
    height: 200,
    backgroundColor: '#F3F4F6',
    borderRadius: Radii.md,
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
    borderColor: Palette.neutral200,
    borderWidth: 1,
  },
  mapGridPattern: {
    ...StyleSheet.absoluteFill,
    opacity: 0.25,
  },
  gridLineHorizontal1: {
    position: 'absolute',
    top: '33%',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: Palette.neutral400,
  },
  gridLineHorizontal2: {
    position: 'absolute',
    top: '66%',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: Palette.neutral400,
  },
  gridLineVertical1: {
    position: 'absolute',
    left: '33%',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: Palette.neutral400,
  },
  gridLineVertical2: {
    position: 'absolute',
    left: '66%',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: Palette.neutral400,
  },
  mapCenterNotice: {
    alignItems: 'center',
    zIndex: 2,
    paddingHorizontal: Spacing.md,
  },
  mapPinGraphic: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xs,
  },
  mapPinPulse: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: Radii.full,
    backgroundColor: Palette.blueDot,
    opacity: 0.2,
  },
  mapPinCore: {
    width: 14,
    height: 14,
    borderRadius: Radii.full,
    backgroundColor: Palette.neutral900,
    borderWidth: 2,
    borderColor: Palette.white,
  },
  mapPlaceholderTitle: {
    ...Typography.captionMedium,
    color: Palette.neutral800,
    fontWeight: '700',
  },
  mapPlaceholderSubtitle: {
    ...Typography.caption,
    color: Palette.neutral500,
    marginTop: 2,
    textAlign: 'center',
  },
  mapFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: Spacing.sm,
    paddingTop: Spacing.xs,
    borderTopWidth: 1,
    borderTopColor: Palette.neutral100,
  },
  mapFooterLabel: {
    ...Typography.caption,
    color: Palette.neutral500,
  },
  mapFooterValue: {
    ...Typography.captionMedium,
    color: Palette.neutral800,
  },
  accuracyBanner: {
    marginTop: Spacing.xs,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    backgroundColor: Palette.amberBg,
    borderColor: Palette.amberBorder,
    borderWidth: 1,
    borderRadius: Radii.sm,
  },
  accuracyBannerText: {
    ...Typography.caption,
    fontSize: 12,
    color: Palette.amberText,
  },
  actionContainer: {
    marginTop: Spacing.xs,
  },
  footer: {
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  footerText: {
    ...Typography.caption,
    color: Palette.neutral400,
    fontSize: 12,
  },
});
