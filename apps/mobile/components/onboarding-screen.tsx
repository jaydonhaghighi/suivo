import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClerk } from '@clerk/clerk-expo';
import { useQueryClient } from '@tanstack/react-query';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { apiGet, apiPost } from '../lib/api';
import { OnboardingSeed, SignupRole } from '../lib/onboarding';
import { TabThemeColors, useTabTheme } from '../lib/tab-theme';

interface TeamJoinCodeResponse {
  team_code: string;
  generated_at: string;
}

interface OnboardingRegisterResponse {
  user_id: string;
  team_id: string;
  role: SignupRole;
  onboarding_completed: true;
}

interface Props {
  initialSeed?: OnboardingSeed | null;
  onCompleted: () => void;
}

function normalizeTeamCode(value: string): string {
  return value.replace(/[\s-]+/g, '').toUpperCase();
}

export function OnboardingScreen({ initialSeed, onCompleted }: Props): JSX.Element {
  const { signOut } = useClerk();
  const { colors } = useTabTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const queryClient = useQueryClient();
  const autoSubmitAttempted = useRef(false);

  const [role, setRole] = useState<SignupRole>(initialSeed?.role ?? 'AGENT');
  const [teamCode, setTeamCode] = useState(initialSeed?.teamCode ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [joinCodeResult, setJoinCodeResult] = useState<TeamJoinCodeResponse | null>(null);

  const canSubmit = role === 'TEAM_LEAD' || normalizeTeamCode(teamCode).length > 0;

  const completeProvisioning = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['current-user'] });
    onCompleted();
  }, [onCompleted, queryClient]);

  const submit = useCallback(async () => {
    if (!canSubmit || loading) {
      return;
    }

    setError('');
    setLoading(true);

    try {
      const payload =
        role === 'TEAM_LEAD'
          ? { role: 'TEAM_LEAD' as const }
          : { role: 'AGENT' as const, team_code: normalizeTeamCode(teamCode) };

      const registerResult = await apiPost<OnboardingRegisterResponse>('/onboarding/register', payload);
      if (!registerResult.onboarding_completed) {
        setError('Onboarding did not complete. Please try again.');
        return;
      }

      if (role === 'TEAM_LEAD') {
        try {
          const joinCode = await apiGet<TeamJoinCodeResponse>('/team/join-code');
          setJoinCodeResult(joinCode);
          await queryClient.invalidateQueries({ queryKey: ['current-user'] });
        } catch (joinCodeError: unknown) {
          if (joinCodeError instanceof Error) {
            setError(`Team code fetch failed: ${joinCodeError.message}`);
          } else {
            setError('Team code fetch failed. Please try again.');
          }
        }
      } else {
        await completeProvisioning();
      }
    } catch (submitError: unknown) {
      if (submitError instanceof Error) {
        setError(`Registration failed: ${submitError.message}`);
      } else {
        setError('Registration failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [canSubmit, completeProvisioning, loading, queryClient, role, teamCode]);

  useEffect(() => {
    if (!initialSeed?.autoSubmit || autoSubmitAttempted.current) {
      return;
    }
    autoSubmitAttempted.current = true;
    void submit();
  }, [initialSeed?.autoSubmit, submit]);

  if (joinCodeResult) {
    return (
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.container}
        >
          <View style={styles.header}>
            <Text style={styles.title}>Team Created</Text>
            <Text style={styles.subtitle}>Share this code with agents so they can join your team.</Text>
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>Team Join Code</Text>
            <Text selectable style={styles.codeValue}>
              {joinCodeResult.team_code}
            </Text>
            <Text style={styles.note}>Press and hold the code to copy.</Text>
          </View>

          <Pressable style={styles.button} onPress={completeProvisioning}>
            <Text style={styles.buttonText}>Continue</Text>
          </Pressable>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Complete Onboarding</Text>
          <Text style={styles.subtitle}>Choose your role to finish account setup.</Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Role</Text>
          <View style={styles.roleSwitch}>
            <Pressable
              style={[styles.roleOption, role === 'AGENT' ? styles.roleOptionActive : null]}
              onPress={() => setRole('AGENT')}
              disabled={loading}
            >
              <Text style={[styles.roleOptionText, role === 'AGENT' ? styles.roleOptionTextActive : null]}>Agent</Text>
            </Pressable>
            <Pressable
              style={[styles.roleOption, role === 'TEAM_LEAD' ? styles.roleOptionActive : null]}
              onPress={() => setRole('TEAM_LEAD')}
              disabled={loading}
            >
              <Text style={[styles.roleOptionText, role === 'TEAM_LEAD' ? styles.roleOptionTextActive : null]}>Team Lead</Text>
            </Pressable>
          </View>

          {role === 'AGENT' ? (
            <>
              <Text style={styles.label}>Team Code</Text>
              <TextInput
                style={styles.input}
                value={teamCode}
                onChangeText={(value) => setTeamCode(normalizeTeamCode(value))}
                placeholder="Enter team code"
                placeholderTextColor={colors.tabInactive}
                autoCapitalize="characters"
              />
            </>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[styles.button, (!canSubmit || loading) && styles.buttonDisabled]}
            onPress={submit}
            disabled={!canSubmit || loading}
          >
            {loading ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.buttonText}>Finish Setup</Text>
            )}
          </Pressable>

          <View style={styles.secondaryActions}>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => void submit()}
              disabled={loading}
            >
              <Text style={styles.secondaryButtonText}>Retry</Text>
            </Pressable>

            <Pressable
              style={styles.secondaryButton}
              onPress={() => signOut()}
              disabled={loading}
            >
              <Text style={styles.secondaryButtonText}>Sign Out</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(colors: TabThemeColors) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: colors.background
    },
    container: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: 24
    },
    header: {
      marginBottom: 32
    },
    title: {
      color: colors.text,
      fontSize: 30,
      fontWeight: '800'
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 15,
      marginTop: 6
    },
    form: {
      gap: 8
    },
    label: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: 8
    },
    roleSwitch: {
      marginTop: 6,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 4,
      flexDirection: 'row',
      gap: 8
    },
    roleOption: {
      flex: 1,
      borderRadius: 8,
      paddingVertical: 12,
      alignItems: 'center'
    },
    roleOptionActive: {
      backgroundColor: colors.primary
    },
    roleOptionText: {
      color: colors.textSecondary,
      fontWeight: '700',
      fontSize: 14
    },
    roleOptionTextActive: {
      color: colors.white
    },
    input: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 14,
      fontSize: 16,
      color: colors.text
    },
    codeValue: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 16,
      color: colors.text,
      fontSize: 22,
      fontWeight: '800',
      letterSpacing: 1.2,
      textAlign: 'center'
    },
    note: {
      color: colors.textSecondary,
      fontSize: 13
    },
    error: {
      color: '#FF6B6B',
      fontSize: 13,
      marginTop: 4
    },
    button: {
      backgroundColor: colors.primary,
      borderRadius: 12,
      paddingVertical: 16,
      alignItems: 'center',
      marginTop: 16
    },
    buttonDisabled: {
      opacity: 0.5
    },
    buttonText: {
      color: colors.white,
      fontSize: 16,
      fontWeight: '700'
    },
    secondaryActions: {
      flexDirection: 'row',
      gap: 10,
      marginTop: 10
    },
    secondaryButton: {
      flex: 1,
      borderRadius: 12,
      paddingVertical: 12,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface
    },
    secondaryButtonText: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '700'
    }
  });
}
