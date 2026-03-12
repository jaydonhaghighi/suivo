import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '../../components/card';
import { apiGet } from '../../lib/api';
import { useCurrentUser } from '../../lib/current-user';
import { spacing } from '../../lib/theme';
import { TabThemeColors, useTabTheme } from '../../lib/tab-theme';

interface TaskCard {
  id: string;
  lead_id: string;
  due_at: string;
  lead_state: string;
  summary?: string;
  primary_email?: string;
  primary_phone?: string;
}

interface LeadRow {
  lead_id: string;
  lead_state: string;
  summary: string;
  primary_contact: string;
  next_due_at: string;
}

export default function LeadsScreen(): JSX.Element {
  const { colors, mode } = useTabTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [search, setSearch] = useState('');
  const currentUser = useCurrentUser();

  const tasks = useQuery({
    queryKey: ['task-deck', currentUser.data?.userId, currentUser.data?.teamId, currentUser.data?.role],
    queryFn: () => apiGet<TaskCard[]>('/task-deck')
  });

  const leads = useMemo<LeadRow[]>(() => {
    const map = new Map<string, LeadRow>();

    for (const task of tasks.data ?? []) {
      if (map.has(task.lead_id)) {
        continue;
      }

      map.set(task.lead_id, {
        lead_id: task.lead_id,
        lead_state: task.lead_state,
        summary: task.summary ?? 'No summary yet',
        primary_contact: task.primary_email ?? task.primary_phone ?? 'No contact',
        next_due_at: task.due_at
      });
    }

    return Array.from(map.values());
  }, [tasks.data]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) {
      return leads;
    }

    return leads.filter((lead) => {
      const haystack = `${lead.primary_contact} ${lead.summary} ${lead.lead_state}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [leads, search]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Leads</Text>
        <Text style={styles.subtitle}>Unified lead list with quick access into timeline context.</Text>

      <View style={styles.searchWrap}>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search by contact, summary, or state"
          placeholderTextColor={colors.textSecondary}
        />
      </View>

      {tasks.isLoading ? <Text style={styles.loading}>Loading leads...</Text> : null}
      {tasks.error ? <Text style={styles.error}>Unable to load leads.</Text> : null}

      {filtered.map((lead) => (
        <Card key={lead.lead_id} tone={mode}>
          <View style={styles.rowTop}>
            <Text style={styles.contact}>{lead.primary_contact}</Text>
            <Text style={styles.state}>{lead.lead_state}</Text>
          </View>
          <Text style={styles.summary}>{lead.summary}</Text>
          <Text style={styles.meta}>Next due {new Date(lead.next_due_at).toLocaleString()}</Text>

          <View style={styles.actions}>
            <Link href={{ pathname: '/lead/[id]', params: { id: lead.lead_id } }} style={styles.linkButton}>
              Open Timeline
            </Link>
            <Link href={{ pathname: '/compose', params: { lead_id: lead.lead_id } }} style={styles.secondaryLink}>
              Message
            </Link>
          </View>
        </Card>
      ))}

      {!tasks.isLoading && filtered.length === 0 ? <Text style={styles.empty}>No leads match your search.</Text> : null}

        <View style={styles.footerActions}>
          <Link href="/templates" style={styles.footerLink}>
            Templates
          </Link>
          <Link href="/rescue" style={styles.footerLink}>
            Rescue Queue
          </Link>
        </View>
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
    title: {
      color: colors.text,
      fontSize: 30,
      fontWeight: '800'
    },
    subtitle: {
      color: colors.textSecondary,
      marginTop: 4,
      marginBottom: spacing.md
    },
    searchWrap: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: spacing.md
    },
    searchInput: {
      color: colors.text,
      paddingHorizontal: spacing.md,
      paddingVertical: 12
    },
    loading: {
      color: colors.text,
      marginBottom: spacing.md
    },
    error: {
      color: '#FF8A8A',
      marginBottom: spacing.md
    },
    rowTop: {
      flexDirection: 'row',
      justifyContent: 'space-between'
    },
    contact: {
      color: colors.text,
      fontWeight: '800',
      fontSize: 14
    },
    state: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '700'
    },
    summary: {
      color: colors.text,
      marginTop: spacing.xs,
      lineHeight: 20
    },
    meta: {
      color: colors.textSecondary,
      marginTop: spacing.xs,
      fontSize: 12
    },
    actions: {
      marginTop: spacing.md,
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'center'
    },
    linkButton: {
      backgroundColor: colors.primary,
      color: colors.white,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 10,
      overflow: 'hidden',
      fontWeight: '700'
    },
    secondaryLink: {
      backgroundColor: colors.cardMuted,
      color: colors.text,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 10,
      overflow: 'hidden',
      fontWeight: '700'
    },
    empty: {
      color: colors.textSecondary,
      marginTop: spacing.sm
    },
    footerActions: {
      marginTop: spacing.lg,
      flexDirection: 'row',
      gap: spacing.sm
    },
    footerLink: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      overflow: 'hidden',
      fontWeight: '700'
    }
  });
}
