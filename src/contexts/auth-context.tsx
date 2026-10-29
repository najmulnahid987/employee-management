import type { Session, User } from '@supabase/supabase-js';
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Business,
  fetchUserBusiness,
  fetchUserProfileDetails,
  getSession,
  onAuthStateChange,
  Profile,
  signInWithPassword,
  signOut as authSignOut,
  signUpWithPassword,
  UserRole,
} from '@/lib/auth';
import {
  reconcileActiveTrackingSession,
  reconcileBackgroundTrackingOnLaunch,
  stopBackgroundTrackingAsync,
} from '@/lib/background-location-task';
import { foregroundLocationTracker } from '@/lib/location-tracker';
import {
  deactivateDeviceTokenAsync,
  registerPushTokenForAuthenticatedUserAsync,
  setupPushTokenRefreshListener,
} from '@/lib/notifications';

export interface AuthContextValue {
  /** Supabase Auth session */
  session: Session | null;
  /** Supabase Auth user */
  user: User | null;
  /** Authoritative profile row from public.profiles */
  profile: Profile | null;
  /** Authoritative business row from public.businesses */
  business: Business | null;
  /** Role derived strictly from profile.role (never from local storage) */
  role: UserRole | null;
  /** Business ID derived strictly from profile.business_id */
  businessId: string | null;
  /** Non-sensitive profile loading error, if database fetch failed */
  profileError: string | null;
  /** True if profile exists and has is_active = false */
  isDeactivated: boolean;
  /** True during initial session bootstrap or active authentication transition */
  isLoading: boolean;
  /** Sign in an existing user with email and password */
  signIn: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  /** Register a new user with email and password */
  signUp: (
    email: string,
    password: string
  ) => Promise<{ success: boolean; error?: string; requiresEmailConfirmation?: boolean }>;
  /** Sign out and clear active session */
  signOut: () => Promise<void>;
  /** Refetch latest profile and business from database */
  refreshProfile: () => Promise<{ profile: Profile | null; business: Business | null }>;
  /** Clear error state and retry profile restoration */
  retryAuth: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const profileRef = useRef<Profile | null>(profile);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  // Authoritatively derive role and businessId directly from the server-fetched profile
  const role: UserRole | null = useMemo(() => {
    if (profile?.role === 'owner' || profile?.role === 'worker') {
      return profile.role as UserRole;
    }
    return null;
  }, [profile]);

  const businessId: string | null = useMemo(() => {
    return profile?.business_id ?? null;
  }, [profile]);

  const isDeactivated: boolean = useMemo(() => {
    return Boolean(profile && profile.is_active === false);
  }, [profile]);

  const refreshProfile = useCallback(async (): Promise<{ profile: Profile | null; business: Business | null }> => {
    if (!user?.id) {
      setProfile(null);
      setBusiness(null);
      setProfileError(null);
      return { profile: null, business: null };
    }
    const { profile: fetchedProfile, error: profileErr } = await fetchUserProfileDetails(user.id);
    setProfileError(profileErr);
    setProfile(fetchedProfile);

    let fetchedBusiness: Business | null = null;
    if (fetchedProfile?.business_id) {
      fetchedBusiness = await fetchUserBusiness(fetchedProfile.business_id);
    }
    setBusiness(fetchedBusiness);

    return { profile: fetchedProfile, business: fetchedBusiness };
  }, [user?.id]);

