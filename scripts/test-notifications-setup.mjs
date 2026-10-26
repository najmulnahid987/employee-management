/**
 * Dispatcher M15.2 — Expo Notifications Setup Test Suite
 *
 * Validates:
 * 1. Notification channel definition and priority parameters.
 * 2. Foreground presentation handler configuration.
 * 3. Permission state normalization and non-blocking policy rules.
 * 4. User-friendly onboarding explanation content.
 * 5. Configuration integrity across package.json, app.json, and root layout.
 *
 * Execution:
 * node --test --experimental-strip-types scripts/test-notifications-setup.mjs
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  DISPATCHER_NOTIFICATION_CHANNEL_CONFIG,
  DISPATCHER_NOTIFICATION_CHANNEL_ID,
  getNotificationPresentationOptions,
  isNotificationPermissionGranted,
  normalizeNotificationPermissionStatus,
  NOTIFICATION_PERMISSION_EXPLANATION,
  shouldPromptForNotificationPermission,
} from '../src/lib/notifications-core.ts';

describe('M15.2 Notification Channel Configuration', () => {
  test('defines dedicated mission-critical channel with ID dispatcher-jobs', () => {
    assert.strictEqual(DISPATCHER_NOTIFICATION_CHANNEL_ID, 'dispatcher-jobs');
    assert.strictEqual(DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.id, 'dispatcher-jobs');
    assert.strictEqual(DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.name, 'Job Updates');
  });

  test('configures high priority/importance for time-sensitive dispatch alerts', () => {
    assert.strictEqual(
      DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.importance,
      4,
      'AndroidImportance.HIGH (4) required for sound and heads-up banner'
    );
    assert.strictEqual(DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.sound, 'default');
    assert.strictEqual(DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.enableVibrate, true);
    assert.ok(
      Array.isArray(DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.vibrationPattern) &&
        DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.vibrationPattern.length > 0,
      'Vibration pattern must be defined'
    );
  });

  test('disables notification badge by default to avoid stale counter clutter', () => {
    assert.strictEqual(DISPATCHER_NOTIFICATION_CHANNEL_CONFIG.showBadge, false);
  });
});

describe('M15.2 Foreground Presentation Options', () => {
  test('enables alert banner and audio sound in foreground while suppressing badges', () => {
    const options = getNotificationPresentationOptions();
    assert.deepStrictEqual(options, {
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    });
  });
});

describe('M15.2 Permission State Normalization & Non-Blocking Policy', () => {
  test('normalizes native permission statuses into standard enum', () => {
    assert.strictEqual(normalizeNotificationPermissionStatus('granted'), 'GRANTED');
    assert.strictEqual(normalizeNotificationPermissionStatus('denied'), 'DENIED');
    assert.strictEqual(normalizeNotificationPermissionStatus('undetermined'), 'UNDETERMINED');
    assert.strictEqual(normalizeNotificationPermissionStatus(null), 'UNDETERMINED');
    assert.strictEqual(normalizeNotificationPermissionStatus(undefined), 'UNDETERMINED');
    assert.strictEqual(normalizeNotificationPermissionStatus('anything_else'), 'UNDETERMINED');
  });

  test('identifies granted state accurately', () => {
    assert.strictEqual(isNotificationPermissionGranted('GRANTED'), true);
    assert.strictEqual(isNotificationPermissionGranted('DENIED'), false);
    assert.strictEqual(isNotificationPermissionGranted('UNDETERMINED'), false);
  });

  test('only prompts when status is undetermined, never reprompting if explicitly denied', () => {
    assert.strictEqual(shouldPromptForNotificationPermission('UNDETERMINED'), true);
    assert.strictEqual(shouldPromptForNotificationPermission('GRANTED'), false);
    assert.strictEqual(shouldPromptForNotificationPermission('DENIED'), false);
  });
});

describe('M15.2 User-Friendly Permission Explanation', () => {
  test('provides mission-critical rationale and explicitly denies marketing spam', () => {
    assert.ok(NOTIFICATION_PERMISSION_EXPLANATION.title.length > 0);
    assert.ok(NOTIFICATION_PERMISSION_EXPLANATION.subtitle.length > 0);
    assert.ok(NOTIFICATION_PERMISSION_EXPLANATION.reasons.length >= 3);

    const hasSpamDisclaimer = NOTIFICATION_PERMISSION_EXPLANATION.reasons.some((r) =>
      r.toLowerCase().includes('zero marketing') || r.toLowerCase().includes('spam')
    );
    assert.ok(hasSpamDisclaimer, 'Explanation must guarantee no marketing or promotional spam');
  });

  test('contains clear non-blocking denial notice assuring full app usability', () => {
    assert.ok(
      NOTIFICATION_PERMISSION_EXPLANATION.deniedNotice.includes('fully functional'),
      'Notice must clarify app remains usable if notifications are denied'
    );
  });
});

describe('M15.2 Native Package & Config Plugin Setup', () => {
  test('package.json includes expo-notifications dependency', () => {
    const pkgPath = path.resolve('package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.ok(pkg.dependencies['expo-notifications'], 'expo-notifications must be in dependencies');
    assert.ok(
      pkg.dependencies['expo-notifications'].startsWith('~57.') ||
        pkg.dependencies['expo-notifications'].startsWith('^57.') ||
        pkg.dependencies['expo-notifications'].startsWith('57.'),
      'expo-notifications version must match Expo SDK 57'
    );
  });

  test('app.json registers expo-notifications config plugin', () => {
    const appJsonPath = path.resolve('app.json');
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    const plugins = appJson.expo.plugins;

    const notifPlugin = plugins.find((p) => {
      if (typeof p === 'string') return p === 'expo-notifications';
      if (Array.isArray(p)) return p[0] === 'expo-notifications';
      return false;
    });

    assert.ok(notifPlugin, 'expo-notifications must be registered in app.json plugins');
  });

  test('src/app/_layout.tsx imports @/lib/notifications at root scope', () => {
    const layoutPath = path.resolve('src/app/_layout.tsx');
    const layoutContent = fs.readFileSync(layoutPath, 'utf8');
    assert.ok(
      layoutContent.includes("@/lib/notifications") || layoutContent.includes("lib/notifications"),
      'Root layout must import notifications service to configure handler on launch'
    );
  });
});
