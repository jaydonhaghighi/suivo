import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '../../components/card';
import { apiGet } from '../../lib/api';
import { useCurrentUser } from '../../lib/current-user';
import { spacing } from '../../lib/theme';
import { TabThemeColors, useTabTheme } from '../../lib/tab-theme';

interface SystemMetrics {
  conversation_events_total: number;
  open_tasks_total: number;
  stale_leads_total: number;
}

interface TaskCard {
  id: string;
  lead_state: string;
}

function MetricBar({
  label,
  value,
  ratio,
  color,
  styles,
  trackColor
}: {
  label: string;
  value: number;
  ratio: number;
  color: string;
  styles: ReturnType<typeof createStyles>;
  trackColor: string;
}): JSX.Element {
  return (
    <View style={styles.metricRow}>
      <View style={styles.metricTop}>
        <Text style={styles.metricLabel}>{label}</Text>
        <Text style={styles.metricValue}>{value}</Text>
      </View>
      <View style={[styles.metricTrack, { backgroundColor: trackColor }]}>
        <View style={[styles.metricFill, { width: `${Math.max(6, Math.min(100, ratio * 100))}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

export default function MetricsScreen(): JSX.Element {
  const { colors, mode } = useTabTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const currentUser = useCurrentUser();
  const systemMetrics = useQuery({
    queryKey: ['health-metrics'],
    queryFn: () => apiGet<SystemMetrics>('/health/metrics')
  });

  const tasks = useQuery({
    queryKey: ['task-deck', currentUser.data?.userId, currentUser.data?.teamId, currentUser.data?.role],
    queryFn: () => apiGet<TaskCard[]>('/task-deck')
  });

  const deckStats = useMemo(() => {
    const all = tasks.data ?? [];
    const total = Math.max(1, all.length);
    const atRisk = all.filter((task) => task.lead_state === 'At-Risk').length;
    const stale = all.filter((task) => task.lead_state === 'Stale').length;
    return {
      total,
      atRisk,
      stale,
      atRiskRatio: atRisk / total,
      staleRatio: stale / total
    };
  }, [tasks.data]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Metrics</Text>
        <Text style={styles.subtitle}>Execution visibility across queue volume and lead risk levels.</Text>

      <Card tone={mode}>
        <Text style={styles.cardTitle}>System Health</Text>
        <MetricBar
          label="Conversation Events"
          value={systemMetrics.data?.conversation_events_total ?? 0}
          ratio={0.8}
          color={colors.primary}
          styles={styles}
          trackColor={colors.surfaceMuted}
        />
        <MetricBar
          label="Open Tasks"
          value={systemMetrics.data?.open_tasks_total ?? 0}
          ratio={0.6}
          color={colors.accent}
          styles={styles}
          trackColor={colors.surfaceMuted}
        />
        <MetricBar
          label="Stale Leads"
          value={systemMetrics.data?.stale_leads_total ?? 0}
          ratio={0.35}
          color={colors.warning}
          styles={styles}
          trackColor={colors.surfaceMuted}
        />
      </Card>

      <Card tone={mode}>
        <Text style={styles.cardTitle}>Task Deck Risk Mix</Text>
        <MetricBar
          label="At-Risk"
          value={deckStats.atRisk}
          ratio={deckStats.atRiskRatio}
          color={colors.warning}
          styles={styles}
          trackColor={colors.surfaceMuted}
        />
        <MetricBar
          label="Stale"
          value={deckStats.stale}
          ratio={deckStats.staleRatio}
          color={'#FF7A7A'}
          styles={styles}
          trackColor={colors.surfaceMuted}
        />
        <MetricBar
          label="Total Visible"
          value={tasks.data?.length ?? 0}
          ratio={1}
          color={colors.primary}
          styles={styles}
          trackColor={colors.surfaceMuted}
        />
      </Card>

        {systemMetrics.isLoading || tasks.isLoading ? <Text style={styles.loading}>Refreshing metrics...</Text> : null}
        {systemMetrics.error || tasks.error ? <Text style={styles.error}>Unable to load one or more metrics.</Text> : null}
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
    cardTitle: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '800',
      marginBottom: spacing.sm
    },
    metricRow: {
      marginBottom: spacing.md
    },
    metricTop: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: spacing.xs
    },
    metricLabel: {
      color: colors.textSecondary,
      fontWeight: '700'
    },
    metricValue: {
      color: colors.text,
      fontWeight: '800'
    },
    metricTrack: {
      height: 10,
      borderRadius: 999,
      backgroundColor: colors.surfaceMuted,
      overflow: 'hidden'
    },
    metricFill: {
      height: 10,
      borderRadius: 999
    },
    loading: {
      color: colors.text
    },
    error: {
      color: '#FF8A8A'
    }
  });
}
