import { Stack } from 'expo-router';
import React from 'react';

import { useTheme } from '@/hooks/use-theme';

export default function WorkerLayout() {
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
