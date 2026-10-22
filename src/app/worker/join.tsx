import { router } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, Input, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';

export default function WorkerInvitationJoinScreen() {
  const [inviteCode, setInviteCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');

  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Join Business Team</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Enter your invitation code to join your company's dispatch roster.
          </ThemedText>
        </View>

        <Card variant="surface" style={styles.card}>
          <Input
            label="Invitation Code"
            placeholder="e.g. DISP-7829-JOIN"
            value={inviteCode}
            onChangeText={setInviteCode}
            autoCapitalize="characters"
          />

          <Input
            label="Your Full Name"
            placeholder="e.g. Alex Morgan"
            value={fullName}
            onChangeText={setFullName}
          />

          <Input
            label="Mobile Phone Number"
            placeholder="e.g. (555) 019-3847"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
          />

          <Button
            label="Accept Invitation & Join"
            variant="primary"
            fullWidth
            onPress={() => router.replace('/worker/today')}
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
