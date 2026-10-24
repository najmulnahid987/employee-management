import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, Input, Loading, ScreenContainer } from '@/components/ui';
import { Radii, Spacing, Typography } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { supabase } from '@/lib/supabase';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignInScreen() {
  const theme = useTheme();
  const { signIn, signUp, session, role, profile, isLoading: authLoading } = useAuth();

  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Field-level error validation states
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmPasswordError, setConfirmPasswordError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  // Email confirmation success state
  const [verificationSentEmail, setVerificationSentEmail] = useState<string | null>(null);

  // Submission in-flight guard
  const [formLoading, setFormLoading] = useState(false);

  // Focus navigation refs
  const emailInputRef = useRef<TextInput>(null);
  const passwordInputRef = useRef<TextInput>(null);
  const confirmPasswordInputRef = useRef<TextInput>(null);

  // If already authenticated, show redirecting state while NavigationRouteGuard resolves destination
  if (session && !authLoading) {
    return <Loading fullScreen label="Redirecting..." />;
  }

  const switchMode = (newMode: 'signin' | 'signup') => {
    setMode(newMode);
    setEmailError(null);
    setPasswordError(null);
    setConfirmPasswordError(null);
    setServerError(null);
    setVerificationSentEmail(null);
  };

  const validate = (): boolean => {
    let isValid = true;
    setEmailError(null);
    setPasswordError(null);
    setConfirmPasswordError(null);
    setServerError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setEmailError('Email address is required.');
      isValid = false;
    } else if (!EMAIL_REGEX.test(trimmedEmail)) {
      setEmailError('Please enter a valid email address.');
      isValid = false;
    }

    if (!password) {
      setPasswordError('Password is required.');
      isValid = false;
    } else if (password.length < 6) {
      setPasswordError('Password must be at least 6 characters.');
      isValid = false;
    }

    if (mode === 'signup') {
      if (!confirmPassword) {
        setConfirmPasswordError('Please confirm your password.');
        isValid = false;
      } else if (password !== confirmPassword) {
        setConfirmPasswordError('Passwords do not match.');
        isValid = false;
      }
    }

    return isValid;
  };

  const handleSubmit = async () => {
    if (formLoading) return; // Prevent duplicate concurrent submissions

    if (!validate()) {
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();
    setFormLoading(true);

    try {
      if (mode === 'signin') {
        const result = await signIn(trimmedEmail, password);
        if (!result.success) {
          setServerError(result.error ?? 'Invalid email or password.');
        }
      } else {
        const result = await signUp(trimmedEmail, password);
        if (!result.success) {
          setServerError(result.error ?? 'Failed to create account.');
        } else if (result.requiresEmailConfirmation) {
          setVerificationSentEmail(trimmedEmail);
          setPassword('');
          setConfirmPassword('');
        }
      }
    } finally {
      setFormLoading(false);
    }
  };



  // Temporary development-only Supabase connection diagnostic (M3.5)
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState<{
    status: number | null;
    outcome: 'idle' | 'success' | 'permission_denied' | 'error';
    summary: string;
    detail: string;
    latencyMs?: number;
  }>({
    status: null,
    outcome: 'idle',
    summary: 'Not tested yet',
    detail: 'Tap "Test Supabase Connection" to test live connectivity.',
  });

  const runDiagnostic = async () => {
    setDiagLoading(true);
    const start = Date.now();
    try {
      // 1. Query only businesses.id with limit of 1; never display business data or credentials
      const { data, error, status } = await supabase
        .from('businesses')
        .select('id')
        .limit(1);

      const latencyMs = Date.now() - start;

      if (error) {
        if (status === 403 || error.code === '42501') {
          setDiagResult({
            status,
            outcome: 'permission_denied',
            summary: `HTTP ${status} — Permission Denied (Expected)`,
            detail:
              'API is reachable. Query was rejected by PostgreSQL Row Level Security (RLS default-deny baseline for M3).',
            latencyMs,
          });
        } else {
          setDiagResult({
            status,
            outcome: 'error',
            summary: `HTTP ${status || 'ERR'} — Query Failed`,
            detail: `${error.message} (Code: ${error.code || 'UNKNOWN'})`,
            latencyMs,
          });
        }
      } else {
        // Successful empty result is normal while RLS select policies are not yet configured
        setDiagResult({
          status,
          outcome: 'success',
          summary: `HTTP ${status} OK — Reachable`,
          detail: `API reachable. Returned ${data.length} row(s). Empty result is normal under M3 RLS default-deny.`,
          latencyMs,
        });
      }
    } catch (err: any) {
      setDiagResult({
        status: 0,
        outcome: 'error',
        summary: 'Network / Config Error',
        detail: err?.message || 'Failed to reach Supabase API.',
        latencyMs: Date.now() - start,
      });
    } finally {
      setDiagLoading(false);
    }
  };

  useEffect(() => {
    if (__DEV__) {
      runDiagnostic();
    }
  }, []);

  return (
    <ScreenContainer scrollable withPadding>
      <View style={styles.container}>
        {/* Header / Brand */}
        <View style={styles.header}>
          <View style={[styles.badge, { backgroundColor: theme.surfaceSecondary }]}>
            <ThemedText type="label" themeColor="textSecondary">
              DISPATCHER
            </ThemedText>
          </View>
          <ThemedText type="title" style={styles.title}>
            {mode === 'signin' ? 'Sign In' : 'Create Account'}
          </ThemedText>
          <ThemedText type="body" themeColor="textSecondary" style={styles.subtitle}>
            {mode === 'signin'
              ? 'Enter your credentials to access your dispatch operations.'
              : 'Register a business owner account to start dispatching.'}
          </ThemedText>
        </View>

        {/* Mode Switcher */}
        <View
          style={[styles.toggleContainer, { backgroundColor: theme.surfaceSecondary }]}
          accessibilityRole="tablist">
          <TouchableOpacity
            style={[
              styles.toggleTab,
              mode === 'signin' && [styles.toggleTabActive, { backgroundColor: theme.surface }],
            ]}
            onPress={() => switchMode('signin')}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === 'signin' }}
            accessibilityLabel="Sign In tab">
            <Text
              style={[
                styles.toggleTabText,
                { color: mode === 'signin' ? theme.text : theme.textSecondary },
              ]}>
              Sign In
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.toggleTab,
              mode === 'signup' && [styles.toggleTabActive, { backgroundColor: theme.surface }],
            ]}
            onPress={() => switchMode('signup')}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === 'signup' }}
            accessibilityLabel="Create Account tab">
            <Text
              style={[
                styles.toggleTabText,
                { color: mode === 'signup' ? theme.text : theme.textSecondary },
              ]}>
              Create Account
            </Text>
          </TouchableOpacity>
        </View>

        {/* Global Server Error Alert */}
        {serverError ? (
          <View
            style={[styles.alertBanner, styles.alertBannerError]}
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive">
            <Text style={styles.alertBannerErrorText}>{serverError}</Text>
          </View>
        ) : null}

        {/* Email Verification Sent View */}
        {verificationSentEmail ? (
          <Card variant="surface" style={styles.confirmationCard}>
            <View style={[styles.badge, styles.confirmationBadge]}>
              <ThemedText type="label" style={styles.confirmationBadgeText}>
                CHECK YOUR EMAIL
              </ThemedText>
            </View>
            <ThemedText type="headline" style={styles.confirmationTitle}>
              Verification Link Sent
            </ThemedText>
            <ThemedText type="body" themeColor="textSecondary" style={styles.confirmationText}>
              We sent a verification link to {verificationSentEmail}. Please open the link in your email to confirm your account, then return here to sign in.
            </ThemedText>
            <Button
              label="Return to Sign In"
              variant="primary"
              fullWidth
              onPress={() => switchMode('signin')}
              style={styles.confirmationButton}
            />
          </Card>
        ) : (
          /* Credentials Form */
          <Card variant="surface" style={styles.formCard}>
            <Input
              ref={emailInputRef}
              label="Email Address"
              placeholder="name@business.com"
              value={email}
              onChangeText={(text) => {
                setEmail(text);
                if (emailError) setEmailError(null);
                if (serverError) setServerError(null);
              }}
              error={emailError ?? undefined}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
              returnKeyType="next"
              onSubmitEditing={() => passwordInputRef.current?.focus()}
              blurOnSubmit={false}
              editable={!formLoading}
              accessibilityLabel="Email Address"
              accessibilityHint="Enter your email address"
            />

            <Input
              ref={passwordInputRef}
              label="Password"
              placeholder="••••••••"
              value={password}
              onChangeText={(text) => {
                setPassword(text);
                if (passwordError) setPasswordError(null);
                if (serverError) setServerError(null);
              }}
              error={passwordError ?? undefined}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType={mode === 'signup' ? 'newPassword' : 'password'}
              helperText={mode === 'signup' && !passwordError ? 'At least 6 characters' : undefined}
              returnKeyType={mode === 'signup' ? 'next' : 'done'}
              onSubmitEditing={() => {
                if (mode === 'signup') {
                  confirmPasswordInputRef.current?.focus();
                } else {
                  handleSubmit();
                }
              }}
              blurOnSubmit={mode !== 'signup'}
              editable={!formLoading}
              accessibilityLabel="Password"
              accessibilityHint="Enter your password"
              rightIcon={
                <Pressable
                  onPress={() => setShowPassword((prev) => !prev)}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                  hitSlop={8}
                  style={styles.showHideToggle}>
                  <Text style={[styles.showHideText, { color: theme.textSecondary }]}>
                    {showPassword ? 'Hide' : 'Show'}
                  </Text>
                </Pressable>
              }
            />

            {mode === 'signup' ? (
              <Input
                ref={confirmPasswordInputRef}
                label="Confirm Password"
                placeholder="••••••••"
                value={confirmPassword}
                onChangeText={(text) => {
                  setConfirmPassword(text);
                  if (confirmPasswordError) setConfirmPasswordError(null);
                  if (serverError) setServerError(null);
                }}
                error={confirmPasswordError ?? undefined}
                secureTextEntry={!showConfirmPassword}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                returnKeyType="done"
                onSubmitEditing={handleSubmit}
                editable={!formLoading}
                accessibilityLabel="Confirm Password"
                accessibilityHint="Re-enter your password to confirm"
                rightIcon={
                  <Pressable
                    onPress={() => setShowConfirmPassword((prev) => !prev)}
                    accessibilityRole="button"
                    accessibilityLabel={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                    hitSlop={8}
                    style={styles.showHideToggle}>
                    <Text style={[styles.showHideText, { color: theme.textSecondary }]}>
                      {showConfirmPassword ? 'Hide' : 'Show'}
                    </Text>
                  </Pressable>
                }
              />
            ) : null}

            <Button
              label={mode === 'signin' ? 'Sign In' : 'Create Owner Account'}
              variant="primary"
              fullWidth
              loading={formLoading}
              disabled={formLoading}
              onPress={handleSubmit}
              style={styles.signInButton}
            />
          </Card>
        )}

        {/* Supabase Connection Diagnostic (Dev Only) */}
        {__DEV__ && (
          <Card variant="subtle" style={styles.devCard}>
            <View style={styles.diagSection}>
              <View style={styles.diagHeader}>
                <ThemedText type="headline" style={styles.diagTitle}>
                  Supabase Connection Diagnostic
                </ThemedText>
                <View
                  style={[
                    styles.diagBadge,
                    diagResult.outcome === 'success' && styles.diagBadgeSuccess,
                    diagResult.outcome === 'permission_denied' && styles.diagBadgeWarning,
                    diagResult.outcome === 'error' && styles.diagBadgeError,
                  ]}>
                  {diagLoading ? (
                    <ActivityIndicator size="small" color="#1F2937" />
                  ) : (
                    <Text style={styles.diagBadgeText}>
                      {diagResult.outcome === 'success'
                        ? 'CONNECTED'
                        : diagResult.outcome === 'permission_denied'
                          ? 'RLS DENIED'
                          : diagResult.outcome === 'error'
                            ? 'FAILED'
                            : 'IDLE'}
                    </Text>
                  )}
                </View>
              </View>

              <ThemedText type="caption" themeColor="textSecondary" style={styles.diagDetail}>
                Target: businesses.id (limit 1) • Dev diagnostic only
              </ThemedText>

              <View style={styles.diagResultCard}>
                <ThemedText type="label" style={styles.diagSummaryText}>
                  {diagResult.summary}
                  {diagResult.latencyMs !== undefined ? ` (${diagResult.latencyMs}ms)` : ''}
                </ThemedText>
                <ThemedText type="caption" themeColor="textSecondary">
                  {diagResult.detail}
                </ThemedText>
              </View>

              <Button
                label={diagLoading ? 'Testing Connection...' : 'Re-run Supabase Diagnostic'}
                variant="outline"
                size="sm"
                disabled={diagLoading}
                onPress={runDiagnostic}
                style={styles.diagButton}
              />
            </View>
          </Card>
        )}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: Spacing.xl,
    gap: Spacing.lg,
  },
  header: {
    alignItems: 'center',
    gap: Spacing.xs,
  },
  badge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderRadius: Radii.pill,
    marginBottom: Spacing.xs,
  },
  title: {
    textAlign: 'center',
  },
  subtitle: {
    textAlign: 'center',
    maxWidth: 320,
  },
  toggleContainer: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: Radii.sm,
    gap: 4,
  },
  toggleTab: {
    flex: 1,
    paddingVertical: Spacing.xs + 2,
    alignItems: 'center',
    borderRadius: Radii.xs,
  },
  toggleTabActive: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  toggleTabText: {
    fontSize: 13,
    fontWeight: '600',
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
  alertBannerSuccess: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  alertBannerSuccessText: {
    color: '#166534',
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  formCard: {
    padding: Spacing.base,
  },
  showHideToggle: {
    paddingHorizontal: Spacing.xs,
    paddingVertical: Spacing.xs,
    justifyContent: 'center',
    alignItems: 'center',
  },
  showHideText: {
    fontSize: 12,
    fontWeight: '600',
  },
  confirmationCard: {
    padding: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  confirmationBadge: {
    backgroundColor: '#DCFCE7',
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderRadius: Radii.pill,
    marginBottom: Spacing.xs,
  },
  confirmationBadgeText: {
    color: '#166534',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  confirmationTitle: {
    textAlign: 'center',
  },
  confirmationText: {
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: Spacing.sm,
  },
  confirmationButton: {
    marginTop: Spacing.xs,
  },
  signInButton: {
    marginTop: Spacing.sm,
  },
  devCard: {
    padding: Spacing.base,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    borderStyle: 'dashed',
  },
  devTag: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.xs + 2,
    paddingVertical: 2,
    borderRadius: Radii.xs,
    backgroundColor: '#E5E5E5',
    marginBottom: Spacing.xs,
  },
  devTagText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  devTitle: {
    marginBottom: 2,
  },
  devDescription: {
    marginBottom: Spacing.md,
  },
  devActions: {
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  devSubLinks: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  diagSection: {
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: '#E5E5E5',
    gap: Spacing.xs,
  },
  diagHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  diagTitle: {
    fontSize: 14,
  },
  diagBadge: {
    paddingHorizontal: Spacing.xs + 2,
    paddingVertical: 2,
    borderRadius: Radii.pill,
    backgroundColor: '#E5E5E5',
  },
  diagBadgeSuccess: {
    backgroundColor: '#DCFCE7',
  },
  diagBadgeWarning: {
    backgroundColor: '#FEF9C3',
  },
  diagBadgeError: {
    backgroundColor: '#FEE2E2',
  },
  diagBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#1F2937',
  },
  diagDetail: {
    marginBottom: Spacing.xs,
  },
  diagResultCard: {
    backgroundColor: '#F9FAFB',
    padding: Spacing.sm,
    borderRadius: Radii.sm,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    gap: 2,
  },
  diagSummaryText: {
    fontWeight: '600',
  },
  diagButton: {
    marginTop: Spacing.xs,
  },
});
