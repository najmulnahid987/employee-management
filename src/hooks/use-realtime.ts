/**
 * Dispatcher Realtime Hooks
 *
 * Exposes the central Realtime subscription state and signal listener hooks.
 */

import { useContext, useEffect } from 'react';

import { RealtimeContext, RealtimeContextValue } from '@/contexts/realtime-context';
import { JobRealtimeSignal, subscribeToJobSignals } from '@/lib/realtime';

/**
 * Accesses the central Realtime subscription manager context.
 * Provides connection status, active topic, errors, and manual reconcile function.
 */
export function useRealtime(): RealtimeContextValue {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error('useRealtime must be used within a <RealtimeProvider>');
  }
  return context;
}

/**
 * Hook allowing screens or services to subscribe to Realtime change signals.
 * Automatically unsubscribes when the component unmounts.
 */
export function useJobRealtimeSignal(onSignal: (signal: JobRealtimeSignal) => void): void {
  useEffect(() => {
    const unsubscribe = subscribeToJobSignals(onSignal);
    return unsubscribe;
  }, [onSignal]);
}
