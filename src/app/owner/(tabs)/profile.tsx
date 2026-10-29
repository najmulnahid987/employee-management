import { router } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, ScreenContainer } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';

export default function OwnerProfileScreen() {
  const { user, profile, business, signOut } = useAuth();
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
          <ThemedText type="headline">Business Profile & Settings</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Manage company preferences, operating defaults, and account session.
          </ThemedText>
        </View>

        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Business Information</ThemedText>
          <ThemedText type="body" style={{ fontWeight: '600' }}>
            {business?.name ?? 'Business Name'}
          </ThemedText>
          {business?.phone ? (
            <ThemedText type="caption" themeColor="textSecondary">
              Dispatch Phone: {business.phone}
            </ThemedText>
          ) : null}
          {business?.address ? (
            <ThemedText type="caption" themeColor="textSecondary">
              Operating Address: {business.address}
            </ThemedText>
          ) : null}
          <ThemedText type="caption" themeColor="textSecondary">
            Owner: {profile?.full_name ?? 'Business Owner'}
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Role: Business Owner
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary">
            Account: {user?.email ?? 'owner@business.com'}
          </ThemedText>
        </Card>

        <Card variant="surface" style={styles.card}>
          <ThemedText type="headline">Dispatch Settings</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Single-worker manual dispatch enabled. Append-only event history active.
          </ThemedText>
        </Card>

        <Card
          variant="surface"
          style={styles.card}
          onPress={() => router.push('/owner/billing')}
          testID="profile-billing-card">
          <View style={styles.billingRow}>
            <View style={styles.billingTextContainer}>
              <ThemedText type="headline">Billing</ThemedText>
              <ThemedText type="body" themeColor="textSecondary">
                Manage your Dispatcher plan and view subscription options.
              </ThemedText>
            </View>
            <Button
              label="View Plan"
              variant="secondary"
              size="sm"
              onPress={() => router.push('/owner/billing')}
            />
          </View>
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
  billingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  billingTextContainer: {
    flex: 1,
    gap: Spacing.xxs,
  },
  signOutButton: {
    marginTop: Spacing.md,
  },
});
