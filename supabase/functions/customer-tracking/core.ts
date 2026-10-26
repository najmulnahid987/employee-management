/**
 * Dispatcher M13.4 — Public Customer Tracking API Core
 *
 * Implements the server-side, unauthenticated read-only customer tracking endpoint.
 *
 * Responsibilities:
 * 1. Accept bearer token from query param, path, Authorization header, or JSON body.
 * 2. Validate token format, length, and character set before issuing queries.
 * 3. Never log raw tokens or full tracking URLs.
 * 4. Apply sliding-window rate limiting per client IP (60 req/min).
 * 5. Reject oversized request bodies (> 1KB) with HTTP 413.
 * 6. Enforce strict HTTP method controls (GET, POST, OPTIONS only).
 * 7. Set private, non-cacheable headers (Cache-Control: no-store).
 * 8. Return standard CORS headers.
 * 9. Execute authoritative lookup via get_customer_tracking_session_job RPC.
 * 10. Strictly sanitize the response: omit database IDs, raw tokens, hashes,
 *     customer contact details, internal notes, gate codes, and worker private info.
 * 11. Return generic 404 unavailable response for non-existent, expired, or revoked tokens.
 */

// Declare Deno runtime global for TypeScript compilers outside Deno
declare const Deno: any;

// =============================================================================
// Constants & Configuration
// =============================================================================

export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const RATE_LIMIT_MAX_REQUESTS = 60; // 60 requests per window
export const MAX_REQUEST_BODY_BYTES = 1024; // 1 KB
export const TOKEN_MIN_LENGTH = 16;
export const TOKEN_MAX_LENGTH = 128;
export const TOKEN_HEX_REGEX = /^[0-9a-fA-F]{16,128}$/;

export const DEFAULT_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
  'Access-Control-Max-Age': '86400',
};

export const PRIVATE_CACHE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
};

export const FORBIDDEN_RESPONSE_FIELDS = [
  'id',
  'job_id',
  'business_id',
  'worker_id',
  'session_id',
  'token',
  'raw_token',
  'token_hash',
  'customer_name',
  'customer_phone',
  'notes',
  'cancellation_reason',
  'worker_full_name',
  'worker_phone',
  'worker_email',
  'address',
] as const;

// =============================================================================
// Types & Interfaces
// =============================================================================

export interface AllowlistedCustomerTrackingData {
  business_name: string;
  business_phone: string;
  service: string;
  status: string;
  status_label: string;
  scheduled_at: string | null;
  worker_first_name: string | null;
  worker_avatar_url: string | null;
  destination: {
    latitude: number;
    longitude: number;
  } | null;
  worker_location: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    recorded_at: string;
    is_stale?: boolean;
  } | null;
  is_tracking_active: boolean;
  activated_at: string | null;
  tracking_message: string;
  last_location_updated_at: string | null;
  estimated_arrival: null;
  session_expires_at: string;
  updated_at: string;
}

export interface CustomerTrackingSuccessResponse {
  success: true;
  data: AllowlistedCustomerTrackingData;
}

export interface CustomerTrackingErrorResponse {
  success: false;
  data: null;
  error: string;
}

export type CustomerTrackingApiResponse =
  | CustomerTrackingSuccessResponse
  | CustomerTrackingErrorResponse;

export type DbRpcExecutor = (
  rpcName: string,
  params: Record<string, unknown>
) => Promise<{ data: unknown; error: unknown }>;

export interface CustomerTrackingHandlerOptions {
  dbExecutor?: DbRpcExecutor;
  rateLimiter?: InMemoryRateLimiter;
  nowMsProvider?: () => number;
  supabaseUrl?: string;
  supabaseKey?: string;
}

// =============================================================================
// Rate Limiter
// =============================================================================

export class InMemoryRateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();
  private windowMs: number;
  private maxRequests: number;

  constructor(windowMs = RATE_LIMIT_WINDOW_MS, maxRequests = RATE_LIMIT_MAX_REQUESTS) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  public check(ip: string, nowMs = Date.now()): { limited: boolean; retryAfterSeconds: number } {
    const key = ip || 'unknown-client';
    const record = this.windows.get(key);

    if (!record || nowMs >= record.resetAt) {
      this.windows.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return { limited: false, retryAfterSeconds: 0 };
    }

    if (record.count >= this.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - nowMs) / 1000));
      return { limited: true, retryAfterSeconds };
    }

    record.count += 1;
    return { limited: false, retryAfterSeconds: 0 };
  }

  public reset(): void {
    this.windows.clear();
  }
}

export const globalTrackingRateLimiter = new InMemoryRateLimiter();

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extracts client IP address from headers safely.
 */
export function extractClientIp(req: Request): string {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const firstIp = forwardedFor.split(',')[0].trim();
    if (firstIp) return firstIp;
  }

  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim();

  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  return 'unknown-client';
}

/**
 * Validates token format, length, and character bounds without logging the token.
 */
