/**
 * Dispatcher Customer Tracking Token Utilities
 *
 * Provides safe client-side extraction of customer tracking bearer tokens.
 * Prioritizes URL fragment/hash (#<token>) so that sensitive bearer tokens are
 * never transmitted over the wire in HTTP request URLs, proxy logs, or referrer headers.
 */

export function extractTrackingToken(options?: {
  pathToken?: string | string[];
  searchParamToken?: string | string[];
}): string | null {
  // 1. Check URL fragment/hash first (preferred for privacy: never sent in HTTP request URLs)
  if (typeof window !== 'undefined' && window.location && window.location.hash) {
    const rawHash = window.location.hash.replace(/^#\/?/, '').trim();
    if (rawHash.startsWith('token=')) {
      const match = rawHash.match(/token=([a-fA-F0-9]+)/);
      if (match && match[1] && match[1].length >= 16) {
        return match[1].trim();
      }
    } else if (rawHash.length >= 16) {
      // Direct token in hash e.g. /track#<token>
      const cleanHash = rawHash.split('?')[0].split('&')[0];
      if (/^[a-fA-F0-9]{16,128}$/.test(cleanHash)) {
        return cleanHash;
      }
    }
  }

  // 2. Check path parameter (e.g. /track/[token])
  if (options?.pathToken) {
    const raw = Array.isArray(options.pathToken) ? options.pathToken[0] : options.pathToken;
    if (raw && raw.trim().length >= 16 && /^[a-fA-F0-9]{16,128}$/.test(raw.trim())) {
      return raw.trim();
    }
  }

  // 3. Check query search parameter (e.g. /track?token=...)
  if (options?.searchParamToken) {
    const raw = Array.isArray(options.searchParamToken)
      ? options.searchParamToken[0]
      : options.searchParamToken;
    if (raw && raw.trim().length >= 16 && /^[a-fA-F0-9]{16,128}$/.test(raw.trim())) {
      return raw.trim();
    }
  }

  // 4. Web window.location.search fallback
  if (typeof window !== 'undefined' && window.location && window.location.search) {
    try {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      if (token && token.trim().length >= 16 && /^[a-fA-F0-9]{16,128}$/.test(token.trim())) {
        return token.trim();
      }
    } catch {
      // Ignore URL parsing errors
    }
  }

  return null;
}

/**
 * Checks whether a job's current status and assignment permit tracking link issuance.
 * Unassigned jobs (no worker) and terminal jobs ('completed' | 'cancelled') are strictly ineligible.
 */
export function isJobEligibleForTrackingIssuance(
  status: string | null | undefined,
  workerId: string | null | undefined
): boolean {
  if (!workerId || !status) return false;
  return ['assigned', 'accepted', 'on_the_way', 'arrived', 'in_progress'].includes(status);
}

/**
 * Constructs an absolute, shareable customer tracking URL using the preferred fragment format.
 * (e.g., https://domain.com/track#<token>).
 * Strictly relies on the cryptographically generated bearer token, avoiding any database IDs.
 */
export function buildFullTrackingUrl(rawTokenOrPath: string, customBaseUrl?: string): string {
  if (!rawTokenOrPath) return '';

  const clean = rawTokenOrPath.trim();
  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    return clean;
  }

  // Strip leading '/track/', '/track#', or '/'
  const token = clean.replace(/^\/?track[\/#]?/, '').replace(/^\//, '').trim();

  let base = customBaseUrl || (typeof process !== 'undefined' ? process.env?.EXPO_PUBLIC_CUSTOMER_TRACKING_BASE_URL : undefined);
  if (!base && typeof window !== 'undefined' && window.location && window.location.origin) {
    base = window.location.origin;
  }
  if (!base) {
    base = 'https://dispatcher.app';
  }

  return `${base.replace(/\/+$/, '')}/track#${token}`;
}
