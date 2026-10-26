/**
 * Dispatcher Customer Tracking Session Service
 *
 * Implements M13.3 client-side operational layer for:
 * - Issuing server-controlled customer tracking links with 256-bit entropy.
 * - Secure token rotation (revoking superseded sessions).
 * - Explicit owner revocation.
 * - Public tracking lookup via SHA-256 validation RPC.
 * - Sanitized display formatting without leaking sensitive internal IDs.
 */

import { supabase } from '@/lib/supabase';

export interface IssuedTrackingSession {
  sessionId: string;
  jobId: string;
  rawToken: string;
  trackingUrl: string;
  expiresAt: string;
  createdAt: string;
  isActivated: boolean;
}

export interface CustomerTrackingPayload {
  service: string;
  status: string;
  status_label: string;
  scheduled_at: string | null;
  business_name: string;
  business_phone: string;
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
  tracking_message?: string;
  last_location_updated_at: string | null;
  estimated_arrival: string | null;
  session_expires_at: string;
  updated_at: string;
}

export {
  buildFullTrackingUrl,
  extractTrackingToken,
  isJobEligibleForTrackingIssuance,
} from './tracking-token';

/**
 * Generates or rotates a secure customer tracking session for a job.
 * Revokes any existing active tracking session for this job on the backend.
 *
 * @param jobId The target job UUID.
 * @param durationHours Validity duration in hours (1-72, default: 24).
 */
export async function generateTrackingSession(
  jobId: string,
  durationHours: number = 24
): Promise<{ success: boolean; session?: IssuedTrackingSession; error?: string }> {
  try {
    if (!jobId) {
      return { success: false, error: 'Job ID is required.' };
    }

    const { data, error } = await supabase.rpc('generate_customer_tracking_session', {
      p_job_id: jobId,
      p_duration_hours: durationHours,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    if (!data || data.length === 0) {
      return { success: false, error: 'No tracking session was generated.' };
    }

    const item = data[0];
    return {
      success: true,
      session: {
        sessionId: item.session_id,
        jobId: item.job_id,
        rawToken: item.raw_token,
        trackingUrl: item.tracking_url,
        expiresAt: item.expires_at,
        createdAt: item.created_at,
        isActivated: item.is_activated,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unexpected error generating tracking session.',
    };
  }
}

/**
 * Revokes an existing active tracking session for a job.
 */
export async function revokeTrackingSession(
  jobId: string,
  reason: string = 'owner_revoked'
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!jobId) {
      return { success: false, error: 'Job ID is required.' };
    }

    const { data, error } = await supabase.rpc('revoke_customer_tracking_session', {
      p_job_id: jobId,
      p_reason: reason,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: Boolean(data) };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unexpected error revoking tracking session.',
    };
  }
}

/**
 * Fetches the public sanitized customer tracking payload for a raw bearer token.
 * Returns null if token is invalid, expired, revoked, or job is terminal/reassigned.
 */
export async function fetchCustomerTrackingPayload(
  rawToken: string
): Promise<{ payload: CustomerTrackingPayload | null; error?: string }> {
  try {
    if (!rawToken || rawToken.trim().length < 16) {
      return { payload: null, error: 'Invalid tracking token format.' };
    }

    const { data, error } = await supabase.rpc('get_customer_tracking_session_job', {
      p_token: rawToken.trim(),
    });

    if (error) {
      return { payload: null, error: error.message };
    }

    if (!data || typeof data !== 'object') {
      return { payload: null };
    }

    return { payload: data as unknown as CustomerTrackingPayload };
  } catch (err) {
    return {
      payload: null,
      error: err instanceof Error ? err.message : 'Unexpected error fetching tracking payload.',
    };
  }
}

/**
 * Fetches the customer tracking payload via the M13.4 Public Customer Tracking API endpoint
 * (/functions/v1/customer-tracking).
 * Strictly transmits the token in a POST request body { token: "..." } to prevent token leakage
 * in intermediate access logs, CDN logs, or HTTP referrer headers.
 */
export async function fetchCustomerTrackingViaApi(
  rawToken: string,
  endpointBaseUrl?: string
): Promise<{ payload: CustomerTrackingPayload | null; error?: string; isNetworkError?: boolean }> {
  try {
    if (!rawToken || rawToken.trim().length < 16) {
      return { payload: null, error: 'Tracking session unavailable or expired.' };
    }

    const trimmed = rawToken.trim();

    // 1. Direct Edge Function HTTP endpoint (via POST request body)
    if (endpointBaseUrl) {
      const endpoint = `${endpointBaseUrl.replace(/\/+$/, '')}/functions/v1/customer-tracking`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ token: trimmed }),
      });

      if (!res.ok) {
        return { payload: null, error: 'Tracking session unavailable or expired.' };
      }

      const json = await res.json();
      if (!json || !json.data) {
        return { payload: null, error: 'Tracking session unavailable or expired.' };
      }
      return { payload: json.data as CustomerTrackingPayload };
    }

    // 2. Supabase functions client (which issues a POST request with the JSON body)
    const { data, error } = await supabase.functions.invoke('customer-tracking', {
      body: { token: trimmed },
    });

    if (error) {
      const isNetwork =
        error.message?.includes('network') ||
        error.message?.includes('Failed to fetch') ||
        error.message?.includes('NetworkError');
      return {
        payload: null,
        error: isNetwork
          ? 'Unable to connect to live tracking. Please check your network.'
          : 'Tracking session unavailable or expired.',
        isNetworkError: isNetwork,
      };
    }

    if (!data || !data.data) {
      return { payload: null, error: 'Tracking session unavailable or expired.' };
    }

    return { payload: data.data as CustomerTrackingPayload };
  } catch (err) {
    const isNetwork =
      err instanceof TypeError ||
      (err instanceof Error &&
        (err.message.includes('fetch') ||
          err.message.includes('Network') ||
          err.message.includes('offline')));
    return {
      payload: null,
      error: isNetwork
        ? 'Unable to connect to live tracking. Please check your network.'
        : 'Tracking session unavailable or expired.',
      isNetworkError: isNetwork,
    };
  }
}

