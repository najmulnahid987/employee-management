import { router } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';

export default function WorkerProfileScreen() {
  const { user, profile, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
      router.replace('/sign-in');
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Worker Profile</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Your technician account details and application settings.
          </ThemedText>
        </View>

        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Account Information</ThemedText>
          <ThemedText type="body">
            {profile?.full_name ?? 'Technician Member'}
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Role: Field Worker
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Account: {user?.email ?? 'worker@business.com'}
          </ThemedText>
        </Card>

        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Application Info</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Dispatcher Mobile App v1.0.0
          </ThemedText>
        </Card>

        <Button
          label="Sign Out"
          variant="outline"
          fullWidth
          loading={signingOut}
          disabled={signingOut}
          onPress={handleSignOut}
          style={styles.signOutButton}
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
  card: {
    padding: Spacing.base,
    gap: Spacing.xs,
  },
  signOutButton: {
    marginTop: Spacing.md,
  },
});
