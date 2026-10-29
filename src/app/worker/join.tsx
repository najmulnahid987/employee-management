import { router } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, EmptyState, Input, ScreenContainer } from '@/components/ui';
import { Palette, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { joinBusinessTeam } from '@/lib/auth';

export default function WorkerInvitationJoinScreen() {
  const { refreshProfile, signOut } = useAuth();
  const [inviteCode, setInviteCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasInvalidCodeError, setHasInvalidCodeError] = useState(false);

  const handleJoin = async () => {
    const trimmedCode = inviteCode.trim();
    const trimmedName = fullName.trim();

    if (!trimmedCode) {
      setErrorMessage('Please enter an invitation code.');
      return;
    }
    if (!trimmedName) {
      setErrorMessage('Please enter your full name.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    const result = await joinBusinessTeam({
      inviteCode: trimmedCode,
      fullName: trimmedName,
      phone: phone.trim() || undefined,
    });

    if (!result.success) {
      setIsSubmitting(false);
      setErrorMessage(result.error);
      if (
        result.error.toLowerCase().includes('invalid invitation') ||
        result.error.toLowerCase().includes('already been used') ||
        result.error.toLowerCase().includes('expired')
      ) {
        setHasInvalidCodeError(true);
      }
      return;
    }

    // Refresh profile to trigger root layout role-based navigation
    await refreshProfile();
    setIsSubmitting(false);
    router.replace('/worker/today');
  };

  if (hasInvalidCodeError) {
    return (
      <ScreenContainer scrollable withPadding>
        <View style={styles.container}>
          <EmptyState
            title="Invalid or expired invitation"
            description="The invitation code you entered could not be verified, has already been redeemed, or has expired. Please contact your employer to receive a valid invite."
            actionLabel="Try Another Code"
            onAction={() => {
              setHasInvalidCodeError(false);
              setErrorMessage(null);
            }}
          />
          <Button
            label="Sign Out"
            variant="ghost"
            fullWidth
            onPress={async () => {
              await signOut();
              router.replace('/sign-in');
            }}
          />
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Join Business Team</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Enter your invitation code to join your company's dispatch roster.
          </ThemedText>
        </View>

        {errorMessage ? (
          <View style={styles.errorBanner}>
            <ThemedText type="caption" style={styles.errorText}>
              {errorMessage}
            </ThemedText>
          </View>
        ) : null}

        <Card variant="surface" style={styles.card}>
          <Input
            label="Invitation Code"
            placeholder="e.g. DISP-7829-JOIN"
            value={inviteCode}
            onChangeText={(text) => {
              setInviteCode(text);
              if (errorMessage) setErrorMessage(null);
            }}
            autoCapitalize="characters"
            autoCorrect={false}
          />

          <Input
            label="Your Full Name"
            placeholder="e.g. Alex Morgan"
            value={fullName}
            onChangeText={(text) => {
              setFullName(text);
              if (errorMessage) setErrorMessage(null);
            }}
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
            loading={isSubmitting}
            disabled={isSubmitting}
            onPress={handleJoin}
            style={styles.actionButton}
          />
        </Card>

        <Button
          label="Registering a new company? Set up Business"
          variant="outline"
          fullWidth
          disabled={isSubmitting}
          onPress={() => router.push('/owner/setup')}
        />

        <Button
          label="Sign Out"
          variant="ghost"
          fullWidth
          onPress={async () => {
            await signOut();
            router.replace('/sign-in');
          }}
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
    gap: Spacing.sm,
  },
  actionButton: {
    marginTop: Spacing.sm,
  },
  errorBanner: {
    padding: Spacing.sm,
    backgroundColor: Palette.redBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Palette.redBorder,
  },
  errorText: {
    color: Palette.redText,
    fontWeight: '500',
  },
});
