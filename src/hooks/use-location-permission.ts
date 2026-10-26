/**
 * Dispatcher Location Permission Hook
 *
 * Coordinates the user-facing explanation modal and operating system permission requests.
 *
 * Responsibilities:
 * - Checks foreground permission status non-intrusively on mount and on demand.
 * - Displays the explanation modal before requesting OS permission.
 * - Handles granted, approximate, denied, blocked, and services-disabled outcomes gracefully.
 * - Prevents repetitive prompts by respecting in-session dismissal.
 * - Never blocks the technician's primary workflow if permission is denied.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Platform } from 'react-native';

import {
  checkBackgroundLocationPermissionStatus,
  checkLocationPermissionStatus,
  hasDismissedPermissionNotice,
  LOCATION_PERMISSION_EXPLANATION,
  LocationPermissionState,
  LocationPermissionStatusResult,
  requestBackgroundLocationPermission,
  requestForegroundLocationPermission,
  setDismissedPermissionNotice,
} from '@/lib/location-policy';

export interface UseLocationPermissionResult {
  /** Current evaluated foreground permission state */
  permissionState: LocationPermissionState;
  /** Current evaluated background permission state */
  backgroundPermissionState: LocationPermissionState;
  /** Whether the explanation modal is currently visible */
  isExplanationVisible: boolean;
  /** True while the OS permission dialog is in flight */
  isRequesting: boolean;
  /** Non-intrusively rechecks device services and permissions */
  checkPermissions: () => Promise<LocationPermissionStatusResult>;
  /**
   * Initiates permission check before entering an active job stage.
   * If permission is already granted or dismissed, executes onProceed immediately.
   * Otherwise, opens the explanation modal and awaits user choice.
   */
  ensurePermissionForTravel: (onProceed: () => void) => Promise<void>;
  /** Handler when technician taps "Allow Location Access" in the explanation modal */
  handleConfirmExplanation: () => Promise<void>;
  /** Handler when technician taps "Continue Without Location" in the explanation modal */
  handleDismissExplanation: () => void;
}

export function useLocationPermission(): UseLocationPermissionResult {
  const [permissionState, setPermissionState] = useState<LocationPermissionState>('NOT_REQUESTED');
  const [backgroundPermissionState, setBackgroundPermissionState] = useState<LocationPermissionState>('NOT_REQUESTED');
  const [isExplanationVisible, setIsExplanationVisible] = useState<boolean>(false);
  const [isRequesting, setIsRequesting] = useState<boolean>(false);
  const [pendingProceedCallback, setPendingProceedCallback] = useState<(() => void) | null>(null);

  // Inspect status on mount
  const checkPermissions = useCallback(async (): Promise<LocationPermissionStatusResult> => {
    const result = await checkLocationPermissionStatus();
    setPermissionState(result.state);

    if (result.state === 'GRANTED' || result.state === 'APPROXIMATE') {
      const bgResult = await checkBackgroundLocationPermissionStatus();
      setBackgroundPermissionState(bgResult.state);
    } else {
      setBackgroundPermissionState('DENIED');
    }

    return result;
  }, []);

  useEffect(() => {
    checkPermissions();
  }, [checkPermissions]);

  const ensurePermissionForTravel = useCallback(
    async (onProceed: () => void) => {
      const current = await checkLocationPermissionStatus();
      setPermissionState(current.state);

      // 1. If already granted (fine or approximate), proceed directly without showing modal
      if (current.state === 'GRANTED' || current.state === 'APPROXIMATE') {
        onProceed();
        return;
      }

      // 2. If technician already dismissed explanation in this session, do not re-prompt
      if (hasDismissedPermissionNotice()) {
        onProceed();
        return;
      }

      // 3. Otherwise, queue callback and show the user-facing explanation modal
      setPendingProceedCallback(() => onProceed);
      setIsExplanationVisible(true);
    },
    []
  );

  const handleConfirmExplanation = useCallback(async () => {
    setIsRequesting(true);
    try {
      const result = await requestForegroundLocationPermission();
      setPermissionState(result.state);
      setIsExplanationVisible(false);

      if (result.state === 'GRANTED' || result.state === 'APPROXIMATE') {
        const bgResult = await requestBackgroundLocationPermission();
        setBackgroundPermissionState(bgResult.state);
      } else {
        setBackgroundPermissionState('DENIED');
      }

      if (result.state === 'SERVICES_DISABLED') {
        Alert.alert(
          'Location Services Disabled',
          LOCATION_PERMISSION_EXPLANATION.servicesDisabledNotice,
          [
            {
              text: 'Open Settings',
              onPress: () => {
                if (Platform.OS === 'ios') {
                  Linking.openURL('App-Prefs:Privacy&path=LOCATION');
                } else {
                  Linking.openSettings();
                }
              },
            },
            {
              text: 'Continue Without GPS',
              style: 'cancel',
            },
          ]
        );
      } else if (result.state === 'APPROXIMATE') {
        Alert.alert(
          'Approximate Location Enabled',
          LOCATION_PERMISSION_EXPLANATION.approximateNotice,
          [{ text: 'OK' }]
        );
      } else if (result.state === 'DENIED' || result.state === 'BLOCKED') {
        Alert.alert(
          'Location Sharing Disabled',
          LOCATION_PERMISSION_EXPLANATION.deniedNotice,
          [{ text: 'OK' }]
        );
      }
    } finally {
      setIsRequesting(false);
      // Execute the pending action regardless of location result (technician is not blocked)
      if (pendingProceedCallback) {
        const callback = pendingProceedCallback;
        setPendingProceedCallback(null);
        callback();
      }
    }
  }, [pendingProceedCallback]);

  const handleDismissExplanation = useCallback(() => {
    setDismissedPermissionNotice(true);
    setIsExplanationVisible(false);

    // Proceed with the queued action without GPS
    if (pendingProceedCallback) {
      const callback = pendingProceedCallback;
      setPendingProceedCallback(null);
      callback();
    }
  }, [pendingProceedCallback]);

  return {
    permissionState,
    backgroundPermissionState,
    isExplanationVisible,
    isRequesting,
    checkPermissions,
    ensurePermissionForTravel,
    handleConfirmExplanation,
    handleDismissExplanation,
  };
}
