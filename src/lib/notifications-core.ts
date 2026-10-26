/**
 * Dispatcher Notifications Core Logic & Configuration
 *
 * Implements pure logic, channel configuration, presentation options,
 * permission state normalization, and user-friendly onboarding explanation
 * content for push and local notifications.
 *
 * Guarantees:
 * 1. Pure TypeScript functions without native dependencies for cross-platform
 *    safety and 100% unit testability.
 * 2. Non-blocking permission architecture: The application remains 100% usable
 *    even if notification permissions are denied or disabled.
 * 3. Aligned with Expo SDK 57 notifications specifications.
 */

/**
 * High-priority Android notification channel for mission-critical job dispatch alerts.
 */
export const DISPATCHER_NOTIFICATION_CHANNEL_ID = 'dispatcher-jobs';

export interface NotificationChannelDefinition {
  id: string;
  name: string;
  description: string;
  importance: number; // Matches AndroidImportance.HIGH (4)
  vibrationPattern: number[];
  lightColor: string;
  sound: string;
  enableVibrate: boolean;
  showBadge: boolean;
}

export const DISPATCHER_NOTIFICATION_CHANNEL_CONFIG: NotificationChannelDefinition = {
  id: DISPATCHER_NOTIFICATION_CHANNEL_ID,
  name: 'Job Updates',
  description: 'Critical dispatch, assignment, arrival, and completion alerts for service visits',
  importance: 4, // AndroidImportance.HIGH
  vibrationPattern: [0, 250, 250, 250],
  lightColor: '#000000',
  sound: 'default',
  enableVibrate: true,
  showBadge: false,
};

/**
 * Standard foreground notification presentation options for the Expo notification handler.
 */
export interface NotificationPresentationOptions {
  shouldShowAlert?: boolean;
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

export function getNotificationPresentationOptions(): NotificationPresentationOptions {
  return {
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  };
}

/**
 * Normalized notification permission states for clear cross-platform policy handling.
 */
export type NotificationPermissionState = 'GRANTED' | 'DENIED' | 'UNDETERMINED';

export function normalizeNotificationPermissionStatus(
  status?: string | null
): NotificationPermissionState {
  if (status === 'granted') {
    return 'GRANTED';
  }
  if (status === 'denied') {
    return 'DENIED';
  }
  return 'UNDETERMINED';
}

export function isNotificationPermissionGranted(state: NotificationPermissionState): boolean {
  return state === 'GRANTED';
}

export function shouldPromptForNotificationPermission(
  state: NotificationPermissionState
): boolean {
  return state === 'UNDETERMINED';
}

/**
 * User-friendly onboarding explanation content.
 * Designed for a non-intrusive onboarding prompt at a later appropriate point.
 */
export interface NotificationPermissionExplanation {
  title: string;
  subtitle: string;
  reasons: string[];
  primaryAction: string;
  dismissAction: string;
  deniedNotice: string;
}

export const NOTIFICATION_PERMISSION_EXPLANATION: NotificationPermissionExplanation = {
  title: 'Stay Updated in Real Time',
  subtitle: 'Enable mission-critical dispatch and job status notifications.',
  reasons: [
    'Immediate alerts when new service visits are assigned to your queue',
    'Real-time updates when technicians accept, arrive on-site, and complete work',
    'Zero marketing, ads, or background spam — operational dispatch alerts only',
  ],
  primaryAction: 'Enable Notifications',
  dismissAction: 'Not Now',
  deniedNotice:
    'Notifications are disabled. Dispatcher remains fully functional, and you can re-enable alerts anytime in device Settings.',
};

/**
 * Resolves the EAS Project ID from available environment variables or Expo config.
 */
export function resolveEasProjectId(
  expoConfig?: { extra?: { eas?: { projectId?: string } } } | null,
  envOverride?: string | null
): string | undefined {
  if (typeof envOverride === 'string' && envOverride.trim().length > 0) {
    return envOverride.trim();
  }
  if (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_EAS_PROJECT_ID) {
    const fromEnv = process.env.EXPO_PUBLIC_EAS_PROJECT_ID.trim();
    if (fromEnv.length > 0) return fromEnv;
  }
  if (expoConfig?.extra?.eas?.projectId) {
    const fromConfig = expoConfig.extra.eas.projectId.trim();
    if (fromConfig.length > 0) return fromConfig;
  }
  return undefined;
}

/**
 * Validates whether a given string is a plausible Expo push token.
 * Matches traditional ExponentPushToken[...] and standard UUID tokens.
 */
export function isExpoPushToken(token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  if (trimmed.length < 10) return false;

  // Traditional ExponentPushToken[...] format
  if (trimmed.startsWith('ExponentPushToken[') && trimmed.endsWith(']')) {
    return true;
  }
  // Expo Push Token UUIDv4 format (36 chars)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(trimmed)) {
    return true;
  }
  // Generic high-entropy token fallback (>= 20 chars without spaces)
  if (trimmed.length >= 20 && !trimmed.includes(' ')) {
    return true;
  }
  return false;
}

export type DevicePlatform = 'ios' | 'android' | 'web' | 'unknown';

export interface DeviceTokenRegistrationParams {
  expoPushToken: string;
  devicePlatform?: DevicePlatform;
  deviceName?: string | null;
  appVersion?: string | null;
}

export type DeviceTokenRegistrationResult =
  | { success: true; token: string; id?: string }
  | {
      success: false;
      reason:
        | 'SIMULATOR_NOT_SUPPORTED'
        | 'PERMISSION_NOT_GRANTED'
        | 'UNAUTHENTICATED'
        | 'TOKEN_UNAVAILABLE'
        | 'REGISTRATION_FAILED';
      error?: string;
    };

