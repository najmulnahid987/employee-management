/**
 * Dispatcher Foreground Location Tracker
 *
 * Implements M11.4 foreground-only GPS tracking:
 * - Subscribes to device position fixes via Expo Location watchPositionAsync.
 * - Enforces conservative intervals (30s / 50m travel, 3m / 150m on-site).
 * - Filters invalid coordinates, weak accuracy (>200m), and stationary duplicates (<10m / 60s).
 * - Coalesces network mutations via LocationCoalescingQueue to prevent unbounded queues.
 * - Submits atomic updates using Supabase record_worker_location RPC.
 * - Completely tears down on completion, cancellation, decline, sign-out, or teardown.
 */

import * as Location from 'expo-location';

import {
  evaluateCandidatePosition,
  LocationCoalescingQueue,
  ONSITE_TRACKING_PROFILE,
  RawCoordinates,
  TRAVEL_TRACKING_PROFILE,
} from '@/lib/location-tracker-core';
import { JobStatus } from '@/lib/location-rules';
import { supabase } from '@/lib/supabase';

export * from '@/lib/location-tracker-core';

export interface TrackerState {
  isTracking: boolean;
  trackingMode: 'INACTIVE' | 'HIGH_FREQUENCY' | 'LOW_FREQUENCY';
  activeJobId: string | null;
  lastPosition: RawCoordinates | null;
  lastSubmittedAt: string | null;
  isWriting: boolean;
  error: string | null;
}

export type TrackerStateListener = (state: TrackerState) => void;

export class ForegroundLocationTracker {
  private watcherSubscription: Location.LocationSubscription | null = null;
  private coalescingQueue: LocationCoalescingQueue | null = null;
  private activeJobId: string | null = null;
  private currentMode: 'INACTIVE' | 'HIGH_FREQUENCY' | 'LOW_FREQUENCY' = 'INACTIVE';
  private lastPosition: RawCoordinates | null = null;
  private lastSubmittedPosition: RawCoordinates | null = null;
  private lastSubmittedTimestampMs = 0;
  private lastSubmittedAtISO: string | null = null;
  private currentError: string | null = null;
  private listeners = new Set<TrackerStateListener>();

  constructor() {
    this.coalescingQueue = new LocationCoalescingQueue(async (coords) => {
      return this.executeServerWrite(coords);
    });
  }

  public getState(): TrackerState {
    return {
      isTracking: this.watcherSubscription !== null,
      trackingMode: this.currentMode,
      activeJobId: this.activeJobId,
      lastPosition: this.lastPosition,
      lastSubmittedAt: this.lastSubmittedAtISO,
      isWriting: this.coalescingQueue?.getIsWriting() ?? false,
      error: this.currentError,
    };
  }

