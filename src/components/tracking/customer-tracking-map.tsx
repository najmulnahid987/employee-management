/**
 * Dispatcher M13.6 — Customer Tracking Web Map Component
 *
 * Implements interactive web map tracking using Leaflet and OpenStreetMap tiles:
 * - Free, open-source, zero API keys, no paid routing services.
 * - Prominent OpenStreetMap attribution: © OpenStreetMap contributors.
 * - Displays latest real coordinates returned by M13.4 public endpoint.
 * - Destination marker rendered ONLY if endpoint explicitly returns valid coordinates.
 * - Never fabricates positions, fake routes, or simulated movement.
 * - Visual accuracy uncertainty circle when GPS accuracy is reported.
 * - Explains approximate position if accuracy is poor (> 100m).
 * - Stale location (> 5m) changes marker styling to amber and stops presenting as live.
 * - On arrival or in_progress, updates marker to reflect actual on-site status.
 * - Isolated via secure sandboxed iframe: prevents style bleed and avoids native bundling conflicts.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { Palette, Radii, Spacing, Typography } from '@/constants/theme';

export interface CustomerTrackingMapProps {
  workerLocation: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    recorded_at?: string;
    is_stale?: boolean;
  } | null;
  destination: {
    latitude: number;
    longitude: number;
  } | null;
  status: string;
  statusLabel?: string;
  isStale?: boolean;
  workerFirstName?: string | null;
  businessName?: string;
  testID?: string;
}

/**
 * Builds self-contained HTML document with Leaflet & OpenStreetMap tiles.
 */
function buildMapHtml(initialPayload: {
  workerLocation: CustomerTrackingMapProps['workerLocation'];
  destination: CustomerTrackingMapProps['destination'];
  status: string;
  isStale: boolean;
  workerFirstName: string | null;
}): string {
  const jsonPayload = JSON.stringify(initialPayload).replace(/<\/script>/gi, '<\\/script>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    html, body, #map {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #F3F4F6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .leaflet-container {
      background: #F3F4F6 !important;
    }
    /* Worker Pin Styling */
    .worker-pin {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #171717;
      border: 3px solid #FFFFFF;
      box-shadow: 0 3px 8px rgba(0, 0, 0, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #FFFFFF;
      font-weight: 700;
      font-size: 14px;
      transition: all 0.3s ease;
    }
    .worker-pin.stale {
      background: #854D0E;
      border-color: #FEF08A;
      box-shadow: 0 2px 6px rgba(133, 77, 14, 0.4);
    }
    .worker-pin.arrived {
      background: #0E7490;
      border-color: #CFFAFE;
    }
    .worker-pin.in-progress {
      background: #9A3412;
      border-color: #FFEDD5;
    }
    /* Destination Pin */
    .dest-pin {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: #DC2626;
      border: 3px solid #FFFFFF;
      box-shadow: 0 3px 8px rgba(220, 38, 38, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #FFFFFF;
      font-size: 13px;
      font-weight: bold;
    }
    /* Attribution Styling */
    .leaflet-control-attribution {
      font-size: 10px !important;
      background: rgba(255, 255, 255, 0.85) !important;
      padding: 2px 6px !important;
      border-top-left-radius: 4px;
      color: #52525B !important;
    }
    .leaflet-control-attribution a {
      color: #171717 !important;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    let map = null;
    let workerMarker = null;
    let accuracyCircle = null;
    let destMarker = null;

    function initMap(data) {
      if (map) return;

      map = L.map('map', {
        zoomControl: false,
        attributionControl: true
      });

      L.control.zoom({ position: 'topright' }).addTo(map);

      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>'
      }).addTo(map);

      if (data) {
        updateMap(data);
      }
    }

    function updateMap(data) {
      if (!map) {
        initMap(data);
        return;
      }

      const { workerLocation, destination, status, isStale, workerFirstName } = data;
      const bounds = [];

      // 1. Destination Marker (Rendered ONLY if verified schema destination exists)
      if (
        destination &&
        typeof destination.latitude === 'number' &&
        typeof destination.longitude === 'number' &&
        !isNaN(destination.latitude) &&
        !isNaN(destination.longitude)
      ) {
        const destLatLng = [destination.latitude, destination.longitude];
        bounds.push(destLatLng);

        if (!destMarker) {
          const destIcon = L.divIcon({
            className: 'custom-dest-icon',
            html: '<div class="dest-pin">&#9733;</div>',
            iconSize: [28, 28],
            iconAnchor: [14, 14]
          });
          destMarker = L.marker(destLatLng, { icon: destIcon }).addTo(map);
          destMarker.bindPopup('<b>Service Destination</b>');
        } else {
          destMarker.setLatLng(destLatLng);
        }
      } else if (destMarker) {
        map.removeLayer(destMarker);
        destMarker = null;
      }

      // 2. Real Worker Marker
      if (
        workerLocation &&
        typeof workerLocation.latitude === 'number' &&
        typeof workerLocation.longitude === 'number' &&
        !isNaN(workerLocation.latitude) &&
        !isNaN(workerLocation.longitude)
      ) {
        const workerLatLng = [workerLocation.latitude, workerLocation.longitude];
        bounds.push(workerLatLng);

        let pinClass = 'worker-pin';
        let statusTitle = 'Technician is en route';
        if (isStale) {
          pinClass += ' stale';
          statusTitle = 'Last known position (Delayed)';
        } else if (status === 'arrived') {
          pinClass += ' arrived';
          statusTitle = 'Technician has arrived on-site';
        } else if (status === 'in_progress') {
          pinClass += ' in-progress';
          statusTitle = 'Work in progress';
        }

        const initial = workerFirstName ? workerFirstName.charAt(0).toUpperCase() : 'T';
        const workerIcon = L.divIcon({
          className: 'custom-worker-icon',
          html: '<div class="' + pinClass + '">' + initial + '</div>',
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        });

        if (!workerMarker) {
          workerMarker = L.marker(workerLatLng, { icon: workerIcon }).addTo(map);
        } else {
          workerMarker.setLatLng(workerLatLng);
          workerMarker.setIcon(workerIcon);
        }

        const popupText = '<b>' + (workerFirstName || 'Technician') + '</b><br/>' + statusTitle;
        workerMarker.bindPopup(popupText);

        // Accuracy Circle (Shows GPS uncertainty radius; hidden if stale)
        if (
          typeof workerLocation.accuracy === 'number' &&
          workerLocation.accuracy > 0 &&
          !isStale
        ) {
          if (!accuracyCircle) {
            accuracyCircle = L.circle(workerLatLng, {
              radius: workerLocation.accuracy,
              color: '#3B82F6',
              fillColor: '#3B82F6',
              fillOpacity: 0.15,
              weight: 1
            }).addTo(map);
          } else {
            accuracyCircle.setLatLng(workerLatLng);
            accuracyCircle.setRadius(workerLocation.accuracy);
          }
        } else if (accuracyCircle) {
          map.removeLayer(accuracyCircle);
          accuracyCircle = null;
        }
      } else {
        if (workerMarker) {
          map.removeLayer(workerMarker);
          workerMarker = null;
        }
        if (accuracyCircle) {
          map.removeLayer(accuracyCircle);
          accuracyCircle = null;
        }
      }

      // Fit map viewport smoothly to active bounds
      if (bounds.length === 1) {
        map.setView(bounds[0], 15);
      } else if (bounds.length > 1) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
      }
    }

    // Listen for parent postMessage telemetry updates without full page reloads
    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'UPDATE_TELEMETRY') {
        updateMap(event.data.payload);
      }
    });

    window.addEventListener('DOMContentLoaded', function() {
      const initial = ${jsonPayload};
      initMap(initial);
    });
  </script>
