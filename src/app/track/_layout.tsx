import { Stack } from 'expo-router';
import React from 'react';

export default function TrackLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="[token]" options={{ headerShown: false }} />
    </Stack>
  );
}
