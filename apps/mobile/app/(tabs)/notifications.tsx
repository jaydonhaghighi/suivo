import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { apiGet, apiPost } from '../../lib/api';
import { useCurrentUser } from '../../lib/current-user';
import { spacing } from '../../lib/theme';
import { TabThemeColors, useTabTheme } from '../../lib/tab-theme';

type NotificationCategory = 'lead' | 'message' | 'call' | 'task' | 'note' | 'system';
type FeatherName = React.ComponentProps<typeof Feather>['name'];

interface NotificationFeedItem {
  id: string;
  lead_id: string | null;
  source_entity: 'lead' | 'conversation_event' | 'task';
  source_type: string;
  notification_type: string;
  category: NotificationCategory;
  title: string;
  body: string;
  ui_label: string;
  route_path: '/lead/[id]' | '/task-deck';
  channel: string | null;
  direction: string | null;
  created_at: string;
  due_at: string | null;
  lead_state: string | null;
  lead_source: string | null;
  primary_contact: string;
  primary_email: string | null;
  primary_phone: string | null;
  summary: string | null;
  read_at: string | null;
  is_read: boolean;
  attributes: Record<string, unknown>;
}

interface TaskDeckFallbackItem {
  id: string;
  lead_id: string;
  due_at: string;
  type: string;
  lead_state: string;
  summary?: string;
  primary_email?: string;
  primary_phone?: string;
}

interface NotificationSection {
  key: string;
  label: string;
  items: NotificationFeedItem[];
}

let notificationsEndpointAvailable: boolean | null = null;

function parseDate(value: string): Date | null {
  const raw = value.trim();
  if (!raw) {
    return null;
  }

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  // Normalize common Postgres timestamp formats like "2026-03-11 16:18:53+00".
  const normalized = raw
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00');

  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized)) {
    const asUtc = new Date(`${normalized}Z`);
    if (!Number.isNaN(asUtc.getTime())) {
      return asUtc;
    }
  }
  return null;
}

function itemDate(item: NotificationFeedItem): Date | null {
  const created = parseDate(item.created_at);
  if (created) {
    return created;
  }

  if (item.due_at) {
    return parseDate(item.due_at);
  }

  return null;
}

function dayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function sectionLabel(value: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayStart = new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diffDays = Math.floor((today - dayStart) / 86_400_000);

  if (diffDays === 0) {
    return `Today · ${value.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'long',
      day: 'numeric'
    })}`;
  }
  if (diffDays === 1) {
    return `Yesterday · ${value.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'long',
      day: 'numeric'
    })}`;
  }

  return value.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });
}

function buildSections(items: NotificationFeedItem[]): NotificationSection[] {
  const sorted = [...items].sort((a, b) => {
    const aTime = itemDate(a)?.getTime() ?? 0;
    const bTime = itemDate(b)?.getTime() ?? 0;
    return bTime - aTime;
  });

  const grouped = new Map<string, NotificationSection>();
  for (const item of sorted) {
    const parsed = itemDate(item) ?? new Date();
    const key = dayKey(parsed);
    const current = grouped.get(key);
    if (current) {
      current.items.push(item);
      continue;
    }

    grouped.set(key, {
      key,
      label: sectionLabel(parsed),
      items: [item]
    });
  }

  return Array.from(grouped.values());
}

