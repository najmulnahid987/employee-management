/**
 * Dispatcher Notifications Service
 *
 * Integrates `expo-notifications` native module with Dispatcher's core configuration.
 *
 * Responsibilities:
 * 1. Configures the global foreground notification presentation handler.
 * 2. Creates the high-priority Android notification channel (`dispatcher-jobs`).
 * 3. Provides non-intrusive permission inspection (`getNotificationPermissionStatusAsync`).
 * 4. Provides explicit permission request function for subsequent onboarding steps
 *    without prompting immediately at app launch.
 * 5. Guarantees the application remains 100% usable if permission is denied or undetermined.
 */

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import {
  DeviceTokenRegistrationResult,
  DISPATCHER_NOTIFICATION_CHANNEL_CONFIG,
  DISPATCHER_NOTIFICATION_CHANNEL_ID,
  getNotificationPresentationOptions,
  isExpoPushToken,
  normalizeNotificationPermissionStatus,
  NotificationPermissionState,
  resolveEasProjectId,
} from '@/lib/notifications-core';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';

let Notifications: typeof import('expo-notifications') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Notifications = require('expo-notifications');
} catch (err) {
  logger.warn('Notifications', 'expo-notifications native module unavailable in this environment (e.g. Expo Go):', err);
  Notifications = null;
}

/**
 * Configure global foreground notification presentation handler.
 * Runs at module evaluation so incoming notifications are properly presented.
 */
try {
  if (Notifications?.setNotificationHandler) {
    Notifications.setNotificationHandler({
      handleNotification: async () => {
        const options = getNotificationPresentationOptions();
        return {
          shouldShowAlert: options.shouldShowAlert,
          shouldShowBanner: options.shouldShowBanner,
          shouldShowList: options.shouldShowList,
          shouldPlaySound: options.shouldPlaySound,
          shouldSetBadge: options.shouldSetBadge,
        };
      },
    });
  }
} catch (err) {
  logger.warn('Notifications', 'Failed to initialize notification handler:', err);
}

/**
 * Sets up the dedicated Android notification channel for mission-critical dispatch alerts.
 * Safe to call repeatedly; no-op on iOS and Web.
 */
export async function setupNotificationChannelsAsync(): Promise<void> {
  if (Platform.OS !== 'android' || !Notifications?.setNotificationChannelAsync) return;

  try {
    await Notifications.setNotificationChannelAsync(
      DISPATCHER_NOTIFICATION_CHANNEL_ID,
      {
        name: DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.name,
        description: DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.description,
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.vibrationPattern,
        lightColor: DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.lightColor,
        sound: DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.sound,
        enableVibrate: DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.enableVibrate,
        showBadge: DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.showBadge,
      }
    );
  } catch (err) {
    logger.warn('Notifications', 'Failed to configure Android notification channel:', err);
  }
}

/**
 * Non-intrusively inspects the current operating system notification permission status.
 * Never displays a system dialog to the user.
 */
export async function getNotificationPermissionStatusAsync(): Promise<NotificationPermissionState> {
  if (Platform.OS === 'web' || !Notifications?.getPermissionsAsync) return 'UNDETERMINED';

  try {
    const settings = await Notifications.getPermissionsAsync();
    return normalizeNotificationPermissionStatus(settings.status);
  } catch (err) {
    logger.warn('Notifications', 'Failed to query notification permissions:', err);
    return 'UNDETERMINED';
  }
}

/**
 * Prompts the user for notification permissions.
 * Designed to be called explicitly from an onboarding prompt or settings toggle,
 * NEVER automatically at initial application launch.
 */
export async function requestNotificationPermissionAsync(): Promise<NotificationPermissionState> {
  if (Platform.OS === 'web' || !Notifications?.requestPermissionsAsync) return 'UNDETERMINED';

  try {
    const settings = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: false,
        allowSound: true,
      },
    });
    return normalizeNotificationPermissionStatus(settings.status);
  } catch (err) {
    logger.warn('Notifications', 'Failed to request notification permissions:', err);
    return 'DENIED';
  }
}

// Automatically configure Android channels on launch
if (Platform.OS === 'android') {
  setupNotificationChannelsAsync().catch(() => {});
}

// In-memory cache of current registered token on this device
let currentRegisteredPushToken: string | null = null;
let isRegisteringToken = false;

/**
 * Returns the currently registered push token for this active device session.
 */
export function getCurrentRegisteredPushToken(): string | null {
  return currentRegisteredPushToken;
}

/**
 * Registers an Expo push token for the authenticated user.
 *
 * Safety & Invariants:
 * 1. Skips gracefully on simulators/emulators (expo-device isDevice === false).
 * 2. Skips gracefully if permission has not been granted by user (non-blocking).
 * 3. Never treats client token as proof of identity: backend RPC extracts auth.uid().
 * 4. Resolves EAS project ID dynamically from config / environment.
 * 5. Handles registration errors gracefully without interrupting login or job workflows.
 */
