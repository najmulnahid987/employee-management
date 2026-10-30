import { Tabs } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/use-theme';

export default function OwnerTabsLayout() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const bottomInset = insets.bottom;
  const tabBarHeight = Platform.select({
    ios: 56 + (bottomInset > 0 ? bottomInset : 10),
    default: 60 + bottomInset,
  });
  const paddingBottom = Platform.select({
    ios: bottomInset > 0 ? bottomInset : 8,
    default: bottomInset > 0 ? bottomInset + 4 : 8,
  });

  return (
    <Tabs
      initialRouteName="dashboard"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarStyle: {
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
          borderTopWidth: 1,
          height: tabBarHeight,
          paddingBottom,
          paddingTop: 6,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '600',
        },
      }}>
      <Tabs.Screen
        name="dashboard"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'square.grid.2x2', android: 'dashboard', web: 'dashboard' }}
              tintColor={color}
              size={20}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="jobs"
        options={{
          title: 'Jobs',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'briefcase', android: 'work', web: 'work' }}
              tintColor={color}
              size={20}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="workers"
        options={{
          title: 'Workers',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'person.2', android: 'group', web: 'group' }}
              tintColor={color}
              size={20}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="map"
        options={{
          title: 'Map',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'map', android: 'map', web: 'map' }}
              tintColor={color}
              size={20}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'person.crop.circle', android: 'person', web: 'person' }}
              tintColor={color}
              size={20}
            />
          ),
        }}
      />
    </Tabs>
  );
}
