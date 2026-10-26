/**
 * Dispatcher Location Tracking Policy & Permission Manager
 *
 * Re-exports pure tracking policy logic from location-policy-core
 * and provides Expo Location API integration.
 */

import * as Location from 'expo-location';

import {
  LOCATION_PERMISSION_EXPLANATION,
  LocationPermissionStatusResult,
} from './location-policy-core';

export * from './location-policy-core';

/**
 * Inspects device location services and app foreground permission without prompting the user.
 */
export async function checkLocationPermissionStatus(): Promise<LocationPermissionStatusResult> {
  try {
    const isServicesEnabled = await Location.hasServicesEnabledAsync();
    if (!isServicesEnabled) {
      return {
        state: 'SERVICES_DISABLED',
        isLocationServicesEnabled: false,
        canAskAgain: true,
        details: LOCATION_PERMISSION_EXPLANATION.servicesDisabledNotice,
      };
    }

    const permission = await Location.getForegroundPermissionsAsync();

    if (permission.status === Location.PermissionStatus.GRANTED) {
      // Check for approximate vs fine precision (Android 12+ / iOS 14+)
      const isCoarse =
        permission.android?.accuracy === 'coarse' ||
        permission.ios?.accuracy === 'reduced';

      return {
        state: isCoarse ? 'APPROXIMATE' : 'GRANTED',
        isLocationServicesEnabled: true,
        canAskAgain: permission.canAskAgain,
        details: isCoarse ? LOCATION_PERMISSION_EXPLANATION.approximateNotice : undefined,
      };
    }

    if (permission.status === Location.PermissionStatus.DENIED) {
      return {
        state: permission.canAskAgain ? 'DENIED' : 'BLOCKED',
        isLocationServicesEnabled: true,
        canAskAgain: permission.canAskAgain,
        details: LOCATION_PERMISSION_EXPLANATION.deniedNotice,
      };
    }

    if (permission.status === Location.PermissionStatus.UNDETERMINED) {
      return {
        state: 'NOT_REQUESTED',
        isLocationServicesEnabled: true,
        canAskAgain: true,
      };
    }

    return {
      state: 'RESTRICTED',
      isLocationServicesEnabled: true,
      canAskAgain: false,
      details: 'Location access is restricted by device policy.',
    };
  } catch (err) {
    if (__DEV__) {
      console.warn('[LocationPolicy] checkLocationPermissionStatus error:', err);
    }
    return {
      state: 'RESTRICTED',
      isLocationServicesEnabled: true,
      canAskAgain: false,
      details: err instanceof Error ? err.message : 'Unable to inspect location permissions.',
    };
  }
}

/**
 * Requests foreground location permission from the operating system.
 * Should only be called after the user-facing explanation has been acknowledged.
 */
export async function requestForegroundLocationPermission(): Promise<LocationPermissionStatusResult> {
  try {
    const isServicesEnabled = await Location.hasServicesEnabledAsync();
    if (!isServicesEnabled) {
      return {
        state: 'SERVICES_DISABLED',
        isLocationServicesEnabled: false,
        canAskAgain: true,
        details: LOCATION_PERMISSION_EXPLANATION.servicesDisabledNotice,
      };
    }

    const result = await Location.requestForegroundPermissionsAsync();

    if (result.status === Location.PermissionStatus.GRANTED) {
      const isCoarse =
        result.android?.accuracy === 'coarse' ||
        result.ios?.accuracy === 'reduced';

      return {
        state: isCoarse ? 'APPROXIMATE' : 'GRANTED',
        isLocationServicesEnabled: true,
        canAskAgain: result.canAskAgain,
        details: isCoarse ? LOCATION_PERMISSION_EXPLANATION.approximateNotice : undefined,
      };
    }

    return {
      state: result.canAskAgain ? 'DENIED' : 'BLOCKED',
      isLocationServicesEnabled: true,
      canAskAgain: result.canAskAgain,
      details: LOCATION_PERMISSION_EXPLANATION.deniedNotice,
    };
  } catch (err) {
    if (__DEV__) {
      console.warn('[LocationPolicy] requestForegroundLocationPermission error:', err);
    }
    return {
      state: 'DENIED',
      isLocationServicesEnabled: true,
      canAskAgain: false,
      details: err instanceof Error ? err.message : 'Failed to request location permissions.',
    };
  }
}

