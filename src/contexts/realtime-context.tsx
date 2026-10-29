/**
 * Dispatcher Central Realtime Context & Provider
 *
 * Provides a single, app-wide Realtime subscription lifecycle tied authoritatively
 * to the authenticated session in AuthContext.
 *
 * Responsibilities:
 * - Maintains exactly ONE managed channel for the active user/role.
 * - Prevents duplicate channels during navigation or re-renders.
 * - Tears down channels cleanly on logout, deactivation, or role change.
 * - Listens to AppState to trigger reconciliation when returning to foreground.
 * - Exposes status, error, lastSignal, and reconcile() to screens and hooks.
 */

import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { logger } from '@/lib/logger';
import {
  checkRealtimeHealth,
  computeSubscriptionKey,
  createManagedJobsSubscription,
  ensureRealtimeSocketConnected,
  JobRealtimeSignal,
  ManagedJobsSubscription,
  RealtimeConnectionStatus,
  triggerJobsReconciliation,
  validateSubscriptionContext,
} from '@/lib/realtime';

export interface RealtimeContextValue {
  /** Current connection status of the managed Realtime channel */
  status: RealtimeConnectionStatus;
  /** True when the channel has successfully completed handshake with server */
  isSubscribed: boolean;
  /** Non-sensitive error message if connection or channel experienced an error */
  error: string | null;
  /** Most recently received job change signal */
  lastSignal: JobRealtimeSignal | null;
  /** The active privacy-safe topic name, or null if disconnected */
  channelTopic: string | null;
  /**
   * Triggers an authoritative reconciliation across all active screens.
   * Safe to call on screen focus, app resume, or manual pull-to-refresh.
   */
  reconcile: (reason?: string) => void;
  /**
   * Explicitly recovers or resubscribes the Realtime channel using documented Supabase APIs.
   * Safe to call from UI error banners or retry handlers.
   */
  reconnect: () => Promise<void>;
}

