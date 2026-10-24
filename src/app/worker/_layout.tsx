import { Stack, useSegments } from 'expo-router';
import React from 'react';

import { Loading } from '@/components/ui';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';

export default function WorkerLayout() {
  const theme = useTheme();
  const { session, role, isLoading } = useAuth();
  const segments = useSegments();

  const isJoinScreen = segments[1] === 'join';

  if (isLoading) {
    return <Loading fullScreen label="Verifying technician authorization..." />;
  }

  // If entering join code, allow; otherwise require active session and worker role
  if (!isJoinScreen && (!session || role !== 'worker')) {
    return null;
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.text,
        headerTitleStyle: { fontWeight: '600' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.background },
      }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="join"
        options={{ title: 'Join Business', headerBackTitle: 'Back' }}
      />
      <Stack.Screen
        name="job-details"
        options={{ title: 'Job Details', headerBackTitle: 'Jobs' }}
      />
    </Stack>
  );
}
