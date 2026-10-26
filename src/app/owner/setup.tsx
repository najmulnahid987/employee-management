import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, Input, Loading, ScreenContainer } from '@/components/ui';
import { Radii, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { provisionBusinessProfile } from '@/lib/auth';

export default function OwnerBusinessSetupScreen() {
  const { session, profile, role, refreshProfile, isLoading: authLoading } = useAuth();

  const [ownerFullName, setOwnerFullName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');

  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [formLoading, setFormLoading] = useState(false);

  // Focus navigation refs
  const businessNameRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const addressRef = useRef<TextInput>(null);

  // Guard: If unauthenticated, redirect to sign-in. If already provisioned, route to appropriate shell.
  useEffect(() => {
    if (!authLoading) {
      if (!session) {
        router.replace('/sign-in');
      } else if (profile) {
        if (role === 'owner') {
          router.replace('/owner/dashboard');
        } else if (role === 'worker') {
          router.replace('/worker/today');
        }
      } else {
        // Check if profile was already provisioned in the database
        refreshProfile();
      }
    }
  }, [session, profile, role, authLoading, refreshProfile]);

  if (authLoading) {
    return <Loading label="Checking onboarding eligibility..." fullScreen />;
  }

  const validate = (): boolean => {
    let isValid = true;
    setNameError(null);
    setPhoneError(null);
    setServerError(null);

    const trimmedName = businessName.trim();
    if (!trimmedName) {
      setNameError('Business name is required.');
      isValid = false;
    }

    const trimmedPhone = phone.trim();
    if (!trimmedPhone) {
      setPhoneError('Primary dispatch phone is required.');
      isValid = false;
    } else if (trimmedPhone.length < 7) {
      setPhoneError('Please enter a valid phone number.');
      isValid = false;
    }

    return isValid;
  };

  const handleSubmit = async () => {
    if (formLoading) return;

    if (!validate()) {
      return;
    }

    setFormLoading(true);

    try {
      const result = await provisionBusinessProfile({
        businessName,
        phone,
        address,
        ownerFullName,
      });

      if (!result.success) {
        // If repeated or concurrent submission caused "profile already exists", attempt to recover by refreshing profile
        if (result.error.toLowerCase().includes('already exists')) {
          const recovered = await refreshProfile();
          if (recovered.profile) {
            setFormLoading(false);
            router.replace('/owner/dashboard');
            return;
          }
        }

        setServerError(result.error);
        setFormLoading(false);
        return;
      }

      // Fetch the real authoritative profile and business from Supabase before completing onboarding
      const refreshed = await refreshProfile();
      setFormLoading(false);

      if (refreshed.profile) {
        router.replace('/owner/dashboard');
      } else {
        setServerError('Business provisioned successfully, but profile could not be loaded. Please reload.');
      }
    } catch (err) {
      setFormLoading(false);
      setServerError(err instanceof Error ? err.message : 'An unexpected error occurred during setup.');
    }
  };


  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        <View style={styles.header}>
          <ThemedText type="headline">Business Profile Setup</ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            Configure your local service company details before dispatching jobs.
          </ThemedText>
        </View>

        {serverError ? (
          <View style={[styles.alertBanner, styles.alertBannerError]} accessibilityRole="alert">
            <Text style={styles.alertBannerErrorText}>{serverError}</Text>
          </View>
        ) : null}

        <Card variant="surface" style={styles.card}>
          <Input
            label="Your Full Name"
            placeholder="e.g. John Doe"
            value={ownerFullName}
            onChangeText={setOwnerFullName}
            autoCapitalize="words"
            editable={!formLoading}
          />

          <Input
            label="Business Legal Name *"
            placeholder="e.g. Acme Plumbing & Heating"
            value={businessName}
            onChangeText={(text) => {
              setBusinessName(text);
              if (nameError) setNameError(null);
              if (serverError) setServerError(null);
            }}
            error={nameError ?? undefined}
            editable={!formLoading}
          />

          <Input
            label="Primary Dispatch Phone *"
            placeholder="e.g. (555) 019-2834"
            value={phone}
            onChangeText={(text) => {
              setPhone(text);
              if (phoneError) setPhoneError(null);
              if (serverError) setServerError(null);
            }}
            error={phoneError ?? undefined}
            keyboardType="phone-pad"
            editable={!formLoading}
          />

          <Input
            label="Operating Address (Optional)"
            placeholder="e.g. 100 Main St, Suite 200"
            value={address}
            onChangeText={setAddress}
            helperText="Physical headquarters or primary operating dispatch territory."
            editable={!formLoading}
          />

          <Button
            label="Complete Business Setup"
            variant="primary"
            fullWidth
            loading={formLoading}
            disabled={formLoading}
            onPress={handleSubmit}
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
  alertBanner: {
    padding: Spacing.sm,
    borderRadius: Radii.sm,
    borderWidth: 1,
  },
  alertBannerError: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  alertBannerErrorText: {
    color: '#991B1B',
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  card: {
    padding: Spacing.base,
  },
  actionButton: {
    marginTop: Spacing.sm,
  },
});

