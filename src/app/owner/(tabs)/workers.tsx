import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Share, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, ScreenContainer } from '@/components/ui';
import { Palette, Spacing } from '@/constants/theme';
import { createWorkerInvitation } from '@/lib/auth';

export default function OwnerWorkersScreen() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedInvite, setGeneratedInvite] = useState<{
    code: string;
    expiresAt: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleInviteWorker = async () => {
    setIsGenerating(true);
    setCopied(false);
    const res = await createWorkerInvitation();
    setIsGenerating(false);

    if (res.success) {
      setGeneratedInvite({
        code: res.data.invite_code,
        expiresAt: res.data.expires_at,
      });
    } else {
      Alert.alert('Invitation Error', res.error);
    }
  };

  const handleCopyCode = async () => {
    if (!generatedInvite) return;
    await Clipboard.setStringAsync(generatedInvite.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShareInvite = async () => {
    if (!generatedInvite) return;
    try {
      await Share.share({
        message: `You've been invited to join the field dispatch team! Open Dispatcher and enter your invitation code: ${generatedInvite.code}`,
      });
    } catch {
      // Ignored
    }
  };

  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Field Workers</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Manage field technicians and view team assignments.
          </ThemedText>
        </View>

        {generatedInvite ? (
          <Card variant="surface" style={styles.inviteCard}>
            <ThemedText type="headline" style={{ color: Palette.greenText }}>
              Worker Invitation Created
            </ThemedText>
            <ThemedText type="body" themeColor="textSecondary">
              Share this code with your technician to let them join your dispatch team:
            </ThemedText>
            <View style={styles.codeContainer}>
              <ThemedText type="title" style={styles.codeText}>
                {generatedInvite.code}
              </ThemedText>
            </View>
            <View style={styles.buttonRow}>
              <Button
                label={copied ? 'Copied!' : 'Copy Code'}
                variant="outline"
                onPress={handleCopyCode}
                style={styles.actionBtn}
              />
              <Button
                label="Share Code"
                variant="primary"
                onPress={handleShareInvite}
                style={styles.actionBtn}
              />
            </View>
            <Button
              label="Done"
              variant="ghost"
              onPress={() => setGeneratedInvite(null)}
            />
          </Card>
        ) : (
          <EmptyState
            title="No Workers on Your Team"
            description="You haven't added any technicians to your business roster yet. Invite workers to start assigning jobs."
            actionLabel={isGenerating ? 'Generating...' : '+ Invite Worker'}
            onAction={handleInviteWorker}
          />
        )}

        {/* Development test shortcut to stack screen */}
        <Card variant="subtle" style={styles.devCard}>
          <ThemedText type="label" themeColor="textSecondary">
            STACK ROUTE PREVIEW
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary" style={styles.devText}>
            Inspect the individual Worker Details screen:
          </ThemedText>
          <Button
            label="Open Worker Details Placeholder"
            variant="outline"
            size="sm"
            onPress={() => router.push('/owner/worker-details')}
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
  inviteCard: {
    padding: Spacing.base,
    gap: Spacing.sm,
  },
  codeContainer: {
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    padding: Spacing.md,
    borderRadius: 8,
    alignItems: 'center',
    marginVertical: Spacing.xs,
  },
  codeText: {
    letterSpacing: 2,
    fontWeight: '700',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  actionBtn: {
    flex: 1,
  },
  devCard: {
    padding: Spacing.base,
    marginTop: Spacing.lg,
  },
  devText: {
    marginVertical: Spacing.xs,
  },
});
