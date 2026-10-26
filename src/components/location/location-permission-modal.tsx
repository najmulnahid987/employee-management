/**
 * Dispatcher Location Permission Explanation Modal
 *
 * Implements the mandatory user-facing explanation required before
 * requesting operating system location permissions.
 *
 * Design:
 * - Minimal professional B2B interface.
 * - Black primary button with large touch target.
 * - Plain English explanation of active job sharing and off-duty privacy.
 * - Allows continuing the workflow without location tracking if skipped.
 */

import React from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card } from '@/components/ui';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { LOCATION_PERMISSION_EXPLANATION } from '@/lib/location-policy';

export interface LocationPermissionModalProps {
  visible: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
  isRequesting?: boolean;
}

export function LocationPermissionModal({
  visible,
  onConfirm,
  onDismiss,
  isRequesting = false,
}: LocationPermissionModalProps) {
  const theme = useTheme();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={[styles.dialogCard, { backgroundColor: theme.surface }]}>
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}>
            {/* Header / Title */}
            <View style={styles.header}>
              <View style={[styles.tag, { backgroundColor: Palette.blueBg }]}>
                <ThemedText type="label" style={{ color: Palette.blueText }}>
                  PRIVACY & LOCATION
                </ThemedText>
              </View>
              <ThemedText type="headline" style={styles.title}>
                {LOCATION_PERMISSION_EXPLANATION.title}
              </ThemedText>
            </View>

            {/* Core Explanation Callout */}
            <Card
              variant="surface"
              style={[
                styles.leadCard,
                { backgroundColor: theme.surfaceSecondary, borderColor: theme.border },
              ]}>
              <ThemedText type="bodyMedium" style={styles.leadText}>
                {LOCATION_PERMISSION_EXPLANATION.lead}
              </ThemedText>
              <ThemedText type="body" themeColor="textSecondary" style={styles.bodyText}>
                {LOCATION_PERMISSION_EXPLANATION.body}
              </ThemedText>
            </Card>

            {/* Invariant Bullet Points */}
            <View style={styles.bulletList}>
              {LOCATION_PERMISSION_EXPLANATION.bullets.map((item, index) => (
                <View key={index} style={styles.bulletItem}>
                  <View style={[styles.bulletDot, { backgroundColor: theme.primary }]} />
                  <View style={styles.bulletContent}>
                    <ThemedText type="bodyMedium" style={styles.bulletTitle}>
                      {item.title}
                    </ThemedText>
                    <ThemedText type="caption" themeColor="textSecondary">
                      {item.text}
                    </ThemedText>
                  </View>
                </View>
              ))}
            </View>

            {/* Action Buttons */}
            <View style={styles.actionContainer}>
              <Button
                label="Allow Location Access"
                variant="primary"
                size="lg"
                loading={isRequesting}
                onPress={onConfirm}
                fullWidth
              />
              <Button
                label="Continue Without Location"
                variant="ghost"
                size="md"
                disabled={isRequesting}
                onPress={onDismiss}
                fullWidth
              />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.base,
  },
  dialogCard: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '90%',
    borderRadius: Radii.lg,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  scrollContent: {
    padding: Spacing.lg,
    gap: Spacing.base,
  },
  header: {
    gap: Spacing.xs,
  },
  tag: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radii.full,
  },
  title: {
    marginTop: Spacing.xs,
  },
  leadCard: {
    padding: Spacing.md,
    borderRadius: Radii.md,
    borderWidth: 1,
    gap: Spacing.xs,
  },
  leadText: {
    fontWeight: '600',
  },
  bodyText: {
    lineHeight: 20,
  },
  bulletList: {
    gap: Spacing.md,
    marginVertical: Spacing.xs,
  },
  bulletItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
  },
  bulletDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 6,
  },
  bulletContent: {
    flex: 1,
    gap: 2,
  },
  bulletTitle: {
    fontSize: 14,
  },
  actionContainer: {
    marginTop: Spacing.sm,
    gap: Spacing.xs,
  },
});
