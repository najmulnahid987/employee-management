import React, { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, ScreenContainer } from '@/components/ui';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export default function OwnerBillingScreen() {
  const theme = useTheme();
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const handleUpgradePress = () => {
    setInfoMessage('Paid plans are coming soon.');
    Alert.alert('Upgrade plan', 'Paid plans are coming soon.');
  };

  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container} testID="billing-screen">
        {/* Screen Header */}
        <View style={styles.header}>
          <ThemedText type="headline">Billing</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Manage your Dispatcher plan
          </ThemedText>
        </View>

        {/* Current Plan Card */}
        <Card variant="surface" style={styles.card} testID="current-plan-card">
          <View style={styles.cardHeaderRow}>
            <ThemedText type="headline">Free</ThemedText>
            <View
              style={[
                styles.badge,
                {
                  backgroundColor: theme.surfaceSecondary,
                  borderColor: theme.border,
                },
              ]}>
              <ThemedText type="caption" style={{ fontWeight: '600' }}>
                Current plan
              </ThemedText>
            </View>
          </View>

          <View style={styles.priceRow}>
            <ThemedText type="hero" style={styles.priceText}>
              $0
            </ThemedText>
            <ThemedText type="caption" themeColor="textSecondary" style={styles.periodText}>
              No payment required
            </ThemedText>
          </View>

          <ThemedText type="body" themeColor="textSecondary">
            Use Dispatcher to manage your jobs and coordinate your team.
          </ThemedText>
        </Card>

        {/* Future Paid Plan Section */}
        <Card variant="surface" style={styles.card} testID="future-plan-card">
          <View style={styles.cardHeaderRow}>
            <View style={styles.headerTextWrap}>
              <ThemedText type="headline">More features, coming soon</ThemedText>
              <ThemedText type="body" themeColor="textSecondary">
                Paid plans are planned for businesses that need more from Dispatcher.
              </ThemedText>
            </View>
            <View
              style={[
                styles.badge,
                {
                  backgroundColor: theme.surfaceSecondary,
                  borderColor: theme.border,
                },
              ]}>
              <ThemedText
                type="caption"
                themeColor="textSecondary"
                style={{ fontWeight: '500' }}>
                Coming soon
              </ThemedText>
            </View>
          </View>

          <Button
            label="Upgrade plan"
            variant="outline"
            fullWidth
            onPress={handleUpgradePress}
            style={styles.upgradeButton}
            testID="upgrade-plan-button"
          />

          {infoMessage ? (
            <View
              style={[
                styles.infoBanner,
                {
                  backgroundColor: theme.surfaceSecondary,
                  borderColor: theme.border,
                },
              ]}
              testID="upgrade-info-banner">
              <ThemedText type="caption" style={{ fontWeight: '500' }}>
                {infoMessage}
              </ThemedText>
            </View>
          ) : null}
        </Card>

        {/* Billing Information Note */}
        <View style={styles.noteContainer}>
          <ThemedText
            type="caption"
            themeColor="textSecondary"
            style={styles.noteText}>
            Billing and paid subscriptions are not available yet. You can continue using the current version of Dispatcher.
          </ThemedText>
        </View>
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
    gap: Spacing.md,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  headerTextWrap: {
    flex: 1,
    gap: Spacing.xxs,
  },
  priceRow: {
    gap: Spacing.xxs,
  },
  priceText: {
    fontSize: 32,
    fontWeight: '700',
    lineHeight: 38,
  },
  periodText: {
    marginTop: -Spacing.xxs,
  },
  badge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xxs,
    borderRadius: Radii.full,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  upgradeButton: {
    marginTop: Spacing.xs,
  },
  infoBanner: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderRadius: Radii.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteContainer: {
    paddingHorizontal: Spacing.xs,
    paddingTop: Spacing.xs,
  },
  noteText: {
    textAlign: 'center',
    lineHeight: 18,
  },
});
