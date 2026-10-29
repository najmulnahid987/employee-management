import { DarkTheme, DefaultTheme, ErrorBoundaryProps, router, Stack, ThemeProvider, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AppErrorView } from '@/components/app-error-view';
import { AuthRecoveryView } from '@/components/auth-recovery-view';
import { InAppNotificationBanner } from '@/components/in-app-notification-banner';
import { AuthProvider } from '@/contexts/auth-context';
import { RealtimeProvider } from '@/contexts/realtime-context';
import { useAuth } from '@/hooks/use-auth';
// Register background location task at root module scope
import '@/lib/background-location-task';
import { installGlobalErrorHandlers, logger } from '@/lib/logger';
// Configure notification presentation handler and Android channels at root module scope
import '@/lib/notifications';
import {
  ForegroundNotificationAlert,
  resumePendingNotificationNavigation,
  setupNotificationDeepLinking,
} from '@/lib/notification-navigation';
import { resolveNotificationRoute } from '@/lib/notification-navigation-core';

// Install global error and promise rejection handlers
installGlobalErrorHandlers();

SplashScreen.preventAutoHideAsync();

function NavigationRouteGuard() {
  const { session, profile, role, isLoading, profileError, isDeactivated, retryAuth, signOut } = useAuth();
  const segments = useSegments();

  const rootSegment = segments[0] ?? '';
  const subSegment = segments[1] ?? '';

  useEffect(() => {
    // 0. Do not route while session is being restored or actively transitioning
    if (isLoading) return;

    // Public route: customer tracking does not require authentication
    if (rootSegment === 'track') {
      return;
    }

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
  const { isLoading, session, role } = useAuth();
  const [activeBanner, setActiveBanner] = React.useState<ForegroundNotificationAlert | null>(null);

  // Setup notification deep linking listeners for cold and warm starts
  useEffect(() => {
    const { unsubscribe } = setupNotificationDeepLinking({
      role: role as 'owner' | 'worker' | null,
      isAuthenticated: Boolean(session),
      onNavigate: (target) => {
        router.push({
          pathname: target.pathname as any,
          params: target.params,
        });
      },
      onForegroundNotification: (alert) => {
        setActiveBanner(alert);
      },
    });

    return () => {
      unsubscribe();
    };
  }, [session, role]);

  // Check and consume pending notification navigation once user completes sign-in
  useEffect(() => {
    if (!isLoading && session && role) {
      resumePendingNotificationNavigation(role as 'owner' | 'worker', (target) => {
        router.push({
          pathname: target.pathname as any,
          params: target.params,
        });
      });
    }
  }, [isLoading, session, role]);

  const handleBannerPress = (jobId: string) => {
    setActiveBanner(null);
    if (!role) return;
    const target = resolveNotificationRoute(role as 'owner' | 'worker', jobId);
    if (target) {
      router.push({
        pathname: target.pathname as any,
        params: target.params,
      });
    }
  };

  return (
    <>
      <AnimatedSplashOverlay isReady={!isLoading} />
      <NavigationRouteGuard />
      <InAppNotificationBanner
        alert={activeBanner}
        onPress={handleBannerPress}
        onDismiss={() => setActiveBanner(null)}
      />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="owner" options={{ headerShown: false }} />
        <Stack.Screen name="worker" options={{ headerShown: false }} />
        <Stack.Screen name="track" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AuthProvider>
        <RealtimeProvider>
          <RootContent />
        </RealtimeProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    logger.error('RootErrorBoundary', 'Unhandled error caught in root boundary:', error);
  }, [error]);

  return (
    <AppErrorView
      error={error}
      onRetry={retry}
      onGoHome={() => {
        router.replace('/');
      }}
    />
  );
}