/**
 * Inspects device background location permission without prompting the user.
 */
export async function checkBackgroundLocationPermissionStatus(): Promise<LocationPermissionStatusResult> {
  try {
    const isServicesEnabled = await Location.hasServicesEnabledAsync();
    if (!isServicesEnabled) {
      return {
        state: 'SERVICES_DISABLED',
        isLocationServicesEnabled: false,
        canAskAgain: true,
        details: LOCATION_PERMISSION_EXPLANATION.servicesDisabledNotice,
      };
    }

    const foreground = await Location.getForegroundPermissionsAsync();
    if (foreground.status !== Location.PermissionStatus.GRANTED) {
      return {
        state: foreground.canAskAgain ? 'DENIED' : 'BLOCKED',
        isLocationServicesEnabled: true,
        canAskAgain: foreground.canAskAgain,
        details: 'Foreground location permission is required before background permission can be granted.',
      };
    }

    const bgPerm = await Location.getBackgroundPermissionsAsync();

    if (bgPerm.status === Location.PermissionStatus.GRANTED) {
      return {
        state: 'GRANTED',
        isLocationServicesEnabled: true,
        canAskAgain: bgPerm.canAskAgain,
      };
    }

    return {
      state: bgPerm.canAskAgain ? 'DENIED' : 'BLOCKED',
      isLocationServicesEnabled: true,
      canAskAgain: bgPerm.canAskAgain,
      details: 'Background location permission is not granted.',
    };
  } catch (err) {
    if (__DEV__) {
      console.warn('[LocationPolicy] checkBackgroundLocationPermissionStatus error:', err);
    }
    return {
      state: 'RESTRICTED',
      isLocationServicesEnabled: true,
      canAskAgain: false,
      details: err instanceof Error ? err.message : 'Unable to inspect background location permissions.',
    };
  }
}

/**
 * Requests background location permission from the operating system.
 * Must only be called after foreground permission is granted.
 */
export async function requestBackgroundLocationPermission(): Promise<LocationPermissionStatusResult> {
  try {
    const isServicesEnabled = await Location.hasServicesEnabledAsync();
    if (!isServicesEnabled) {
      return {
        state: 'SERVICES_DISABLED',
        isLocationServicesEnabled: false,
        canAskAgain: true,
        details: LOCATION_PERMISSION_EXPLANATION.servicesDisabledNotice,
      };
    }

    // Foreground permission must be granted first
    const foreground = await Location.getForegroundPermissionsAsync();
    if (foreground.status !== Location.PermissionStatus.GRANTED) {
      const requestedForeground = await Location.requestForegroundPermissionsAsync();
      if (requestedForeground.status !== Location.PermissionStatus.GRANTED) {
        return {
          state: requestedForeground.canAskAgain ? 'DENIED' : 'BLOCKED',
          isLocationServicesEnabled: true,
          canAskAgain: requestedForeground.canAskAgain,
          details: LOCATION_PERMISSION_EXPLANATION.deniedNotice,
        };
      }
    }

    // Request background permission
    const bgResult = await Location.requestBackgroundPermissionsAsync();

    if (bgResult.status === Location.PermissionStatus.GRANTED) {
      return {
        state: 'GRANTED',
        isLocationServicesEnabled: true,
        canAskAgain: bgResult.canAskAgain,
      };
    }

    return {
      state: bgResult.canAskAgain ? 'DENIED' : 'BLOCKED',
      isLocationServicesEnabled: true,
      canAskAgain: bgResult.canAskAgain,
      details: 'Background location permission was not granted.',
    };
  } catch (err) {
    if (__DEV__) {
      console.warn('[LocationPolicy] requestBackgroundLocationPermission error:', err);
    }
    return {
      state: 'DENIED',
      isLocationServicesEnabled: true,
      canAskAgain: false,
      details: err instanceof Error ? err.message : 'Failed to request background location permissions.',
    };
  }
}