export async function registerPushTokenForAuthenticatedUserAsync(): Promise<DeviceTokenRegistrationResult> {
  if (Platform.OS === 'web') {
    return {
      success: false,
      reason: 'SIMULATOR_NOT_SUPPORTED',
      error: 'Web platform does not support Expo native push tokens',
    };
  }

  if (!Notifications?.getExpoPushTokenAsync) {
    return {
      success: false,
      reason: 'SIMULATOR_NOT_SUPPORTED',
      error: 'expo-notifications native module is not available in current environment (e.g. Expo Go)',
    };
  }

  // Simulator / emulator limitations: physical push tokens are not issued
  if (!Device.isDevice) {
    logger.info('Notifications', 'Running on simulator/emulator; push notifications are disabled.');
    return { success: false, reason: 'SIMULATOR_NOT_SUPPORTED' };
  }

  // Permission check: only proceed if user has explicitly granted permission
  const permissionState = await getNotificationPermissionStatusAsync();
  if (permissionState !== 'GRANTED') {
    return { success: false, reason: 'PERMISSION_NOT_GRANTED' };
  }

  if (isRegisteringToken) {
    return currentRegisteredPushToken
      ? { success: true, token: currentRegisteredPushToken }
      : { success: false, reason: 'TOKEN_UNAVAILABLE', error: 'Token registration already in flight' };
  }

  isRegisteringToken = true;
  try {
    const projectId = resolveEasProjectId(Constants.expoConfig);
    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );

    const token = tokenResponse?.data;
    if (!token || !isExpoPushToken(token)) {
      return {
        success: false,
        reason: 'TOKEN_UNAVAILABLE',
        error: 'Retrieved token does not match a valid Expo push token format',
      };
    }

    // Call server-side RPC register_device_token
    // RPC extracts caller identity strictly from auth.uid()
    const { data, error } = await supabase.rpc('register_device_token', {
      p_expo_push_token: token,
      p_device_platform: Platform.OS,
      p_device_name: Device.deviceName || Device.modelName || null,
      p_app_version: Constants.expoConfig?.version || '1.0.0',
    });

    if (error) {
      logger.warn('Notifications', 'Failed to register push token with backend:', error.message);
      return {
        success: false,
        reason: 'REGISTRATION_FAILED',
        error: error.message,
      };
    }

    currentRegisteredPushToken = token;
    return { success: true, token, id: data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error acquiring push token';
    logger.warn('Notifications', 'Exception acquiring push token:', message);
    return {
      success: false,
      reason: 'TOKEN_UNAVAILABLE',
      error: message,
    };
  } finally {
    isRegisteringToken = false;
  }
}

/**
 * Safely deactivates a device token upon user sign-out.
 * Scoped strictly to the authenticated user on the backend; will not delete
 * or deactivate tokens belonging to other accounts.
 */
export async function deactivateDeviceTokenAsync(
  tokenToDeactivate?: string | null
): Promise<boolean> {
  const token = tokenToDeactivate || currentRegisteredPushToken;
  if (!token) return false;

  try {
    const { data, error } = await supabase.rpc('deactivate_device_token', {
      p_expo_push_token: token,
    });

    if (error) {
      logger.warn('Notifications', 'Failed to deactivate device token:', error.message);
      return false;
    }

    if (currentRegisteredPushToken === token) {
      currentRegisteredPushToken = null;
    }
    return Boolean(data);
  } catch (err) {
    logger.warn('Notifications', 'Exception deactivating device token:', err);
    return false;
  }
}

/**
 * Listens for system push token rolls and re-registers the new token with the backend.
 */
export function setupPushTokenRefreshListener(
  onTokenRefresh?: (newToken: string) => void
): { unsubscribe: () => void } {
  if (Platform.OS === 'web' || !Notifications?.addPushTokenListener) {
    return { unsubscribe: () => {} };
  }

  try {
    const subscription = Notifications.addPushTokenListener((devicePushToken) => {
      const newToken = devicePushToken?.data;
      if (newToken && isExpoPushToken(newToken) && newToken !== currentRegisteredPushToken) {
        logger.info('Notifications', 'Push token refreshed by system, re-registering...');
        registerPushTokenForAuthenticatedUserAsync().catch(() => {});
        onTokenRefresh?.(newToken);
      }
    });

    return {
      unsubscribe: () => {
        subscription.remove();
      },
    };
  } catch (err) {
    logger.warn('Notifications', 'Failed to attach push token refresh listener:', err);
    return { unsubscribe: () => {} };
  }
}

