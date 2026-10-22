import { router } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, EmptyState, Input, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function AssignWorkerScreen() {
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Assign Worker</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Select an active technician from your business roster.
          </ThemedText>
        </View>

        <Input
          placeholder="Search active workers..."
          value={searchQuery}
          onChangeText={setSearchQuery}
        />

        <EmptyState
          title="No Available Workers"
          description="There are currently no active workers registered in your business roster to assign to this job."
          actionLabel="Close Modal"
          onAction={() => router.back()}
        />

        <Button
          label="Confirm Assignment"
          variant="primary"
          disabled
          fullWidth
          onPress={() => router.back()}
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