  public subscribe(listener: TrackerStateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const state = this.getState();
    this.listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (err) {
        if (__DEV__) {
          console.warn('[LocationTracker] Listener error:', err);
        }
      }
    });
  }

  /**
   * Starts or reconfigures foreground GPS tracking for the specified job and lifecycle status.
   */
  public async startTracking(jobId: string, status: JobStatus): Promise<boolean> {
    if (!jobId) {
      this.stopTracking();
      return false;
    }

    // Determine target frequency mode based on M9 lifecycle
    let targetMode: 'HIGH_FREQUENCY' | 'LOW_FREQUENCY';
    if (status === 'on_the_way') {
      targetMode = 'HIGH_FREQUENCY';
    } else if (status === 'arrived' || status === 'in_progress') {
      targetMode = 'LOW_FREQUENCY';
    } else {
      // Pre-travel or terminal: tracking must not run
      this.stopTracking();
      return false;
    }

    // If already tracking the same job in the same mode, no reconfiguration needed
    if (
      this.watcherSubscription &&
      this.activeJobId === jobId &&
      this.currentMode === targetMode
    ) {
      return true;
    }

    // If switching jobs, reset previous positions so no stale coordinates are retained
    if (this.activeJobId !== jobId) {
      this.lastPosition = null;
      this.lastSubmittedPosition = null;
      this.lastSubmittedTimestampMs = 0;
      this.lastSubmittedAtISO = null;
      this.coalescingQueue?.clear();
    }

    this.coalescingQueue?.reset();
    this.activeJobId = jobId;
    this.currentMode = targetMode;
    this.currentError = null;

    // Remove existing watcher before configuring new mode
    if (this.watcherSubscription) {
      try {
        this.watcherSubscription.remove();
      } catch {
        // Ignore removal error
      }
      this.watcherSubscription = null;
    }

    const profile =
      targetMode === 'HIGH_FREQUENCY' ? TRAVEL_TRACKING_PROFILE : ONSITE_TRACKING_PROFILE;

    const options: Location.LocationOptions = {
      accuracy:
        targetMode === 'HIGH_FREQUENCY'
          ? Location.Accuracy.High
          : Location.Accuracy.Balanced,
      timeInterval: profile.timeIntervalMs,
      distanceInterval: profile.distanceIntervalMeters,
    };

    try {
      this.watcherSubscription = await Location.watchPositionAsync(
        options,
        (location: Location.LocationObject) => {
          this.handlePositionFix(location);
        },
        (error: string) => {
          this.currentError = `Location hardware error: ${error}`;
          this.notify();
        }
      );

      this.notify();
      return true;
    } catch (err) {
      this.currentError =
        err instanceof Error ? err.message : 'Failed to initialize location watcher.';
      this.stopTracking();
      this.notify();
      return false;
    }
  }

  /**
   * Processes a new device position fix.
   */
  private handlePositionFix(location: Location.LocationObject): void {
    if (!this.activeJobId || !location?.coords) return;

    const candidate: RawCoordinates = {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy ?? null,
      timestamp: location.timestamp,
    };

    this.lastPosition = candidate;

    // Evaluate position with conservative filtering
    const evaluation = evaluateCandidatePosition({
      candidate,
      lastSubmitted: this.lastSubmittedPosition,
      lastSubmittedTimestampMs: this.lastSubmittedTimestampMs,
      nowTimestampMs: Date.now(),
    });

    if (__DEV__) {
      console.log(`[LocationTracker] Fix: ${evaluation.reason}`);
    }

    if (!evaluation.shouldSubmit) {
      // Inaccuracy warning if above threshold
      if (candidate.accuracy && candidate.accuracy > 200) {
        this.currentError = `GPS accuracy low (±${Math.round(candidate.accuracy)}m). Waiting for better satellite fix.`;
      } else {
        this.currentError = null;
      }
      this.notify();
      return;
    }

    // Submit candidate fix to coalescing queue
    this.currentError = null;
    this.notify();
    this.coalescingQueue?.submit(candidate);
  }

  /**
   * Executes atomic server mutation via record_worker_location RPC.
   */
  private async executeServerWrite(coords: RawCoordinates): Promise<boolean> {
    const currentJobId = this.activeJobId;
    if (!currentJobId || this.currentMode === 'INACTIVE' || !this.watcherSubscription) {
      return false;
    }

    this.notify();

    try {
      const { error } = await supabase.rpc('record_worker_location', {
        p_job_id: currentJobId,
        p_latitude: coords.latitude,
        p_longitude: coords.longitude,
        p_accuracy: coords.accuracy,
      });

      // Discard response if tracking stopped or active job changed during in-flight network write
      if (this.activeJobId !== currentJobId || !this.watcherSubscription) {
        if (__DEV__) {
          console.log('[LocationTracker] In-flight write discarded: tracking stopped or job switched.');
        }
        return false;
      }

      if (error) {
        if (__DEV__) {
          console.warn('[LocationTracker] RPC write rejected:', error.message);
        }

        // If the job transitioned or authorization ended, stop tracking immediately
        if (
          error.message.includes('not in status') ||
          error.message.includes('not assigned') ||
          error.code === '42501' ||
          error.code === 'P0001'
        ) {
          this.currentError = 'Job is no longer in an active tracking stage.';
          this.stopTracking();
          return false;
        }

        this.currentError = `Failed to record location: ${error.message}`;
        this.notify();
        return false;
      }

      // Successful upload
      this.lastSubmittedPosition = coords;
      this.lastSubmittedTimestampMs = Date.now();
      this.lastSubmittedAtISO = new Date(this.lastSubmittedTimestampMs).toISOString();
      this.currentError = null;
      this.notify();
      return true;
    } catch (networkErr) {
      // Discard error update if tracking stopped in the meantime
      if (this.activeJobId !== currentJobId || !this.watcherSubscription) {
        return false;
      }

      this.currentError =
        networkErr instanceof Error
          ? networkErr.message
          : 'Network error recording location.';
      this.notify();
      return false;
    }
  }

  /**
   * Stops tracking immediately and cleans up subscriptions.
   */
  public stopTracking(): void {
    if (this.watcherSubscription) {
      try {
        this.watcherSubscription.remove();
      } catch {
        // Ignore error
      }
      this.watcherSubscription = null;
    }

    this.activeJobId = null;
    this.currentMode = 'INACTIVE';
    this.coalescingQueue?.clear();
    this.notify();
  }
}

// Global singleton instance for foreground tracking
export const foregroundLocationTracker = new ForegroundLocationTracker();
