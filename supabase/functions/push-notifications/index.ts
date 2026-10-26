/**
 * Dispatcher M15.4 — Secure Notification Delivery Edge Function
 *
 * Supabase Edge Function reacting to database webhooks on public.job_events.
 *
 * Deployment:
 *   supabase functions deploy push-notifications
 *
 * Local Development:
 *   supabase functions serve push-notifications
 */

// Declare Deno runtime global for TypeScript compilers outside Deno
declare const Deno: any;

import { handleNotificationWebhookRequest } from './core';

// Supabase Edge Runtime Entrypoint
// @ts-ignore - Deno global available in Supabase Edge Runtime
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  // @ts-ignore
  Deno.serve(async (req: Request) => {
    return await handleNotificationWebhookRequest(req);
  });
}
