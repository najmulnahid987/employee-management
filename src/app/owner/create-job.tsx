import { router } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, Input, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function CreateJobScreen() {
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [address, setAddress] = useState('');
  const [serviceDescription, setServiceDescription] = useState('');
  const [scheduledWindow, setScheduledWindow] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">New Service Job</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Enter job details and customer contact information.
          </ThemedText>
        </View>

        <Card variant="surface" style={styles.card}>
          <Input
            label="Customer Name"
            placeholder="e.g. John Smith"
            value={customerName}
            onChangeText={setCustomerName}
          />

          <Input
            label="Customer Phone"
            placeholder="e.g. (555) 234-5678"
            value={customerPhone}
            onChangeText={setCustomerPhone}
            keyboardType="phone-pad"
          />

          <Input
            label="Service Site Address"
            placeholder="e.g. 742 Evergreen Terrace, Springfield"
            value={address}
            onChangeText={setAddress}
          />

          <Input
            label="Service Scope & Description"
            placeholder="e.g. Main water line leak inspection"
            value={serviceDescription}
            onChangeText={setServiceDescription}
          />

          <Input
            label="Scheduled Arrival Window"
            placeholder="e.g. Today, 9:00 AM - 11:00 AM"
            value={scheduledWindow}
            onChangeText={setScheduledWindow}
          />

          <Input
            label="Internal Notes (Optional)"
            placeholder="Gate code, parking instructions, or equipment notes..."
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={3}
          />

          <Button
            label="Create Job"
            variant="primary"
            fullWidth
            onPress={() => router.back()}
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