  const retryAuth = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      await refreshProfile();
    } finally {
      setIsLoading(false);
    }
  }, [refreshProfile]);

  // Session restoration and auth listener lifecycle
  useEffect(() => {
    let isMounted = true;

    async function initializeAuth() {
      try {
        const initialSession = await getSession();
        if (!isMounted) return;

        if (initialSession?.user) {
          setSession(initialSession);
          setUser(initialSession.user);
          const { profile: userProfile, error: profileErr } = await fetchUserProfileDetails(initialSession.user.id);
          if (isMounted) {
            setProfileError(profileErr);
            setProfile(userProfile);
            if (userProfile?.business_id) {
              const userBusiness = await fetchUserBusiness(userProfile.business_id);
              if (isMounted) setBusiness(userBusiness);
            } else {
              setBusiness(null);
            }
            // Reconcile background location task for authenticated worker
            reconcileBackgroundTrackingOnLaunch(initialSession.user.id, userProfile?.role);
            // Register push token if device supports push and user granted permission
            registerPushTokenForAuthenticatedUserAsync().catch(() => {});
          }
        } else {
          setSession(null);
          setUser(null);
          setProfile(null);
          setBusiness(null);
          setProfileError(null);
          // Kill any orphaned background task on unauthenticated launch
          reconcileBackgroundTrackingOnLaunch(null, null);
        }
      } catch (err) {
        if (isMounted) {
          setSession(null);
          setUser(null);
          setProfile(null);
          setBusiness(null);
          setProfileError(err instanceof Error ? err.message : 'Failed to restore session');
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    initializeAuth();

    const { unsubscribe } = onAuthStateChange(async (event, newSession) => {
      if (!isMounted) return;

      if (event === 'SIGNED_OUT' || !newSession) {
        foregroundLocationTracker.stopTracking();
        stopBackgroundTrackingAsync();
        setSession(null);
        setUser(null);
        setProfile(null);
        setBusiness(null);
        setProfileError(null);
        setIsLoading(false);
        return;
      }

      setSession(newSession);
      setUser(newSession.user);

      // On silent token refresh, if profile is already loaded and active, do not block UI or reload
      if (event === 'TOKEN_REFRESHED' && profileRef.current) {
        setIsLoading(false);
        return;
      }

      if (newSession.user) {
        const { profile: updatedProfile, error: profileErr } = await fetchUserProfileDetails(newSession.user.id);
        if (isMounted) {
          setProfileError(profileErr);
          setProfile(updatedProfile);
          if (updatedProfile?.business_id) {
            const updatedBusiness = await fetchUserBusiness(updatedProfile.business_id);
            if (isMounted) setBusiness(updatedBusiness);
          } else {
            setBusiness(null);
          }
          // Reconcile tracking session on user change/token refresh
          reconcileActiveTrackingSession(newSession.user.id, updatedProfile?.role);
        }
      } else {
        setProfile(null);
        setBusiness(null);
        setProfileError(null);
      }
      setIsLoading(false);
    });

    const tokenRefreshSub = setupPushTokenRefreshListener();

    return () => {
      isMounted = false;
      unsubscribe();
      tokenRefreshSub.unsubscribe();
    };
  }, []);

  const handleSignIn = useCallback(
    async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
      setIsLoading(true);
      try {
        const result = await signInWithPassword(email, password);
        if (!result.success) {
          setIsLoading(false);
          return { success: false, error: result.error };
        }

        setSession(result.data.session);
        setUser(result.data.user);

        const { profile: loadedProfile, error: profileErr } = await fetchUserProfileDetails(result.data.user.id);
        setProfileError(profileErr);
        setProfile(loadedProfile);
        if (loadedProfile?.business_id) {
          const loadedBusiness = await fetchUserBusiness(loadedProfile.business_id);
          setBusiness(loadedBusiness);
        } else {
          setBusiness(null);
        }
        // Reconcile active tracking session on sign-in (stops orphaned tasks if switching accounts)
        reconcileActiveTrackingSession(result.data.user.id, loadedProfile?.role);
        // Register push token if device supports push and user granted permission
        registerPushTokenForAuthenticatedUserAsync().catch(() => {});
        setIsLoading(false);
        return { success: true };
      } catch (err) {
        setIsLoading(false);
        return {
          success: false,
          error: err instanceof Error ? err.message : 'An unexpected error occurred during sign in.',
        };
      }
    },
    []
  );

  const handleSignUp = useCallback(
    async (
      email: string,
      password: string
    ): Promise<{ success: boolean; error?: string; requiresEmailConfirmation?: boolean }> => {
      setIsLoading(true);
      try {
        const result = await signUpWithPassword(email, password);
        if (!result.success) {
          setIsLoading(false);
          return { success: false, error: result.error };
        }

        if (result.data.session) {
          setSession(result.data.session);
          setUser(result.data.user);
          if (result.data.user) {
            const { profile: loadedProfile, error: profileErr } = await fetchUserProfileDetails(result.data.user.id);
            setProfileError(profileErr);
            setProfile(loadedProfile);
            if (loadedProfile?.business_id) {
              const loadedBusiness = await fetchUserBusiness(loadedProfile.business_id);
              setBusiness(loadedBusiness);
            }
          }
        }

        setIsLoading(false);
        return {
          success: true,
          requiresEmailConfirmation: result.data.requiresEmailConfirmation,
        };
      } catch (err) {
        setIsLoading(false);
        return {
          success: false,
          error: err instanceof Error ? err.message : 'An unexpected error occurred during sign up.',
        };
      }
    },
    []
  );

  const handleSignOut = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      foregroundLocationTracker.stopTracking();
      await stopBackgroundTrackingAsync();
      await deactivateDeviceTokenAsync();
      await authSignOut();
    } finally {
      setSession(null);
      setUser(null);
      setProfile(null);
      setBusiness(null);
      setProfileError(null);
      setIsLoading(false);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      profile,
      business,
      role,
      businessId,
      profileError,
      isDeactivated,
      isLoading,
      signIn: handleSignIn,
      signUp: handleSignUp,
      signOut: handleSignOut,
      refreshProfile,
      retryAuth,
    }),
    [
      session,
      user,
      profile,
      business,
      role,
      businessId,
      profileError,
      isDeactivated,
      isLoading,
      handleSignIn,
      handleSignUp,
      handleSignOut,
      refreshProfile,
      retryAuth,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
