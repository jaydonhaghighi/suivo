import { useClerk, useUser } from '@clerk/clerk-expo';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '../../components/card';
import { apiGet } from '../../lib/api';
import { useCurrentUser } from '../../lib/current-user';
import { spacing } from '../../lib/theme';
import { TabThemeColors, useTabTheme } from '../../lib/tab-theme';

type TeamJoinCodeResponse = {
  team_code: string;
  generated_at: string;
};

export default function ProfileScreen(): JSX.Element {
  const { colors, mode, setMode } = useTabTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user } = useUser();
  const { signOut } = useClerk();
  const currentUser = useCurrentUser();
  const isTeamLead = currentUser.effectiveRole === 'TEAM_LEAD';
  const teamJoinCode = useQuery({
    queryKey: ['team-join-code'],
    queryFn: () => apiGet<TeamJoinCodeResponse>('/team/join-code'),
    enabled: isTeamLead
  });

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.hero}>
          <Text style={styles.heroTitle}>Profile</Text>
          <Text style={styles.heroSubtitle}>Preferences, shortcuts, and communication tools.</Text>
        </View>

      <Card tone={mode}>
        <Text style={styles.sectionTitle}>Appearance</Text>
        <Text style={styles.rowLabel}>Theme</Text>
        <View style={styles.modeSwitch}>
          <Pressable
            style={[styles.modeOption, mode === 'dark' ? styles.modeOptionActive : null]}
            onPress={() => setMode('dark')}
          >
            <Text style={[styles.modeLabel, mode === 'dark' ? styles.modeLabelActive : null]}>Dark</Text>
          </Pressable>
          <Pressable
            style={[styles.modeOption, mode === 'light' ? styles.modeOptionActive : null]}
            onPress={() => setMode('light')}
          >
            <Text style={[styles.modeLabel, mode === 'light' ? styles.modeLabelActive : null]}>Light</Text>
          </Pressable>
        </View>
      </Card>

      <Card tone={mode}>
        <Text style={styles.sectionTitle}>Account</Text>
        <Text style={styles.rowLabel}>Email</Text>
        <Text style={styles.rowValue}>{user?.primaryEmailAddress?.emailAddress ?? '—'}</Text>

        <Text style={styles.rowLabel}>Name</Text>
        <Text style={styles.rowValue}>
          {[user?.firstName, user?.lastName].filter(Boolean).join(' ') || '—'}
        </Text>

        <Text style={styles.rowLabel}>User ID</Text>
        <Text style={styles.code}>{user?.id ?? '—'}</Text>

        <Text style={styles.rowLabel}>API User ID</Text>
        <Text selectable style={styles.code}>{currentUser.data?.userId ?? '—'}</Text>

        <Text style={styles.rowLabel}>API Team ID</Text>
        <Text selectable style={styles.code}>{currentUser.data?.teamId ?? '—'}</Text>

        <Text style={styles.rowLabel}>API Role</Text>
        <Text style={styles.rowValue}>{currentUser.data?.role ?? currentUser.effectiveRole ?? '—'}</Text>

        {isTeamLead ? (
          <>
            <Text style={styles.rowLabel}>Team Join Code</Text>
            {teamJoinCode.isLoading ? (
              <Text style={styles.rowValue}>Loading…</Text>
            ) : teamJoinCode.error instanceof Error ? (
              <Text style={styles.rowValue}>Unavailable ({teamJoinCode.error.message})</Text>
            ) : (
              <Text selectable style={styles.joinCode}>
                {teamJoinCode.data?.team_code ?? '—'}
              </Text>
            )}

            <Text style={styles.rowLabel}>Code Generated</Text>
            <Text style={styles.rowValue}>
              {teamJoinCode.data?.generated_at
                ? new Date(teamJoinCode.data.generated_at).toLocaleString()
                : '—'}
            </Text>
          </>
        ) : null}
      </Card>

      <Card tone={mode}>
        <Text style={styles.sectionTitle}>Quick Actions</Text>
        <View style={styles.actionGrid}>
          <Link href="/templates" style={styles.actionLink}>
            Templates
          </Link>
          {isTeamLead ? (
            <Link href="/admin-hub" style={styles.actionLink}>
              Admin
            </Link>
          ) : null}
          <Link href="/compose" style={styles.actionLink}>
            Compose
          </Link>
          <Link href="/call-outcome" style={styles.actionLink}>
            Call Outcome
          </Link>
          <Link href="/rescue" style={styles.actionLink}>
            Rescue
          </Link>
          <Link href="/mailboxes" style={styles.actionLink}>
            Mailboxes
          </Link>
          <Link href="/settings" style={styles.actionLink}>
            Settings
          </Link>
        </View>
      </Card>

        <Link href="/mailboxes" style={styles.cta}>
          <Text style={styles.ctaText}>Sync Mailboxes</Text>
        </Link>

        <Pressable style={styles.signOut} onPress={() => signOut()}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(colors: TabThemeColors) {
  return StyleSheet.create({
    container: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: 120
    },
    safeArea: {
      flex: 1,
      backgroundColor: colors.background
    },
    hero: {
      marginBottom: spacing.md
    },
    heroTitle: {
      color: colors.text,
      fontSize: 30,
      fontWeight: '800'
    },
    heroSubtitle: {
      color: colors.textSecondary,
      marginTop: 4
    },
    sectionTitle: {
      color: colors.text,
      fontWeight: '800',
      fontSize: 16,
      marginBottom: spacing.sm
    },
    rowLabel: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '700',
      marginTop: spacing.sm
    },
    rowValue: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '700'
    },
    code: {
      color: colors.textSecondary,
      fontFamily: 'Courier',
      fontSize: 12,
      marginTop: 2
    },
    joinCode: {
      color: colors.text,
      fontFamily: 'Courier',
      fontSize: 20,
      fontWeight: '800',
      letterSpacing: 1.2,
      marginTop: 2
    },
    modeSwitch: {
      marginTop: spacing.xs,
      backgroundColor: colors.surfaceMuted,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 4,
      flexDirection: 'row',
      gap: 6
    },
    modeOption: {
      flex: 1,
      borderRadius: 8,
      paddingVertical: 10,
      alignItems: 'center'
    },
    modeOptionActive: {
      backgroundColor: colors.primary
    },
    modeLabel: {
      color: colors.textSecondary,
      fontWeight: '700'
    },
    modeLabelActive: {
      color: colors.white
    },
    actionGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm
    },
    actionLink: {
      backgroundColor: colors.cardMuted,
      color: colors.text,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 10,
      overflow: 'hidden',
      fontWeight: '700'
    },
    cta: {
      marginTop: spacing.md,
      backgroundColor: colors.primary,
      borderRadius: 14,
      alignItems: 'center',
      paddingVertical: 14,
      overflow: 'hidden'
    },
    ctaText: {
      color: colors.white,
      fontWeight: '800'
    },
    signOut: {
      marginTop: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      alignItems: 'center',
      paddingVertical: 14
    },
    signOutText: {
      color: '#FF6B6B',
      fontWeight: '700'
    }
  });
}