export function validateTokenFormat(token: unknown): token is string {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  if (trimmed.length < TOKEN_MIN_LENGTH || trimmed.length > TOKEN_MAX_LENGTH) {
    return false;
  }
  return TOKEN_HEX_REGEX.test(trimmed);
}

/**
 * Computes deterministic SHA-256 hash using standard Web Crypto API.
 */
export async function computeTokenSha256Hex(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token.trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Extracts bearer token from URL search param, path, header, or body.
 */
export async function extractBearerToken(
  req: Request
): Promise<{ token: string | null; error?: string; status?: number }> {
  const url = new URL(req.url);

  // 1. Query parameter ?token=...
  const queryToken = url.searchParams.get('token');
  if (queryToken && queryToken.trim().length > 0) {
    return { token: queryToken.trim() };
  }

  // 2. URL path parameter /customer-tracking/:token or /track/:token
  const pathParts = url.pathname.split('/').filter(Boolean);
  const lastSegment = pathParts[pathParts.length - 1];
  if (lastSegment && lastSegment !== 'customer-tracking' && lastSegment !== 'track') {
    if (validateTokenFormat(lastSegment)) {
      return { token: lastSegment.trim() };
    }
  }

  // 3. Authorization: Bearer <token>
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const candidate = authHeader.slice(7).trim();
    // Exclude Supabase JWT tokens (which typically have 2 periods in format x.y.z)
    if (!candidate.includes('.') && validateTokenFormat(candidate)) {
      return { token: candidate };
    }
  }

  // 4. Request JSON body for POST requests
  if (req.method === 'POST') {
    const contentLength = req.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_REQUEST_BODY_BYTES) {
      return { token: null, error: 'Request payload too large.', status: 413 };
    }

    try {
      const clonedReq = req.clone();
      const text = await clonedReq.text();
      if (text.length > MAX_REQUEST_BODY_BYTES) {
        return { token: null, error: 'Request payload too large.', status: 413 };
      }
      if (text.trim().length > 0) {
        const body = JSON.parse(text);
        if (body && typeof body === 'object' && typeof body.token === 'string') {
          return { token: body.token.trim() };
        }
      }
    } catch {
      return { token: null, error: 'Malformed JSON payload.', status: 400 };
    }
  }

  return { token: null };
}

/**
 * Creates a standard JSON response with security, CORS, and cache-control headers.
 */
export function createApiResponse(
  payload: Record<string, unknown>,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...DEFAULT_CORS_HEADERS,
      ...PRIVATE_CACHE_HEADERS,
      ...extraHeaders,
    },
  });
}

/**
 * Sanitizes the raw database payload, ensuring strict allowlist compliance
 * and zero forbidden fields in the response.
 */
export function sanitizeCustomerTrackingPayload(
  raw: Record<string, unknown>
): AllowlistedCustomerTrackingData {
  // Validate destination coordinates
  let destination: { latitude: number; longitude: number } | null = null;
  if (raw.destination && typeof raw.destination === 'object') {
    const dest = raw.destination as Record<string, unknown>;
    if (
      typeof dest.latitude === 'number' &&
      !isNaN(dest.latitude) &&
      typeof dest.longitude === 'number' &&
      !isNaN(dest.longitude)
    ) {
      destination = {
        latitude: dest.latitude,
        longitude: dest.longitude,
      };
    }
  }

  // Validate worker coordinates
  let workerLocation: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    recorded_at: string;
    is_stale?: boolean;
  } | null = null;

  if (raw.worker_location && typeof raw.worker_location === 'object') {
    const loc = raw.worker_location as Record<string, unknown>;
    if (
      typeof loc.latitude === 'number' &&
      !isNaN(loc.latitude) &&
      typeof loc.longitude === 'number' &&
      !isNaN(loc.longitude)
    ) {
      workerLocation = {
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracy: typeof loc.accuracy === 'number' ? loc.accuracy : null,
        recorded_at: typeof loc.recorded_at === 'string' ? loc.recorded_at : new Date().toISOString(),
        is_stale: typeof loc.is_stale === 'boolean' ? loc.is_stale : false,
      };
    }
  }

  return {
    business_name: typeof raw.business_name === 'string' ? raw.business_name : 'Service Dispatch',
    business_phone: typeof raw.business_phone === 'string' ? raw.business_phone : '',
    service: typeof raw.service === 'string' ? raw.service : 'Service Visit',
    status: typeof raw.status === 'string' ? raw.status : 'scheduled',
    status_label: typeof raw.status_label === 'string' ? raw.status_label : 'Status pending',
    scheduled_at: typeof raw.scheduled_at === 'string' ? raw.scheduled_at : null,
    worker_first_name: typeof raw.worker_first_name === 'string' ? raw.worker_first_name : null,
    worker_avatar_url: typeof raw.worker_avatar_url === 'string' ? raw.worker_avatar_url : null,
    destination,
    worker_location: workerLocation,
    is_tracking_active: Boolean(raw.is_tracking_active),
    activated_at: typeof raw.activated_at === 'string' ? raw.activated_at : null,
    tracking_message:
      typeof raw.tracking_message === 'string'
        ? raw.tracking_message
        : Boolean(raw.is_tracking_active)
        ? 'Technician is en route.'
        : 'Technician has not started travel yet.',
    last_location_updated_at:
      typeof raw.last_location_updated_at === 'string' ? raw.last_location_updated_at : null,
    estimated_arrival: null,
    session_expires_at:
      typeof raw.session_expires_at === 'string'
        ? raw.session_expires_at
        : new Date(Date.now() + 86400000).toISOString(),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date().toISOString(),
  };
}