function formatItemDateTime(item: NotificationFeedItem): string {
  const parsed = itemDate(item);
  if (!parsed) {
    return 'Unknown';
  }

  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function humanize(value: string): string {
  return value
    .replace(/[_-]/g, ' ')
    .split(' ')
    .filter((token) => token.length > 0)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function primaryContactFromTask(task: TaskDeckFallbackItem): string {
  if (task.primary_email && task.primary_email.trim().length > 0) {
    return task.primary_email;
  }
  if (task.primary_phone && task.primary_phone.trim().length > 0) {
    return task.primary_phone;
  }
  return 'Lead';
}

function isNotificationsRouteMissing(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('404')
    && message.includes('/v1/notifications')
    && message.includes('cannot get')
  );
}

function mapTaskDeckAsNotifications(tasks: TaskDeckFallbackItem[]): NotificationFeedItem[] {
  return tasks.map((task) => {
    const primaryContact = primaryContactFromTask(task);
    const title = `${humanize(task.type)} reminder`;
    const summary = task.summary?.trim() || null;
    const body = summary ?? `Reach out to ${primaryContact}`;

    return {
      id: `task:${task.id}`,
      lead_id: task.lead_id,
      source_entity: 'task',
      source_type: task.type,
      notification_type: task.type,
      category: 'task',
      title,
      body,
      ui_label: `${primaryContact} - ${title}`,
      route_path: '/task-deck',
      channel: 'task',
      direction: 'internal',
      created_at: task.due_at,
      due_at: task.due_at,
      lead_state: task.lead_state ?? null,
      lead_source: null,
      primary_contact: primaryContact,
      primary_email: task.primary_email ?? null,
      primary_phone: task.primary_phone ?? null,
      summary,
      read_at: null,
      is_read: false,
      attributes: {
        task_id: task.id,
        lead_id: task.lead_id,
        source_entity: 'task',
        source_type: task.type,
        notification_type: task.type,
        category: 'task',
        lead_state: task.lead_state,
        due_at: task.due_at,
        primary_email: task.primary_email ?? null,
        primary_phone: task.primary_phone ?? null,
        summary
      }
    };
  });
}

async function fetchNotificationsWithFallback(limit: number): Promise<NotificationFeedItem[]> {
  if (notificationsEndpointAvailable === false) {
    const tasks = await apiGet<TaskDeckFallbackItem[]>(`/task-deck?limit=${limit}`);
    return mapTaskDeckAsNotifications(tasks);
  }

  try {
    const feed = await apiGet<NotificationFeedItem[]>(`/notifications?limit=${limit}`);
    notificationsEndpointAvailable = true;
    return feed;
  } catch (error) {
    if (!isNotificationsRouteMissing(error)) {
      throw error;
    }

    notificationsEndpointAvailable = false;
    const tasks = await apiGet<TaskDeckFallbackItem[]>(`/task-deck?limit=${limit}`);
    return mapTaskDeckAsNotifications(tasks);
  }
}

function metadataLabel(item: NotificationFeedItem): string | null {
  const parts = [
    item.lead_state,
    item.lead_source ? humanize(item.lead_source) : null,
    item.channel ? humanize(item.channel) : null
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(' · ') : null;
}

function iconName(item: NotificationFeedItem): FeatherName {
  if (item.notification_type === 'lead_created' || item.notification_type === 'lead_assigned') {
    return 'user-plus';
  }
  if (item.notification_type === 'lead_stale' || item.notification_type === 'lead_at_risk') {
    return 'clock';
  }
  if (item.notification_type === 'inbound_message') {
    return 'message-circle';
  }
  if (item.notification_type === 'outbound_message') {
    return 'send';
  }
  if (item.notification_type === 'missed_call') {
    return 'phone-missed';
  }
  if (item.notification_type === 'call_logged') {
    return 'phone-call';
  }
  if (item.notification_type === 'note_added') {
    return 'file-text';
  }
  if (item.source_entity === 'task') {
    return 'check-square';
  }
  if (item.category === 'message') {
    return 'message-square';
  }
  return 'bell';
}

function iconColors(colors: TabThemeColors, item: NotificationFeedItem): { bg: string; fg: string } {
  if (item.category === 'lead') {
    return { bg: colors.primary + '22', fg: colors.primary };
  }
  if (item.category === 'message') {
    return { bg: colors.accent + '22', fg: colors.accent };
  }
  if (item.category === 'call') {
    return { bg: '#FF8A8A22', fg: '#FF8A8A' };
  }
  if (item.category === 'task') {
    return { bg: colors.warning + '22', fg: colors.warning };
  }
  if (item.category === 'note') {
    return { bg: colors.textSecondary + '26', fg: colors.textSecondary };
  }
  return { bg: colors.surfaceMuted, fg: colors.textSecondary };
}

function isUnread(item: NotificationFeedItem): boolean {
  return !item.is_read;
}

export default function NotificationsScreen(): JSX.Element {
  const { colors, mode } = useTabTheme();
  const styles = useMemo(() => createStyles(colors, mode), [colors, mode]);
  const router = useRouter();
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const notificationsKey = [
    'notifications',
    currentUser.data?.userId ?? 'unknown-user',
    currentUser.data?.teamId ?? 'unknown-team',
    currentUser.effectiveRole ?? 'unknown-role'
  ] as const;

  const feed = useQuery({
    queryKey: notificationsKey,
    queryFn: () => fetchNotificationsWithFallback(80),
    enabled: !currentUser.isUnprovisioned,
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    refetchOnReconnect: true,
    retry: 3
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => apiPost<{ id: string; read_at: string; is_read: true }>(`/notifications/${encodeURIComponent(id)}/read`, {}),
    onSuccess: (result) => {
      queryClient.setQueryData<NotificationFeedItem[]>(notificationsKey, (previous) =>
        (previous ?? []).map((item) =>
          item.id === result.id
            ? { ...item, read_at: result.read_at, is_read: true }
            : item
        )
      );
    }
  });

  const markAllReadMutation = useMutation({
    mutationFn: (ids: string[]) => apiPost<{ updated: number; read_at: string }>('/notifications/read-all', { ids }),
    onSuccess: (result, ids) => {
      const idSet = new Set(ids);
      queryClient.setQueryData<NotificationFeedItem[]>(notificationsKey, (previous) =>
        (previous ?? []).map((item) =>
          idSet.has(item.id)
            ? { ...item, read_at: result.read_at, is_read: true }
            : item
        )
      );
    }
  });

  const sections = useMemo(() => buildSections(feed.data ?? []), [feed.data]);
  const unreadIds = useMemo(
    () => (feed.data ?? []).filter((item) => isUnread(item)).map((item) => item.id),
    [feed.data]
  );
  const unreadCount = useMemo(
    () => unreadIds.length,
    [unreadIds]
  );

  const errorMessage = feed.error instanceof Error ? feed.error.message : null;

  function openNotification(item: NotificationFeedItem): void {
    if (notificationsEndpointAvailable !== false && isUnread(item)) {
      markReadMutation.mutate(item.id);
    }

    if (item.route_path === '/task-deck') {
      router.push('/task-deck');
      return;
    }

    if (item.lead_id) {
      router.push({ pathname: '/lead/[id]', params: { id: item.lead_id } });
      return;
    }

    router.push('/leads');
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Alerts</Text>
          <Pressable
            onPress={() => {
              if (notificationsEndpointAvailable === false) {
                return;
              }
              markAllReadMutation.mutate(unreadIds);
            }}
            disabled={unreadIds.length === 0 || markAllReadMutation.isPending || notificationsEndpointAvailable === false}
            style={({ pressed }) => [styles.markAllBtn, pressed && styles.markAllBtnPressed]}
          >
            <Text style={styles.markAllText}>Mark all as read</Text>
          </Pressable>
        </View>

        {unreadCount > 0 ? (
          <View style={styles.unreadPill}>
            <Text style={styles.unreadPillText}>{unreadCount} unread</Text>
          </View>
        ) : null}

        {feed.isLoading ? (
          <View style={styles.statusCard}>
            <Text style={styles.statusText}>Loading notifications...</Text>
          </View>
        ) : null}

        {errorMessage ? (
          <View style={styles.statusCard}>
            <Text style={styles.errorText}>Unable to load notifications ({errorMessage})</Text>
          </View>
        ) : null}

        {!feed.isLoading && !errorMessage && sections.length === 0 ? (
          <View style={styles.statusCard}>
            <Text style={styles.statusText}>No notifications yet.</Text>
          </View>
        ) : null}

        {sections.map((section) => (
          <View key={section.key} style={styles.sectionWrap}>
            <Text style={styles.sectionTitle}>{section.label}</Text>
            <View style={styles.sectionCard}>
              {section.items.map((item, index) => {
                const icon = iconName(item);
                const iconPalette = iconColors(colors, item);
                const showUnread = isUnread(item);

                return (
                  <Pressable
                    key={item.id}
                    style={({ pressed }) => [
                      styles.row,
                      index < section.items.length - 1 && styles.rowBorder,
                      pressed && styles.rowPressed
                    ]}
                    onPress={() => openNotification(item)}
                  >
                    <View style={[styles.iconWrap, { backgroundColor: iconPalette.bg }]}>
                      <Feather name={icon} size={15} color={iconPalette.fg} />
                    </View>

                    <View style={styles.rowBody}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {item.title}
                      </Text>
                      <Text style={styles.rowText} numberOfLines={2}>
                        {item.body || humanize(item.source_type)}
                      </Text>
                      {metadataLabel(item) ? (
                        <Text style={styles.rowMetaText} numberOfLines={1}>
                          {metadataLabel(item)}
                        </Text>
                      ) : null}
                    </View>

                    <View style={styles.rowMeta}>
                      <Text style={styles.timeText}>{formatItemDateTime(item)}</Text>
                      {showUnread ? <View style={styles.unreadDot} /> : <View style={styles.unreadDotSpacer} />}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}

        <View style={{ height: 50 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(colors: TabThemeColors, mode: 'dark' | 'light') {
  const cardBg = mode === 'dark' ? '#10192D' : colors.surface;
  const cardBorder = mode === 'dark' ? '#253B5E' : colors.border;

  return StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: colors.background
    },
    container: {
      paddingHorizontal: spacing.lg,
      paddingBottom: 120,
      paddingTop: spacing.md
    },
    headerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: spacing.sm
    },
    title: {
      color: colors.text,
      fontSize: 34,
      fontWeight: '800',
      letterSpacing: 0.2
    },
    markAllBtn: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: colors.surface + 'D0'
    },
    markAllBtnPressed: {
      opacity: 0.85
    },
    markAllText: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '700'
    },
    unreadPill: {
      marginTop: spacing.sm,
      alignSelf: 'flex-start',
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.primary + '55',
      backgroundColor: colors.primary + '22',
      paddingHorizontal: 10,
      paddingVertical: 5
    },
    unreadPillText: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: '700'
    },
    statusCard: {
      marginTop: spacing.md,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      padding: spacing.md
    },
    statusText: {
      color: colors.textSecondary
    },
    errorText: {
      color: '#FF8A8A'
    },
    sectionWrap: {
      marginTop: spacing.lg
    },
    sectionTitle: {
      color: colors.textSecondary,
      fontSize: 31,
      fontWeight: '600',
      marginBottom: spacing.sm
    },
    sectionCard: {
      borderRadius: 22,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: cardBg,
      overflow: 'hidden'
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: 14,
      paddingVertical: 12
    },
    rowPressed: {
      backgroundColor: colors.surfaceMuted + (mode === 'dark' ? 'B0' : '80')
    },
    rowBorder: {
      borderBottomWidth: 1,
      borderBottomColor: cardBorder
    },
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: 36,
      alignItems: 'center',
      justifyContent: 'center'
    },
    rowBody: {
      flex: 1,
      minWidth: 0
    },
    rowTitle: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '700'
    },
    rowText: {
      color: colors.textSecondary,
      fontSize: 15,
      marginTop: 2,
      lineHeight: 18
    },
    rowMetaText: {
      color: colors.textSecondary,
      fontSize: 12,
      marginTop: 4
    },
    rowMeta: {
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      minHeight: 34
    },
    timeText: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: '600'
    },
    unreadDot: {
      width: 7,
      height: 7,
      borderRadius: 7,
      backgroundColor: colors.primary
    },
    unreadDotSpacer: {
      width: 7,
      height: 7
    }
  });
}
