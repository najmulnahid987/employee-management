import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, ScreenContainer } from '@/components/ui';
import { BottomTabInset, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export default function HomeScreen() {
  const theme = useTheme();

  return (
    <ScreenContainer
      scrollable
      contentContainerStyle={[
        styles.container,
        { paddingBottom: BottomTabInset + Spacing.xl },
      ]}>
      <View style={styles.content}>
        {/* Brand & Tagline */}
        <View style={styles.brandSection}>
          <View style={styles.brandRow}>
            <View
              style={[
                styles.brandBadge,
                { backgroundColor: theme.surfaceSecondary },
              ]}>
              <ThemedText type="label" themeColor="textSecondary" style={styles.brandBadgeText}>
                DISPATCHER
              </ThemedText>
            </View>
          </View>

          <ThemedText type="hero" style={styles.headline}>
            Keep every job and worker in sync.
          </ThemedText>

          <ThemedText type="body" themeColor="textSecondary" style={styles.supportingCopy}>
            A simpler way to coordinate your field team.
          </ThemedText>
        </View>

        {/* Restrained, Neutral Status Card */}
        <Card variant="surface" style={styles.setupCard}>
          {/* Simple visual detail using native components */}
          <View style={styles.visualRow}>
            <View
              style={[
                styles.iconTile,
                { backgroundColor: theme.surfaceSecondary },
              ]}>
              <View style={styles.gridRow}>
                <View
                  style={[
                    styles.gridCell,
                    { backgroundColor: theme.primary },
                  ]}
                />
                <View
                  style={[
                    styles.gridCell,
                    { backgroundColor: theme.borderStrong },
                  ]}
                />
              </View>
              <View style={styles.gridRow}>
                <View
                  style={[
                    styles.gridCell,
                    { backgroundColor: theme.borderStrong },
                  ]}
                />
                <View
                  style={[
                    styles.gridCell,
                    { backgroundColor: theme.borderStrong },
                  ]}
                />
              </View>
            </View>

            <View
              style={[
                styles.statusPill,
                {
                  backgroundColor: theme.surfaceSecondary,
                  borderColor: theme.border,
                },
              ]}>
              <View style={styles.statusDot} />
              <ThemedText type="label" themeColor="textSecondary" style={styles.statusPillText}>
                READY
              </ThemedText>
            </View>
          </View>

          <View style={styles.cardContent}>
            <ThemedText type="headline" style={styles.cardHeading}>
              Your workspace is ready to be set up.
            </ThemedText>
            <ThemedText type="caption" themeColor="textSecondary" style={styles.cardBody}>
              Configure your dispatch preferences, invite field workers, and schedule your incoming jobs.
            </ThemedText>
          </View>
        </Card>

        {/* Obvious Primary Action */}
        <View style={styles.actionContainer}>
          <Button
            label="Set Up Workspace"
            variant="primary"
            size="md"
            fullWidth
          />
        </View>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: Spacing.lg,
  },
  content: {
    width: '100%',
    gap: Spacing.xl,
  },
  brandSection: {
    gap: Spacing.sm,
  },
  brandRow: {
    flexDirection: 'row',
  },
  brandBadge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xxs,
    borderRadius: Radii.xs,
  },
  brandBadgeText: {
    letterSpacing: 0.8,
  },
  headline: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '700',
  },
  supportingCopy: {
    fontSize: 15,
    lineHeight: 22,
  },
  setupCard: {
    gap: Spacing.base,
    padding: Spacing.lg,
  },
  visualRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  iconTile: {
    width: 36,
    height: 36,
    borderRadius: Radii.sm,
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 3,
  },
  gridRow: {
    flexDirection: 'row',
    gap: 3,
  },
  gridCell: {
    width: 10,
    height: 10,
    borderRadius: 2,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xxs,
    borderRadius: Radii.pill,
    borderWidth: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#15803D',
  },
  statusPillText: {
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.5,
  },
  cardContent: {
    gap: Spacing.xs,
  },
  cardHeading: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '600',
  },
  cardBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  actionContainer: {
    width: '100%',
    paddingTop: Spacing.xs,
  },
});
