import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { EmptyState, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function OwnerLiveMapScreen() {
  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Live Territory Map</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Geographic view of today's job sites and field technician locations.
          </ThemedText>
        </View>

        <EmptyState
          title="No Active Job Locations"
          description="Geographic pins and worker locations will appear on the map once jobs are scheduled and dispatched across your territory."
        />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: Spacing.base,
    gap: Spacing.base,
  },
  header: {
    gap: Spacing.xs,
  },
});
