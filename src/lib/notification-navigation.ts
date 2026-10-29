/**
 * Dispatcher M15.6 — Native Notification Deep Linking & In-App Handling Service
 *
 * Connects Expo Notifications event listeners to Dispatcher navigation and UI:
 * 1. Warm-start notification tap listener (addNotificationResponseReceivedListener).
 * 2. Cold-start notification tap detection (getLastNotificationResponseAsync).
 * 3. Foreground notification arrival listener (addNotificationReceivedListener) triggering in-app banners.
 * 4. In-app notifications fetcher querying RLS-protected notification_deliveries table.
 * 5. Safe payload validation and role-correct routing.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import {
  ForegroundNotificationAlert,
  formatInAppNotification,
  FormattedInAppNotification,
  handleNotificationTapResponse,
  NotificationDeepLinkOptions,
  parseNotificationPayload,
  RawDeliveryRecord,
  resumePendingNotificationNavigation,
} from '@/lib/notification-navigation-core';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';

export {
  ForegroundNotificationAlert,
  NotificationDeepLinkOptions,
  handleNotificationTapResponse,
  resumePendingNotificationNavigation,
};

/**
 * Subscribes to notification deep link events across cold starts, warm starts, and foreground arrivals.
 * Returns an unsubscribe cleanup function to prevent memory leaks and duplicate listeners.
 */
export function setupNotificationDeepLinking(
  options: NotificationDeepLinkOptions
): { unsubscribe: () => void } {
  if (Platform.OS === 'web') {
    return { unsubscribe: () => {} };
  }

  const subscriptions: Notifications.EventSubscription[] = [];

  try {
    // 1. Cold-start check: Did the user launch the terminated app by tapping a notification?
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) {
          handleNotificationTapResponse(response, options);
        }
      })
      .catch((err) => {
        logger.warn('Notifications', 'Error inspecting cold-start notification:', err);
      });

    // 2. Warm-start listener: Notification tapped while app is in background or active
    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      handleNotificationTapResponse(response, options);
    });
    subscriptions.push(responseSub);

    // 3. Foreground arrival listener: Notification received while app is actively foregrounded
    const receivedSub = Notifications.addNotificationReceivedListener((notification) => {
      const rawData = notification?.request?.content?.data;
      const validated = parseNotificationPayload(rawData);
      if (validated && options.onForegroundNotification) {
        options.onForegroundNotification({
          title: notification.request.content.title || 'Job update',
          body: notification.request.content.body || 'Job updates are available.',
          jobId: validated.jobId,
          type: validated.type,
        });
      }
    });
    subscriptions.push(receivedSub);
  } catch (err) {
    logger.warn('Notifications', 'Failed to setup notification deep linking listeners:', err);
  }

  return {
    unsubscribe: () => {
      for (const sub of subscriptions) {
        try {
          sub.remove();
        } catch {}
      }
    },
  };
}

/**
 * Fetches the authenticated user's recent notifications from the RLS-protected
 * public.notification_deliveries table.
 */
export async function fetchUserInAppNotifications(): Promise<FormattedInAppNotification[]> {
  try {
    const { data, error } = await supabase
      .from('notification_deliveries')
      .select(`
        id,
        notification_type,
        status,
        created_at,
        delivered_at,
        job_events (
          job_id,
          metadata
        )
      `)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error || !Array.isArray(data)) {
      if (error) {
        logger.warn('Notifications', 'Error fetching in-app notifications:', error.message);
      }
      return [];
    }

    return (data as unknown as RawDeliveryRecord[])
      .map((row) => formatInAppNotification(row))
      .filter((item): item is FormattedInAppNotification => item !== null);
  } catch (err) {
    logger.warn('Notifications', 'Exception fetching in-app notifications:', err);
    return [];
  }
}
