/**
 * Dispatcher M17 — Simplified Billing UI Acceptance Test Suite
 *
 * Programmatic verification of the Billing UI implementation:
 * 1. Screen file exists at src/app/owner/billing.tsx
 * 2. Header contains required title and subtitle
 * 3. Current plan card contains required Free plan details
 * 4. Future paid plan section contains required coming soon information
 * 5. Upgrade button contains informational placeholder behavior
 * 6. Billing note contains required availability statement
 * 7. Navigation wiring connects Profile to Billing screen in owner stack
 * 8. Strict safety: zero payment SDKs or fake checkout navigation
 *
 * Execution:
 * node --test --experimental-strip-types scripts/test-billing-ui.mjs
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const BILLING_SCREEN_PATH = path.join(ROOT_DIR, 'src', 'app', 'owner', 'billing.tsx');
const OWNER_PROFILE_PATH = path.join(ROOT_DIR, 'src', 'app', 'owner', '(tabs)', 'profile.tsx');
const OWNER_LAYOUT_PATH = path.join(ROOT_DIR, 'src', 'app', 'owner', '_layout.tsx');

describe('Dispatcher M17 — Billing UI Verification', () => {
  test('1. Billing screen file exists in src/app/owner/billing.tsx', () => {
    assert.ok(fs.existsSync(BILLING_SCREEN_PATH), 'billing.tsx must exist');
  });

  test('2. Header displays Title "Billing" and Subtitle "Manage your Dispatcher plan"', () => {
    const content = fs.readFileSync(BILLING_SCREEN_PATH, 'utf8');
    assert.match(content, /Billing/, 'Must contain title Billing');
    assert.match(content, /Manage your Dispatcher plan/, 'Must contain subtitle Manage your Dispatcher plan');
  });

  test('3. Current plan card displays Free plan specifications', () => {
    const content = fs.readFileSync(BILLING_SCREEN_PATH, 'utf8');
    // Plan name: Free
    assert.match(content, />Free</, 'Must display Free plan name');
    // Status label: Current plan
    assert.match(content, /Current plan/, 'Must display Current plan label');
    // Price: $0
    assert.match(content, /\$0/, 'Must display $0 price');
    // Billing period: No payment required
    assert.match(content, /No payment required/, 'Must display No payment required period');
    // Description: Use Dispatcher to manage your jobs and coordinate your team.
    assert.match(
      content,
      /Use Dispatcher to manage your jobs and coordinate your team\./,
      'Must display exact plan description'
    );
  });

  test('4. Future paid plan section displays Coming soon information', () => {
    const content = fs.readFileSync(BILLING_SCREEN_PATH, 'utf8');
    // Heading: More features, coming soon
    assert.match(content, /More features, coming soon/, 'Must contain heading More features, coming soon');
    // Short description: Paid plans are planned for businesses that need more from Dispatcher.
    assert.match(
      content,
      /Paid plans are planned for businesses that need more from Dispatcher\./,
      'Must contain exact future plan description'
    );
    // Subtle label: Coming soon
    assert.match(content, /Coming soon/, 'Must contain Coming soon label');
  });

  test('5. Placeholder upgrade button displays "Paid plans are coming soon."', () => {
    const content = fs.readFileSync(BILLING_SCREEN_PATH, 'utf8');
    // Button label: Upgrade plan
    assert.match(content, /label="Upgrade plan"/, 'Button label must be Upgrade plan');
    // Informational message
    assert.match(content, /Paid plans are coming soon\./, 'Must provide informational message on tap');
    // Does not navigate to checkout
    assert.doesNotMatch(content, /router\.push\(.*checkout.*\)/i, 'Must not navigate to a checkout screen');
  });

  test('6. Billing information note displays exact required text', () => {
    const content = fs.readFileSync(BILLING_SCREEN_PATH, 'utf8');
    assert.match(
      content,
      /Billing and paid subscriptions are not available yet\. You can continue using the current version of Dispatcher\./,
      'Must display required billing availability note'
    );
  });

  test('7. Owner navigation layout registers billing screen with back to Profile', () => {
    const layoutContent = fs.readFileSync(OWNER_LAYOUT_PATH, 'utf8');
    assert.match(layoutContent, /name="billing"/, 'Owner layout must register billing screen');
    assert.match(layoutContent, /headerBackTitle:\s*'Profile'/, 'Must configure back navigation title');
  });

  test('8. Owner Profile screen contains link to /owner/billing', () => {
    const profileContent = fs.readFileSync(OWNER_PROFILE_PATH, 'utf8');
    assert.match(
      profileContent,
      /router\.push\('\/owner\/billing'\)/,
      'Owner Profile screen must navigate to /owner/billing'
    );
    assert.match(profileContent, />Billing</, 'Owner Profile screen must show Billing entry');
  });

  test('9. Strict Safety: zero payment SDKs or fake subscription mutations', () => {
    const content = fs.readFileSync(BILLING_SCREEN_PATH, 'utf8');
    assert.doesNotMatch(content, /from\s+['"]stripe['"]/i, 'No Stripe SDK imports');
    assert.doesNotMatch(content, /@stripe/i, 'No @stripe packages');
    assert.doesNotMatch(content, /paypal/i, 'No PayPal');
    assert.doesNotMatch(content, /supabase\.from\(['"]subscriptions['"]\)\.insert/i, 'No fake subscription writes');
    assert.doesNotMatch(content, /supabase\.from\(['"]subscriptions['"]\)\.update/i, 'No fake subscription updates');
  });
});