export const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const MAX_AUTO_RETRIES = 3;

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { session, user, role, businessId, isDeactivated, isLoading: isAuthLoading } = useAuth();

  const [status, setStatus] = useState<RealtimeConnectionStatus>('DISCONNECTED');
  const [error, setError] = useState<string | null>(null);
  const [lastSignal, setLastSignal] = useState<JobRealtimeSignal | null>(null);
  const [channelTopic, setChannelTopic] = useState<string | null>(null);

  // Synchronous ref mirroring status to avoid stale closure capture
  const statusRef = useRef<RealtimeConnectionStatus>('DISCONNECTED');
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Forward ref for establishSubscription auto-recovery calls
  const establishSubscriptionRef = useRef<(() => Promise<void>) | null>(null);

  // Guard against updating state after unmount
  const isMountedRef = useRef<boolean>(true);

  // Key tracking to prevent duplicate channel creation for identical auth context
  const activeSubscriptionKeyRef = useRef<string>('');
  const activeSubscriptionRef = useRef<ManagedJobsSubscription | null>(null);

  // Auto-recovery retry management
  const retryCountRef = useRef<number>(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean teardown helper
  const teardownActiveSubscription = useCallback(async () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    if (activeSubscriptionRef.current) {
      const sub = activeSubscriptionRef.current;
      activeSubscriptionRef.current = null;
      activeSubscriptionKeyRef.current = '';
      try {
        await sub.unsubscribe();
      } catch (err) {
        logger.warn('RealtimeProvider', 'Error during channel teardown:', err);
      }
    }
  }, []);

  // Primary subscription establishment function
  const establishSubscription = useCallback(async () => {
    if (!isMountedRef.current || isAuthLoading) {
      return;
    }

    // If user is logged out, deactivated, or missing required profile/business info:
    if (!session || isDeactivated || !role || !businessId) {
      await teardownActiveSubscription();
      if (isMountedRef.current) {
        setStatus('DISCONNECTED');
        setError(null);
        setChannelTopic(null);
      }
      return;
    }

    // Role-specific identity validation
    if (role === 'worker' && !user?.id) {
      await teardownActiveSubscription();
      if (isMountedRef.current) {
        setStatus('DISCONNECTED');
        setError(null);
        setChannelTopic(null);
      }
      return;
    }

    const config = {
      role,
      businessId,
      workerId: role === 'worker' ? user?.id : null,
    };

    const targetKey = computeSubscriptionKey(config);

    // Prevent duplicate subscriptions for identical context if channel is healthy
    const currentChannel = activeSubscriptionRef.current?.getChannel();
    if (
      activeSubscriptionRef.current &&
      activeSubscriptionKeyRef.current === targetKey &&
      statusRef.current === 'SUBSCRIBED' &&
      currentChannel?.state === 'joined'
    ) {
      return;
    }

    // Clean up previous channel before creating new one
    await teardownActiveSubscription();

    const { valid, reason } = validateSubscriptionContext(config);
    if (!valid) {
      logger.warn('RealtimeProvider', 'Invalid subscription context:', reason);
      if (isMountedRef.current) {
        setStatus('DISCONNECTED');
        setError(reason || 'Invalid context');
      }
      return;
    }

    if (isMountedRef.current) {
      setStatus('CONNECTING');
      setError(null);
    }

    try {
      const managedSub = createManagedJobsSubscription(config, {
        onStatusChange: (newStatus, errMessage) => {
          if (!isMountedRef.current) return;
          setStatus(newStatus);
          setError(errMessage ?? null);

          if (newStatus === 'SUBSCRIBED') {
            setChannelTopic(managedSub.getTopic());
            const hadRetries = retryCountRef.current > 0;
            retryCountRef.current = 0;
            // Reconcile missed jobs if recovered from temporary loss
            if (hadRetries) {
              triggerJobsReconciliation('reconnect');
            }
          } else if (newStatus === 'CHANNEL_ERROR' || newStatus === 'TIMED_OUT') {
            // Auto-recover with exponential backoff if below max retries
            if (retryCountRef.current < MAX_AUTO_RETRIES) {
              const delay = Math.min(1500 * Math.pow(2, retryCountRef.current), 8000);
              retryCountRef.current++;
              if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
              retryTimerRef.current = setTimeout(() => {
                if (isMountedRef.current) {
                  establishSubscriptionRef.current?.();
                }
              }, delay);
            }
          }
        },
        onSignal: (signal) => {
          if (!isMountedRef.current) return;
          setLastSignal(signal);
        },
      });

      activeSubscriptionRef.current = managedSub;
      activeSubscriptionKeyRef.current = targetKey;
      if (isMountedRef.current) {
        setChannelTopic(managedSub.getTopic());
      }
    } catch (err) {
      if (isMountedRef.current) {
        setStatus('CHANNEL_ERROR');
        setError(err instanceof Error ? err.message : 'Failed to initialize subscription');
      }
    }
  }, [
    session,
    user?.id,
    role,
    businessId,
    isDeactivated,
    isAuthLoading,
    teardownActiveSubscription,
  ]);

  useEffect(() => {
    establishSubscriptionRef.current = establishSubscription;
  }, [establishSubscription]);

  // Main subscription lifecycle effect
  useEffect(() => {
    isMountedRef.current = true;
    establishSubscription();

    return () => {
      // Cleanup on unmount or context transition
      teardownActiveSubscription();
    };
  }, [establishSubscription, teardownActiveSubscription]);

  // Explicit reconnect handler
  const handleReconnect = useCallback(async () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    retryCountRef.current = 0;
    ensureRealtimeSocketConnected();
    await establishSubscription();
  }, [establishSubscription]);

  // Handle AppState transitions (reconciliation on return to foreground)
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        // App returned to foreground: trigger an authoritative reconciliation signal
        triggerJobsReconciliation('app_foreground');

        // Check health of socket and subscription
        const channel = activeSubscriptionRef.current?.getChannel();
        const { isHealthy, isSocketConnected } = checkRealtimeHealth(undefined, channel);

        if (!isSocketConnected) {
          ensureRealtimeSocketConnected();
        }

        if (
          !isHealthy ||
          statusRef.current === 'CHANNEL_ERROR' ||
          statusRef.current === 'TIMED_OUT' ||
          statusRef.current === 'CLOSED'
        ) {
          handleReconnect();
        }
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      subscription.remove();
    };
  }, [handleReconnect]);

  // Clean unmount flag & cleanup
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  const handleReconcile = useCallback((reason: string = 'manual') => {
    triggerJobsReconciliation(reason);
  }, []);

  const value = useMemo<RealtimeContextValue>(
    () => ({
      status,
      isSubscribed: status === 'SUBSCRIBED',
      error,
      lastSignal,
      channelTopic,
      reconcile: handleReconcile,
      reconnect: handleReconnect,
    }),
    [status, error, lastSignal, channelTopic, handleReconcile, handleReconnect]
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
