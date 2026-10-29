/**
 * Dispatcher M13.4 — Public Customer Tracking Edge Function
 *
 * Deployment:
 *   supabase functions deploy customer-tracking --no-verify-jwt
 *
 * Local Development:
 *   supabase functions serve customer-tracking --no-verify-jwt
 */

// Declare Deno runtime global for TypeScript compilers outside Deno
declare const Deno: any;

import { handleCustomerTrackingRequest } from './core.ts';

// @ts-ignore - Deno global available in Supabase Edge Runtime
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  // @ts-ignore
  Deno.serve(async (req: Request) => {
    return await handleCustomerTrackingRequest(req);
  });
}
