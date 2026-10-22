import { router } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, Input, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function OwnerBusinessSetupScreen() {
  const [businessName, setBusinessName] = useState('');
  const [phone, setPhone] = useState('');
  const [trade, setTrade] = useState('');

  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Business Profile Setup</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Configure your local service company details before dispatching jobs.
          </ThemedText>
        </View>

        <Card variant="surface" style={styles.card}>
          <Input
            label="Business Legal Name"
            placeholder="e.g. Acme Plumbing & Heating"
            value={businessName}
            onChangeText={setBusinessName}
          />

          <Input
            label="Primary Dispatch Phone"
            placeholder="e.g. (555) 019-2834"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
          />

          <Input
            label="Service Trade / Industry"
            placeholder="e.g. Plumbing, HVAC, Electrical"
            value={trade}
            onChangeText={setTrade}
            helperText="Primary trade category for your field service team."
          />

          <Button
            label="Complete Business Setup"
            variant="primary"
            fullWidth
            onPress={() => router.replace('/owner/dashboard')}
            style={styles.actionButton}
          />
        </Card>
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
  card: {
    padding: Spacing.base,
  },
  actionButton: {
    marginTop: Spacing.sm,
  },
});
