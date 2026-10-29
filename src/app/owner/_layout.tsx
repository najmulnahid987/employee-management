import { Stack, useSegments } from 'expo-router';
import React from 'react';

import { Loading } from '@/components/ui';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';

export default function OwnerLayout() {
  const theme = useTheme();
  const { session, role, isLoading } = useAuth();
  const segments = useSegments();

  const isSetupScreen = segments[1] === 'setup';

  if (isLoading) {
    return <Loading fullScreen label="Verifying owner authorization..." />;
  }

  // If not authenticated or (not an owner and not accessing initial setup), prevent rendering owner stack
  if (!session || (role !== 'owner' && !isSetupScreen)) {
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
        name="setup"
        options={{ title: 'Business Setup', headerBackTitle: 'Back' }}
      />
      <Stack.Screen
        name="create-job"
        options={{
          presentation: 'modal',
          title: 'Create Job',
          headerBackTitle: 'Cancel',
        }}
      />
      <Stack.Screen
        name="job-details"
        options={{ title: 'Job Details', headerBackTitle: 'Jobs' }}
      />
      <Stack.Screen
        name="assign-worker"
        options={{
          presentation: 'modal',
          title: 'Assign Worker',
          headerBackTitle: 'Cancel',
        }}
      />
      <Stack.Screen
        name="worker-details"
        options={{ title: 'Worker Details', headerBackTitle: 'Workers' }}
      />
      <Stack.Screen
        name="job-history"
        options={{ title: 'Job History', headerBackTitle: 'Jobs' }}
      />
      <Stack.Screen
        name="billing"
        options={{ title: 'Billing', headerBackTitle: 'Profile' }}
      />
    </Stack>
  );
}