// =============================================================================
// Default Database Executor (via PostgREST RPC)
// =============================================================================

export function createDefaultDbExecutor(url?: string, key?: string): DbRpcExecutor {
  return async (rpcName: string, params: Record<string, unknown>) => {
    // Determine runtime environment variables (Deno, process.env, or explicit params)
    const envUrl =
      url ||
      (typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_URL') : null) ||
      (typeof process !== 'undefined' ? process.env?.SUPABASE_URL : null);

    const envKey =
      key ||
      (typeof Deno !== 'undefined'
        ? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')
        : null) ||
      (typeof process !== 'undefined'
        ? process.env?.SUPABASE_SERVICE_ROLE_KEY || process.env?.SUPABASE_ANON_KEY
        : null);

    if (!envUrl || !envKey) {
      return {
        data: null,
        error: new Error('Server configuration error: missing database credentials.'),
      };
    }

    try {
      const endpoint = `${envUrl.replace(/\/+$/, '')}/rest/v1/rpc/${rpcName}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': envKey,
          'Authorization': `Bearer ${envKey}`,
        },
        body: JSON.stringify(params),
      });

      if (!res.ok) {
        return { data: null, error: new Error(`Database error: ${res.statusText}`) };
      }

      const json = await res.json();
      return { data: json, error: null };
    } catch (err) {
      return {
        data: null,
        error: err instanceof Error ? err : new Error('Network error connecting to database.'),
      };
    }
  };
}

// =============================================================================
// Main Request Handler
// =============================================================================

export async function handleCustomerTrackingRequest(
  req: Request,
  options: CustomerTrackingHandlerOptions = {}
): Promise<Response> {
  // 1. Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: DEFAULT_CORS_HEADERS,
    });
  }

  // 2. Enforce Allowed HTTP Methods (GET, POST only)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return createApiResponse(
      { success: false, error: 'Method not allowed. Use GET or POST.' },
      405,
      { 'Allow': 'GET, POST, OPTIONS' }
    );
  }

  // 3. Client IP Extraction & Sliding-Window Rate Limiting
  const rateLimiter = options.rateLimiter || globalTrackingRateLimiter;
  const clientIp = extractClientIp(req);
  const nowMs = options.nowMsProvider ? options.nowMsProvider() : Date.now();
  const rateLimitStatus = rateLimiter.check(clientIp, nowMs);

  if (rateLimitStatus.limited) {
    return createApiResponse(
      {
        success: false,
        error: 'Too many requests. Please wait before trying again.',
      },
      429,
      { 'Retry-After': String(rateLimitStatus.retryAfterSeconds) }
    );
  }

  // 4. Extract Token from Query, Path, Header, or Body
  const extraction = await extractBearerToken(req);
  if (extraction.error) {
    return createApiResponse(
      { success: false, data: null, error: extraction.error },
      extraction.status || 400
    );
  }

  const rawToken = extraction.token;

  // 5. Validate Token Format and Length Before Querying
  // Return generic 404 response immediately on invalid format without logging the token
  if (!rawToken || !validateTokenFormat(rawToken)) {
    return createApiResponse(
      {
        success: false,
        data: null,
        error: 'Tracking session unavailable or expired.',
      },
      404
    );
  }

  // 6. Execute Authoritative Database Lookup via get_customer_tracking_session_job RPC
  const dbExecutor =
    options.dbExecutor ||
    createDefaultDbExecutor(options.supabaseUrl, options.supabaseKey);

  try {
    const { data, error } = await dbExecutor('get_customer_tracking_session_job', {
      p_token: rawToken,
    });

    if (error) {
      // Return generic 404 without leaking database internals
      return createApiResponse(
        {
          success: false,
          data: null,
          error: 'Tracking session unavailable or expired.',
        },
        404
      );
    }

    if (!data || typeof data !== 'object') {
      // Non-existent, expired, revoked, terminal, or reassigned job returns generic 404
      return createApiResponse(
        {
          success: false,
          data: null,
          error: 'Tracking session unavailable or expired.',
        },
        404
      );
    }

    // 7. Strict Allowlist Projection
    const sanitizedData = sanitizeCustomerTrackingPayload(data as Record<string, unknown>);

    return createApiResponse(
      {
        success: true,
        data: sanitizedData,
      },
      200
    );
  } catch {
    // Anti-enumeration: Generic unavailable response on unexpected error
    return createApiResponse(
      {
        success: false,
        data: null,
        error: 'Tracking session unavailable or expired.',
      },
      404
    );
  }
}
