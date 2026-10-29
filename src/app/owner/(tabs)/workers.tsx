import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Share, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, Loading, ScreenContainer } from '@/components/ui';
import { Palette, Radii, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { createWorkerInvitation } from '@/lib/auth';
import { AssignableWorker, fetchAssignableWorkers } from '@/lib/jobs';
import { logger } from '@/lib/logger';

export default function OwnerWorkersScreen() {
  const { businessId } = useAuth();
  const [workers, setWorkers] = useState<AssignableWorker[]>([]);
  const [isLoadingWorkers, setIsLoadingWorkers] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [generatedInvite, setGeneratedInvite] = useState<{
    code: string;
    expiresAt: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const loadWorkers = useCallback(async () => {
    if (!businessId) {
      setIsLoadingWorkers(false);
      return;
    }
    try {
      const res = await fetchAssignableWorkers(businessId);
      if (!res.error) {
        setWorkers(res.workers);
      }
    } catch (err) {
      logger.warn('WorkersTab', 'Failed to load workers roster:', err);
    } finally {
      setIsLoadingWorkers(false);
    }
  }, [businessId]);

  useFocusEffect(
    useCallback(() => {
      loadWorkers();
    }, [loadWorkers])
  );

  const handleInviteWorker = async () => {
    setIsGenerating(true);
    setCopied(false);
    setErrorMessage(null);

    try {
      const res = await createWorkerInvitation();
      if (res.success) {
        setGeneratedInvite({
          code: res.data.invite_code,
          expiresAt: res.data.expires_at,
        });
      } else {
        const errorText = res.error || 'Failed to create worker invitation.';
        setErrorMessage(errorText);
        logger.error('WorkersTab', 'Invitation generation error:', errorText);
        Alert.alert('Invitation Error', errorText);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate invitation';
      setErrorMessage(msg);
      logger.error('WorkersTab', 'Invitation generation exception:', msg);
      Alert.alert('Invitation Error', msg);
    } finally {
      setIsGenerating(false);
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

        {errorMessage ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <ThemedText type="caption" style={styles.errorText}>
              {errorMessage}
            </ThemedText>
          </View>
        ) : null}

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
        ) : isLoadingWorkers ? (
          <Loading label="Loading team roster..." />
        ) : workers.length > 0 ? (
          <View style={styles.rosterSection}>
            <View style={styles.rosterHeader}>
              <ThemedText type="label" themeColor="textSecondary">
                TEAM ROSTER ({workers.length})
              </ThemedText>
              <Button
                label={isGenerating ? 'Generating...' : '+ Invite Worker'}
                variant="primary"
                size="sm"
                disabled={isGenerating}
                onPress={handleInviteWorker}
              />
            </View>

            {workers.map((worker) => (
              <Card key={worker.id} variant="surface" style={styles.workerCard}>
                <View style={styles.workerInfo}>
                  <ThemedText type="headline">{worker.full_name}</ThemedText>
                  {worker.phone ? (
                    <ThemedText type="caption" themeColor="textSecondary">
                      {worker.phone}
                    </ThemedText>
                  ) : null}
                </View>
                <View
                  style={[
                    styles.statusBadge,
                    worker.is_active ? styles.statusBadgeActive : styles.statusBadgeInactive,
                  ]}>
                  <ThemedText
                    type="caption"
                    style={
                      worker.is_active ? styles.statusTextActive : styles.statusTextInactive
                    }>
                    {worker.is_active ? 'Active' : 'Inactive'}
                  </ThemedText>
                </View>
              </Card>
            ))}
          </View>
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
  errorBanner: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
    borderWidth: 1,
    borderRadius: Radii.sm,
    padding: Spacing.sm,
  },
  errorText: {
    color: '#991B1B',
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
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
  rosterSection: {
    gap: Spacing.sm,
  },
  rosterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  workerCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: Spacing.base,
  },
  workerInfo: {
    gap: 2,
  },
  statusBadge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radii.full,
  },
  statusBadgeActive: {
    backgroundColor: '#DEF7EC',
  },
  statusBadgeInactive: {
    backgroundColor: '#F3F4F6',
  },
  statusTextActive: {
    color: '#03543F',
    fontWeight: '600',
  },
  statusTextInactive: {
    color: '#6B7280',
    fontWeight: '500',
  },
  devCard: {
    padding: Spacing.base,
    marginTop: Spacing.lg,
  },
  devText: {
    marginVertical: Spacing.xs,
  },
});
