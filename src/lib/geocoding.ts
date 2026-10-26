/**
 * Dispatcher Geocoding Service
 *
 * Implements address geocoding for service locations adhering to:
 * - On-submit only execution (NEVER on keystrokes/typing).
 * - Single request per address with in-memory caching.
 * - Strict 3000ms timeout with graceful degradation.
 * - Safe null coordinates fallback when unresolved (jobs.latitude/longitude are nullable).
 * - Provider: OpenStreetMap Nominatim with compliant User-Agent and rate-limiting.
 *
 * Attribution: Uses OpenStreetMap data (ODbL).
 * Privacy Notice: Physical street addresses are sent to the OSM Nominatim service
 * over HTTPS. Coordinates are verified and bounded [-90, 90] / [-180, 180].
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface GeocodeResult {
  coordinates: Coordinates | null;
  error?: string;
  source: 'cache' | 'network' | 'fallback';
}

// In-memory cache to avoid duplicate network requests for the same address
const geocodeCache = new Map<string, Coordinates | null>();

// Throttle tracker to enforce OSM 1 req/sec guidelines
let lastRequestTimestamp = 0;
const MIN_REQUEST_INTERVAL_MS = 1100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalizes an address string for cache key lookup.
 */
function normalizeAddressKey(address: string): string {
  return address.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Geocodes an address string to latitude/longitude coordinates.
 * NEVER throws: on any error, timeout, or empty result, returns coordinates: null.
 *
 * @param address Physical service site address
 * @param timeoutMs Request timeout in milliseconds (defaults to 3000ms)
 */
export async function geocodeAddress(
  address: string,
  timeoutMs: number = 3000
): Promise<GeocodeResult> {
  const trimmed = address.trim();
  if (!trimmed) {
    return { coordinates: null, source: 'fallback' };
  }

  const cacheKey = normalizeAddressKey(trimmed);
  if (geocodeCache.has(cacheKey)) {
    return {
      coordinates: geocodeCache.get(cacheKey) ?? null,
      source: 'cache',
    };
  }

  // Rate limiting guard
  const now = Date.now();
  const timeSinceLast = now - lastRequestTimestamp;
  if (timeSinceLast < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - timeSinceLast);
  }
  lastRequestTimestamp = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const encoded = encodeURIComponent(trimmed);
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encoded}&limit=1`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Dispatcher-Mobile/1.0 (contact: dispatcher-app@example.com)',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (__DEV__) {
        console.warn('[Geocoding] Server responded with status:', response.status);
      }
      geocodeCache.set(cacheKey, null);
      return { coordinates: null, error: `Geocoding HTTP error ${response.status}`, source: 'fallback' };
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      geocodeCache.set(cacheKey, null);
      return { coordinates: null, error: 'Address could not be located on the map.', source: 'network' };
    }

    const firstResult = data[0];
    const lat = parseFloat(firstResult.lat);
    const lon = parseFloat(firstResult.lon);

    // Strict boundary validation
    if (
      typeof lat === 'number' &&
      !isNaN(lat) &&
      lat >= -90.0 &&
      lat <= 90.0 &&
      typeof lon === 'number' &&
      !isNaN(lon) &&
      lon >= -180.0 &&
      lon <= 180.0
    ) {
      const coords: Coordinates = { latitude: lat, longitude: lon };
      geocodeCache.set(cacheKey, coords);
      return { coordinates: coords, source: 'network' };
    }

    geocodeCache.set(cacheKey, null);
    return { coordinates: null, error: 'Invalid coordinate bounds returned.', source: 'fallback' };
  } catch (err: unknown) {
    clearTimeout(timeoutId);

    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));
    const errorMessage = isAbort ? 'Geocoding request timed out (3s).' : 'Network failure during geocoding.';

    if (__DEV__) {
      console.warn('[Geocoding] Lookup failed:', errorMessage);
    }

    // Cache null on timeout/error to prevent repeated stalling on retry with identical input
    geocodeCache.set(cacheKey, null);
    return { coordinates: null, error: errorMessage, source: 'fallback' };
  }
}
