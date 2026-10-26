import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export type Profile = Database['public']['Tables']['profiles']['Row'];
export type Business = Database['public']['Tables']['businesses']['Row'];
export type UserRole = 'owner' | 'worker';

export interface AuthSuccessResult<T> {
  success: true;
  data: T;
  error?: never;
}

export interface AuthErrorResult {
  success: false;
  data?: never;
  error: string;
}

export type AuthResult<T> = AuthSuccessResult<T> | AuthErrorResult;

/**
 * Sanitizes and translates internal Supabase Auth errors into user-friendly messages.
 * Never logs or reveals secrets, passwords, or tokens.
 */
export function sanitizeAuthError(error: unknown): string {
  if (!error) return 'An unexpected authentication error occurred.';

  let message = '';
  if (typeof error === 'string') {
    message = error;
  } else if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, unknown>;
    if (typeof errObj.message === 'string' && errObj.message.trim()) {
      message = errObj.message;
    } else if (typeof errObj.error_description === 'string' && errObj.error_description.trim()) {
      message = errObj.error_description;
    } else if (typeof errObj.details === 'string' && errObj.details.trim()) {
      message = errObj.details;
    } else {
      try {
        message = JSON.stringify(error);
      } catch {
        message = 'An unexpected server error occurred.';
      }
    }
  } else {
    message = String(error);
  }

  if (message.includes('provision_business') || message.includes('PGRST202')) {
    return 'Database function "provision_business" not found. Please run the migration (20261022223000_rls_security_policies.sql) in your Supabase SQL Editor.';
  }
  if (message.includes('Invalid login credentials')) {
    return 'Invalid email or password. Please verify your credentials and try again.';
  }
  if (message.includes('User already registered') || message.includes('already exists')) {
    return 'An account with this email address already exists. Please sign in instead.';
  }
  if (message.includes('Password should be at least')) {
    return 'Password must be at least 6 characters in length.';
  }
  if (message.includes('Email not confirmed')) {
    return 'Your email address has not been confirmed yet. Please check your inbox.';
  }
  if (message.includes('rate limit') || message.includes('too many requests')) {
    return 'Too many login attempts. Please wait a few moments before trying again.';
  }
  if (message.includes('Network request failed') || message.includes('FetchError') || message.includes('Failed to fetch')) {
    return 'Unable to reach authentication service. Please check your internet connection.';
  }

  return message;
}

/**
 * Signs up a new user with email and password.
 */
export async function signUpWithPassword(
  email: string,
  password: string
): Promise<AuthResult<{ user: User | null; session: Session | null; requiresEmailConfirmation: boolean }>> {
  try {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      return { success: false, error: 'Please enter a valid email address.' };
    }
    if (!password || password.length < 6) {
      return { success: false, error: 'Password must be at least 6 characters.' };
    }

    const { data, error } = await supabase.auth.signUp({
      email: trimmedEmail,
      password,
    });

    if (error) {
      return { success: false, error: sanitizeAuthError(error) };
    }

    const requiresEmailConfirmation = Boolean(data.user && !data.session);

    return {
      success: true,
      data: {
        user: data.user,
        session: data.session,
        requiresEmailConfirmation,
      },
    };
  } catch (err) {
    return { success: false, error: sanitizeAuthError(err) };
  }
}

/**
 * Signs in an existing user with email and password.
 */
export async function signInWithPassword(
  email: string,
  password: string
): Promise<AuthResult<{ user: User; session: Session }>> {
  try {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      return { success: false, error: 'Please enter a valid email address.' };
    }
    if (!password) {
      return { success: false, error: 'Password is required.' };
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    });

    if (error) {
      return { success: false, error: sanitizeAuthError(error) };
    }

    if (!data.user || !data.session) {
      return { success: false, error: 'Authentication succeeded but no active session was established.' };
    }

    return {
      success: true,
      data: {
        user: data.user,
        session: data.session,
      },
    };
  } catch (err) {
    return { success: false, error: sanitizeAuthError(err) };
  }
}

/**
 * Signs out the currently authenticated user and clears local session cache.
 */
export async function signOut(): Promise<AuthResult<void>> {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) {
      return { success: false, error: sanitizeAuthError(error) };
    }
    return { success: true, data: undefined };
  } catch (err) {
    return { success: false, error: sanitizeAuthError(err) };
  }
}

/**
 * Retrieves the currently active session from the shared client storage.
 */
export async function getSession(): Promise<Session | null> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) {
      return null;
    }
    return data.session;
  } catch {
    return null;
  }
}

/**
 * Retrieves the current authenticated user from Supabase.
 */
export async function getUser(): Promise<User | null> {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      return null;
    }
    return data.user;
  } catch {
    return null;
  }
}

export interface ProfileFetchResult {
  profile: Profile | null;
  error: string | null;
}

/**
 * Fetches user profile with non-sensitive error distinction.
 * Distinguishes between 'profile not yet created' (error: null, profile: null)
 * and an actual query failure (error: string, profile: null).
 */
export async function fetchUserProfileDetails(userId: string): Promise<ProfileFetchResult> {
  try {
    if (!userId) return { profile: null, error: null };

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      if (__DEV__) {
        console.warn('[Auth] Failed to load profile for user:', error.message);
      }
      return { profile: null, error: error.message };
    }

    return { profile: data, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network failure loading profile';
    if (__DEV__) {
      console.warn('[Auth] Exception while loading profile:', message);
    }
    return { profile: null, error: message };
  }
}

/**
 * Fetches the user's authoritative profile row from public.profiles.
 * Never trusts client-cached role or business_id.
 */
export async function fetchUserProfile(userId: string): Promise<Profile | null> {
  const result = await fetchUserProfileDetails(userId);
  return result.profile;
}

/**
 * Fetches the user's business row from public.businesses.
 * Validates that RLS permits the authenticated member to select this business.
 */
export async function fetchUserBusiness(businessId: string): Promise<Business | null> {
  try {
    if (!businessId) return null;

    const { data, error } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', businessId)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Subscribes to auth state changes using the shared client.
 * Returns a cleanup handler to unsubscribe cleanly.
 */
export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void
): { unsubscribe: () => void } {
  const { data } = supabase.auth.onAuthStateChange(callback);
  return {
    unsubscribe: () => {
      data.subscription.unsubscribe();
    },
  };
}

/**
 * Provisions a new business, owner profile, and trial subscription atomically
 * via the trusted server-side RPC provision_business.
 */
export async function provisionBusinessProfile(params: {
  businessName: string;
  phone: string;
  address?: string;
  ownerFullName?: string;
}): Promise<AuthResult<string>> {
  try {
    const trimmedName = params.businessName.trim();
    const trimmedPhone = params.phone.trim();

    if (!trimmedName) {
      return { success: false, error: 'Business name is required.' };
    }
    if (!trimmedPhone) {
      return { success: false, error: 'Primary dispatch phone is required.' };
    }

    const { data, error } = await supabase.rpc('provision_business', {
      p_name: trimmedName,
      p_phone: trimmedPhone,
      p_address: params.address?.trim() || null,
      p_owner_full_name: params.ownerFullName?.trim() || null,
    });

    if (error) {
      return { success: false, error: sanitizeAuthError(error) };
    }

    if (!data) {
      return { success: false, error: 'Provisioning succeeded but returned no business identifier.' };
    }

    return { success: true, data };
  } catch (err) {
    return { success: false, error: sanitizeAuthError(err) };
  }
}

