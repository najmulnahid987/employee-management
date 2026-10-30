import { Stack, useSegments } from 'expo-router';
import React from 'react';
import { Pressable } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Loading } from '@/components/ui';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { safeBack } from '@/lib/navigation';

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
        options={{
          title: 'Business Setup',
          headerBackTitle: 'Back',
          headerLeft: () => (
            <Pressable
              onPress={() => safeBack('/owner/dashboard')}
              hitSlop={8}
              style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 8 }}>
              <ThemedText style={{ color: theme.primary, fontSize: 20, marginRight: 4 }}>‹</ThemedText>
              <ThemedText style={{ color: theme.primary, fontSize: 16 }}>Back</ThemedText>
            </Pressable>
          ),
        }}
      />
      <Stack.Screen
        name="create-job"
        options={{
          presentation: 'modal',
          title: 'Create Job',
          headerBackTitle: 'Cancel',
          headerLeft: () => (
            <Pressable
              onPress={() => safeBack('/owner/dashboard')}
              hitSlop={8}
              style={{ paddingRight: 8 }}>
              <ThemedText style={{ color: theme.primary, fontSize: 16 }}>Cancel</ThemedText>
            </Pressable>
          ),
        }}
      />
      <Stack.Screen
        name="job-details"
        options={{
          title: 'Job Details',
          headerBackTitle: 'Jobs',
          headerLeft: () => (
            <Pressable
              onPress={() => safeBack('/owner/jobs')}
              hitSlop={8}
              style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 8 }}>
              <ThemedText style={{ color: theme.primary, fontSize: 20, marginRight: 4 }}>‹</ThemedText>
              <ThemedText style={{ color: theme.primary, fontSize: 16 }}>Jobs</ThemedText>
            </Pressable>
          ),
        }}
      />
      <Stack.Screen
        name="assign-worker"
        options={{
          presentation: 'modal',
          title: 'Assign Worker',
          headerBackTitle: 'Cancel',
          headerLeft: () => (
            <Pressable
              onPress={() => safeBack('/owner/dashboard')}
              hitSlop={8}
              style={{ paddingRight: 8 }}>
              <ThemedText style={{ color: theme.primary, fontSize: 16 }}>Cancel</ThemedText>
            </Pressable>
          ),
        }}
      />
      <Stack.Screen
        name="worker-details"
        options={{
          title: 'Worker Details',
          headerBackTitle: 'Workers',
          headerLeft: () => (
            <Pressable
              onPress={() => safeBack('/owner/workers')}
              hitSlop={8}
              style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 8 }}>
              <ThemedText style={{ color: theme.primary, fontSize: 20, marginRight: 4 }}>‹</ThemedText>
              <ThemedText style={{ color: theme.primary, fontSize: 16 }}>Workers</ThemedText>
            </Pressable>
          ),
        }}
      />
      <Stack.Screen
        name="job-history"
        options={{
          title: 'Job History',
          headerBackTitle: 'Jobs',
          headerLeft: () => (
            <Pressable
              onPress={() => safeBack('/owner/jobs')}
              hitSlop={8}
              style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 8 }}>
              <ThemedText style={{ color: theme.primary, fontSize: 20, marginRight: 4 }}>‹</ThemedText>
              <ThemedText style={{ color: theme.primary, fontSize: 16 }}>Jobs</ThemedText>
            </Pressable>
          ),
        }}
      />
      <Stack.Screen
        name="billing"
        options={{
          title: 'Billing',
          headerBackTitle: 'Profile',
          headerLeft: () => (
            <Pressable
              onPress={() => safeBack('/owner/profile')}
              hitSlop={8}
              style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 8 }}>
              <ThemedText style={{ color: theme.primary, fontSize: 20, marginRight: 4 }}>‹</ThemedText>
              <ThemedText style={{ color: theme.primary, fontSize: 16 }}>Profile</ThemedText>
            </Pressable>
          ),
        }}
      />
    </Stack>
  );
}
