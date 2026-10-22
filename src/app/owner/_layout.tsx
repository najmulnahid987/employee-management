import { Stack } from 'expo-router';
import React from 'react';

import { useTheme } from '@/hooks/use-theme';

export default function OwnerLayout() {
  const theme = useTheme();

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
    </Stack>
  );
}