</body>
</html>`;
}

export function CustomerTrackingMap({
  workerLocation,
  destination,
  status,
  statusLabel,
  isStale = false,
  workerFirstName = null,
  businessName = 'Service Dispatch',
  testID = 'customer-tracking-map',
}: CustomerTrackingMapProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [isIframeLoaded, setIsIframeLoaded] = useState<boolean>(false);

  const hasWorkerCoords =
    workerLocation &&
    typeof workerLocation.latitude === 'number' &&
    typeof workerLocation.longitude === 'number' &&
    !isNaN(workerLocation.latitude) &&
    !isNaN(workerLocation.longitude);

  const hasDestCoords =
    destination &&
    typeof destination.latitude === 'number' &&
    typeof destination.longitude === 'number' &&
    !isNaN(destination.latitude) &&
    !isNaN(destination.longitude);

  const telemetryPayload = useMemo(() => {
    return {
      workerLocation,
      destination,
      status,
      isStale,
      workerFirstName,
    };
  }, [workerLocation, destination, status, isStale, workerFirstName]);

  // Initial HTML string for iframe (lazy initialized once on mount)
  const [initialHtml] = useState(() => buildMapHtml(telemetryPayload));

  // Post updates to iframe when coordinates, status, or freshness change
  useEffect(() => {
    if (Platform.OS !== 'web' || !iframeRef.current || !isIframeLoaded) return;

    try {
      iframeRef.current.contentWindow?.postMessage(
        {
          type: 'UPDATE_TELEMETRY',
          payload: telemetryPayload,
        },
        '*'
      );
    } catch {
      // Ignore cross-origin postMessage errors if sandboxed
    }
  }, [telemetryPayload, isIframeLoaded]);

  // Non-web or SSR fallback
  if (Platform.OS !== 'web') {
    return (
      <View style={styles.nativeFallbackContainer} testID={testID}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>OpenStreetMap Telemetry</Text>
        </View>
        <Text style={styles.fallbackTitle}>
          {hasWorkerCoords ? 'Worker Location Active' : 'Awaiting GPS Telemetry'}
        </Text>
        <Text style={styles.fallbackSubtitle}>
          {hasWorkerCoords
            ? `${workerFirstName || 'Technician'} coordinates: ${workerLocation?.latitude.toFixed(4)}, ${workerLocation?.longitude.toFixed(4)}`
            : 'Live coordinates stream automatically during active service visit.'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID={testID}>
      {/* Interactive Web Map Iframe */}
      <iframe
        ref={iframeRef}
        srcDoc={initialHtml}
        title={`Live tracking map for ${businessName}`}
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' } as any}
        onLoad={() => setIsIframeLoaded(true)}
        sandbox="allow-scripts allow-same-origin"
      />

      {/* Accuracy Uncertainty Warning Pill (if accuracy > 100m) */}
      {hasWorkerCoords && workerLocation?.accuracy && workerLocation.accuracy > 100 && !isStale ? (
        <View style={styles.accuracyWarningPill} testID={`${testID}-approximate-warning`}>
          <View style={styles.warningDot} />
          <Text style={styles.accuracyWarningText}>
            Position approximate (accuracy: &plusmn;{Math.round(workerLocation.accuracy)}m)
          </Text>
        </View>
      ) : null}

      {/* Stale Telemetry Notice Overlay */}
      {hasWorkerCoords && isStale ? (
        <View style={styles.staleOverlayBadge} testID={`${testID}-stale-overlay`}>
          <View style={styles.staleDot} />
          <Text style={styles.staleOverlayText}>Location delayed &bull; Not live</Text>
        </View>
      ) : null}

      {/* Waiting for Telemetry Overlay */}
      {!hasWorkerCoords && !hasDestCoords ? (
        <View style={styles.waitingOverlay} testID={`${testID}-waiting-overlay`}>
          <View style={styles.waitingPulse} />
          <Text style={styles.waitingTitle}>Connecting to Technician GPS</Text>
          <Text style={styles.waitingSubtitle}>
            Live map view will update automatically once technician device transmits signal.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 260,
    width: '100%',
    backgroundColor: '#F3F4F6',
    borderRadius: Radii.md,
    overflow: 'hidden',
    position: 'relative',
    borderColor: Palette.neutral200,
    borderWidth: 1,
  },
  accuracyWarningPill: {
    position: 'absolute',
    top: Spacing.sm,
    left: Spacing.sm,
    backgroundColor: 'rgba(254, 252, 232, 0.95)',
    borderColor: Palette.amberBorder,
    borderWidth: 1,
    borderRadius: Radii.pill,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    zIndex: 10,
    maxWidth: '85%',
  },
  warningDot: {
    width: 6,
    height: 6,
    borderRadius: Radii.full,
    backgroundColor: Palette.amberDot,
  },
  accuracyWarningText: {
    ...Typography.caption,
    fontSize: 11,
    fontWeight: '600',
    color: Palette.amberText,
  },
  staleOverlayBadge: {
    position: 'absolute',
    top: Spacing.sm,
    left: Spacing.sm,
    backgroundColor: 'rgba(254, 242, 242, 0.95)',
    borderColor: Palette.redBorder,
    borderWidth: 1,
    borderRadius: Radii.pill,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    zIndex: 10,
  },
  staleDot: {
    width: 6,
    height: 6,
    borderRadius: Radii.full,
    backgroundColor: Palette.redDot,
  },
  staleOverlayText: {
    ...Typography.caption,
    fontSize: 11,
    fontWeight: '600',
    color: Palette.redText,
  },
  waitingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(243, 244, 246, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.base,
    zIndex: 15,
  },
  waitingPulse: {
    width: 16,
    height: 16,
    borderRadius: Radii.full,
    backgroundColor: Palette.blueDot,
    marginBottom: Spacing.sm,
    opacity: 0.8,
  },
  waitingTitle: {
    ...Typography.headline,
    color: Palette.neutral900,
    textAlign: 'center',
  },
  waitingSubtitle: {
    ...Typography.caption,
    color: Palette.neutral500,
    textAlign: 'center',
    marginTop: 4,
    maxWidth: 280,
  },
  nativeFallbackContainer: {
    height: 240,
    width: '100%',
    backgroundColor: Palette.neutral100,
    borderRadius: Radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.base,
    borderColor: Palette.neutral200,
    borderWidth: 1,
  },
  badge: {
    backgroundColor: Palette.white,
    borderColor: Palette.neutral200,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radii.pill,
    marginBottom: Spacing.xs,
  },
  badgeText: {
    ...Typography.caption,
    fontSize: 11,
    fontWeight: '600',
    color: Palette.neutral600,
  },
  fallbackTitle: {
    ...Typography.headline,
    color: Palette.neutral900,
  },
  fallbackSubtitle: {
    ...Typography.caption,
    color: Palette.neutral500,
    textAlign: 'center',
    marginTop: 4,
    maxWidth: 300,
  },
});
