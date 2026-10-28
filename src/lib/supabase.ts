import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import { setupURLPolyfill } from 'react-native-url-polyfill';

import { secureStorage } from '@/lib/secure-storage';
import type { Database } from '@/types/database';

// Apply WHATWG URL polyfill only on native platforms (Hermes/Native) where needed
if (Platform.OS !== 'web') {
  setupURLPolyfill();
}

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Validate environment configuration safely without logging secrets
if (!supabaseUrl || typeof supabaseUrl !== 'string' || !supabaseUrl.startsWith('https://')) {
  throw new Error(
    'Supabase configuration error: EXPO_PUBLIC_SUPABASE_URL is missing, not a string, or does not start with https://'
  );
}

if (!supabaseAnonKey || typeof supabaseAnonKey !== 'string' || supabaseAnonKey.length < 20) {
  throw new Error(
    'Supabase configuration error: EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing, not a string, or invalid.'
  );
}

/**
 * Exactly one shared Supabase client typed with the generated Database schema.
 * Configured with hardware-backed secure storage on mobile and AsyncStorage on web.
 */
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: Platform.OS === 'web' && typeof window === 'undefined' ? undefined : secureStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
