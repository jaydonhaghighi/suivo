import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import * as Linking from 'expo-linking';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Card } from '../components/card';
import { apiGet, apiPost } from '../lib/api';
import { spacing } from '../lib/theme';
import { TabThemeColors, useTabTheme } from '../lib/tab-theme';

type Provider = 'gmail' | 'outlook';

interface MailboxConnection {
  id: string;
  provider: Provider;
  email_address: string;
  mailbox_type: 'primary' | 'shared' | 'delegated';
  status: 'active' | 'paused' | 'error' | 'revoked';
  created_at: string;
}

function normalizeParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function formatProvider(provider: Provider): string {
  return provider === 'gmail' ? 'Gmail' : 'Outlook';
}

function isProvider(value: string | undefined): value is Provider {
  return value === 'gmail' || value === 'outlook';
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Unknown';
  }

  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

export default function MailboxesScreen(): JSX.Element {
  const { colors, mode } = useTabTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{
    connected?: string;
    provider?: Provider;
    mailbox_connection_id?: string;
  }>();
  const connected = normalizeParam(params.connected) === 'true';
  const connectedProviderParam = normalizeParam(params.provider);
  const connectedProvider = isProvider(connectedProviderParam) ? connectedProviderParam : undefined;
  const [loginHint, setLoginHint] = useState('');
  const [gmailDebugOutput, setGmailDebugOutput] = useState<string>('');
  const [gmailDebugMailboxId, setGmailDebugMailboxId] = useState<string | null>(null);

  useEffect(() => {
    if (connected) {
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
    }
  }, [connected, queryClient]);

  const mailboxes = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => apiGet<MailboxConnection[]>('/mailboxes')
  });

  const connectMutation = useMutation({
    mutationFn: async (provider: Provider) =>
      apiPost<{ url: string; state: string }>(`/mailboxes/oauth/${provider}/start`, {
        app_redirect_uri: Linking.createURL('/mailboxes'),
        login_hint: loginHint.trim() || undefined
      }),
    onSuccess: async (data) => {
      await Linking.openURL(data.url);
    }
  });

  const backfillMutation = useMutation({
    mutationFn: (mailboxId: string) => apiPost(`/mailboxes/${mailboxId}/backfill`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mailboxes'] })
  });

  const testGmailMutation = useMutation({
    mutationFn: (mailboxId: string) =>
      apiPost<Record<string, unknown>>(`/mailboxes/${mailboxId}/gmail/test-last-hour`, {}),
    onSuccess: (data, mailboxId) => {
      setGmailDebugMailboxId(mailboxId);
      setGmailDebugOutput(JSON.stringify(data, null, 2));
    }
  });

  const mailboxErrorMessage = mailboxes.error instanceof Error ? mailboxes.error.message : null;
  const connectErrorMessage = connectMutation.error instanceof Error ? connectMutation.error.message : null;
  const backfillErrorMessage = backfillMutation.error instanceof Error ? backfillMutation.error.message : null;
  const gmailTestErrorMessage = testGmailMutation.error instanceof Error ? testGmailMutation.error.message : null;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Mailbox Connections</Text>
      <Text style={styles.subtitle}>Connect Gmail or Outlook to sync inbound/outbound email threads.</Text>

      {connected ? (
        <Card tone={mode}>
          <Text style={styles.successTitle}>Mailbox connected</Text>
          <Text style={styles.successBody}>
            {connectedProvider ? `${formatProvider(connectedProvider)} was connected successfully.` : 'Mailbox connected successfully.'}
          </Text>
        </Card>
      ) : null}

      <Card tone={mode}>
        <Text style={styles.sectionTitle}>Connect Inbox</Text>
        <Text style={styles.label}>Email (optional)</Text>
        <TextInput
          value={loginHint}
          onChangeText={setLoginHint}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          placeholder="name@domain.com"
          placeholderTextColor={colors.textSecondary}
        />
        <Text style={styles.helperText}>Used as an account hint in Google/Microsoft sign-in.</Text>
        <View style={styles.buttonRow}>
          <Pressable
            style={[styles.connectButton, styles.gmailButton, connectMutation.isPending ? styles.disabled : null]}
            onPress={() => connectMutation.mutate('gmail')}
            disabled={connectMutation.isPending}
          >
            <Text style={styles.connectButtonText}>Connect Gmail</Text>
          </Pressable>
          <Pressable
            style={[styles.connectButton, styles.outlookButton, connectMutation.isPending ? styles.disabled : null]}
            onPress={() => connectMutation.mutate('outlook')}
            disabled={connectMutation.isPending}
          >
            <Text style={styles.connectButtonText}>Connect Outlook</Text>
          </Pressable>
        </View>
      </Card>

      <Card tone={mode}>
        <Text style={styles.sectionTitle}>Connected Mailboxes</Text>
        {mailboxes.isLoading ? <Text style={styles.meta}>Loading mailboxes...</Text> : null}
        {mailboxes.error ? (
          <Text style={styles.error}>Unable to load mailboxes{mailboxErrorMessage ? ` (${mailboxErrorMessage})` : ''}</Text>
        ) : null}

        {mailboxes.data?.map((mailbox) => (
          <View key={mailbox.id} style={styles.mailboxRow}>
            <View style={styles.mailboxDetails}>
              <Text style={styles.mailboxPrimary}>{formatProvider(mailbox.provider)} · {mailbox.email_address}</Text>
              <Text style={styles.meta}>
                {mailbox.mailbox_type} · {mailbox.status} · connected {formatTimestamp(mailbox.created_at)}
              </Text>
            </View>

            <View style={styles.mailboxActions}>
              <Pressable
                style={[styles.backfillButton, backfillMutation.isPending ? styles.disabled : null]}
                onPress={() => backfillMutation.mutate(mailbox.id)}
                disabled={backfillMutation.isPending}
              >
                <Text style={styles.backfillButtonText}>Backfill</Text>
              </Pressable>

              {mailbox.provider === 'gmail' ? (
                <Pressable
                  style={[styles.testButton, testGmailMutation.isPending ? styles.disabled : null]}
                  onPress={() => testGmailMutation.mutate(mailbox.id)}
                  disabled={testGmailMutation.isPending}
                >
                  <Text style={styles.testButtonText}>Test Gmail</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ))}

        {!mailboxes.isLoading && !mailboxes.error && (mailboxes.data?.length ?? 0) === 0 ? (
          <Text style={styles.meta}>No connected mailboxes yet.</Text>
        ) : null}
      </Card>

      {connectErrorMessage ? <Text style={styles.error}>{connectErrorMessage}</Text> : null}
      {backfillErrorMessage ? <Text style={styles.error}>{backfillErrorMessage}</Text> : null}
      {gmailTestErrorMessage ? <Text style={styles.error}>{gmailTestErrorMessage}</Text> : null}
      {backfillMutation.isSuccess ? <Text style={styles.successBody}>Backfill job queued.</Text> : null}

      {gmailDebugOutput ? (
        <Card tone={mode}>
          <Text style={styles.sectionTitle}>Gmail API Result (Last Hour)</Text>
          {gmailDebugMailboxId ? <Text style={styles.meta}>Mailbox: {gmailDebugMailboxId}</Text> : null}
          <Text selectable style={styles.debugOutput}>
            {gmailDebugOutput}
          </Text>
        </Card>
      ) : null}
    </ScrollView>
  );
}

function createStyles(colors: TabThemeColors) {
  return StyleSheet.create({
    container: {
      padding: spacing.lg,
      paddingBottom: 120
    },
    heading: {
      color: colors.text,
      fontSize: 30,
      fontWeight: '800'
    },
    subtitle: {
      color: colors.textSecondary,
      marginTop: 4,
      marginBottom: spacing.md
    },
    sectionTitle: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '800',
      marginBottom: spacing.sm
    },
    label: {
      color: colors.textSecondary,
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      fontWeight: '700',
      marginBottom: 4
    },
    input: {
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 12,
      paddingVertical: 11,
      paddingHorizontal: 12,
      marginBottom: 6,
      backgroundColor: colors.surfaceMuted,
      color: colors.text
    },
    helperText: {
      color: colors.textSecondary,
      marginBottom: spacing.sm,
      fontSize: 12
    },
    buttonRow: {
      flexDirection: 'row',
      gap: spacing.sm
    },
    connectButton: {
      flex: 1,
      borderRadius: 12,
      paddingVertical: 12,
      alignItems: 'center'
    },
    gmailButton: {
      backgroundColor: '#1A73E8'
    },
    outlookButton: {
      backgroundColor: '#0067B8'
    },
    connectButtonText: {
      color: colors.white,
      fontWeight: '800'
    },
    mailboxRow: {
      borderTopColor: colors.border,
      borderTopWidth: 1,
      paddingTop: spacing.sm,
      marginTop: spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm
    },
    mailboxDetails: {
      flex: 1
    },
    mailboxActions: {
      gap: 8
    },
    mailboxPrimary: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '700'
    },
    meta: {
      color: colors.textSecondary,
      marginTop: 3,
      fontSize: 12
    },
    backfillButton: {
      backgroundColor: colors.surfaceMuted,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10
    },
    backfillButtonText: {
      color: colors.text,
      fontWeight: '700',
      fontSize: 12
    },
    testButton: {
      backgroundColor: '#188038',
      borderColor: '#188038',
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10
    },
    testButtonText: {
      color: colors.white,
      fontWeight: '700',
      fontSize: 12
    },
    disabled: {
      opacity: 0.6
    },
    error: {
      color: '#FF8A8A',
      marginTop: spacing.sm
    },
    successTitle: {
      color: colors.accent,
      fontSize: 16,
      fontWeight: '800'
    },
    successBody: {
      color: colors.textSecondary,
      marginTop: 4
    },
    debugOutput: {
      marginTop: spacing.sm,
      color: colors.text,
      fontSize: 12,
      lineHeight: 18
    }
  });
}
