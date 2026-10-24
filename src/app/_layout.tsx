import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { router, Stack, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthRecoveryView } from '@/components/auth-recovery-view';
import { AuthProvider } from '@/contexts/auth-context';
import { useAuth } from '@/hooks/use-auth';

SplashScreen.preventAutoHideAsync();

function NavigationRouteGuard() {
  const { session, profile, role, isLoading, profileError, isDeactivated, retryAuth, signOut } = useAuth();
  const segments = useSegments();

  const rootSegment = segments[0] ?? '';
  const subSegment = segments[1] ?? '';

  useEffect(() => {
    // 0. Do not route while session is being restored or actively transitioning
    if (isLoading) return;

    // 1. Missing session: must be on /sign-in
    if (!session) {
      if (rootSegment !== 'sign-in') {
        router.replace('/sign-in');
      }
      return;
    }

    // 2. Profile fetch error, deactivation, or unrecognized role:
    // Do not redirect; the recovery screen is rendered in-place below
    if (profileError || isDeactivated || (profile && !role)) {
      return;
    }

    // 3. Authenticated but onboarding incomplete (no profile created yet)
    if (!profile) {
      const isOnboardingScreen =
        (rootSegment === 'owner' && subSegment === 'setup') ||
        (rootSegment === 'worker' && subSegment === 'join');

      if (!isOnboardingScreen) {
        router.replace('/owner/setup');
      }
      return;
    }

    // 4. Authenticated owner: must be in /owner shell (and not on /owner/setup)
    if (role === 'owner') {
      const inOwnerShell = rootSegment === 'owner';
      const onOwnerSetup = rootSegment === 'owner' && subSegment === 'setup';

      if (!inOwnerShell || onOwnerSetup) {
        router.replace('/owner/dashboard');
      }
      return;
    }

    // 5. Authenticated worker: must be in /worker shell (and not on /worker/join)
    if (role === 'worker') {
      const inWorkerShell = rootSegment === 'worker';
      const onWorkerJoin = rootSegment === 'worker' && subSegment === 'join';

      if (!inWorkerShell || onWorkerJoin) {
        router.replace('/worker/today');
      }
      return;
    }
  }, [session, profile, role, isLoading, profileError, isDeactivated, rootSegment, subSegment]);

  // If there is an active profile error or the account is deactivated or role is invalid:
  if (!isLoading && session) {
    if (profileError) {
      return (
        <AuthRecoveryView
          title="Profile Connection Error"
          message="We could not load your user profile from the database. Please check your network connection."
          diagnosticMessage={profileError}
          onRetry={retryAuth}
          onSignOut={signOut}
        />
      );
    }

    if (isDeactivated) {
      return (
        <AuthRecoveryView
          title="Account Deactivated"
          message="Your account has been deactivated by the business administrator. Please contact your manager or support."
          onSignOut={signOut}
        />
      );
    }

    if (profile && !role) {
      return (
        <AuthRecoveryView
          title="Unrecognized Account Role"
          message="Your user profile does not have an authorized dispatcher or technician role."
          onSignOut={signOut}
        />
      );
    }
  }

  return null;
}

function RootContent() {
  const { isLoading } = useAuth();

  return (
    <>
      <AnimatedSplashOverlay isReady={!isLoading} />
      <NavigationRouteGuard />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="owner" options={{ headerShown: false }} />
        <Stack.Screen name="worker" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AuthProvider>
        <RootContent />
      </AuthProvider>
    </ThemeProvider>
  );
}

