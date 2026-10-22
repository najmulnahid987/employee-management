import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button, Card, Input, ScreenContainer } from '@/components/ui';
import { Radii, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { supabase } from '@/lib/supabase';

export default function SignInScreen() {
  const theme = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

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
            Sign In
          </ThemedText>
          <ThemedText type="body" themeColor="textSecondary" style={styles.subtitle}>
            Enter your credentials to access your dispatch operations.
          </ThemedText>
        </View>

        {/* Credentials Form */}
        <Card variant="surface" style={styles.formCard}>
          <Input
            label="Email Address"
            placeholder="name@business.com"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Input
            label="Password"
            placeholder="••••••••"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
          />

          <Button
            label="Sign In"
            variant="primary"
            fullWidth
            onPress={() => {
              // Placeholder: No backend authentication in M2B
            }}
            style={styles.signInButton}
          />
        </Card>

        {/* Development Role-Based Shell Inspector */}
        <Card variant="subtle" style={styles.devCard}>
          <View style={styles.devTag}>
            <Text style={[styles.devTagText, { color: theme.textSecondary }]}>
              DEV PREVIEW ONLY
            </Text>
          </View>

          <ThemedText type="headline" style={styles.devTitle}>
            Inspect Navigation Shells
          </ThemedText>
          <ThemedText type="caption" themeColor="textSecondary" style={styles.devDescription}>
            Preview role-based tab shells and onboarding flows without authentication.
          </ThemedText>

          <View style={styles.devActions}>
            <Button
              label="Inspect Owner Shell (5 Tabs)"
              variant="primary"
              fullWidth
              onPress={() => router.push('/owner/dashboard')}
            />

            <Button
              label="Inspect Worker Shell (3 Tabs)"
              variant="secondary"
              fullWidth
              onPress={() => router.push('/worker/today')}
            />
          </View>

          <View style={styles.devSubLinks}>
            <Button
              label="Owner Setup"
              variant="outline"
              size="sm"
              onPress={() => router.push('/owner/setup')}
            />
            <Button
              label="Worker Join"
              variant="outline"
              size="sm"
              onPress={() => router.push('/worker/join')}
            />
          </View>

          {/* Temporary Supabase Diagnostic Section */}
          {__DEV__ && (
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
          )}
        </Card>
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
  formCard: {
    padding: Spacing.base,
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
