import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUser } from '@clerk/clerk-expo';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import {
  Alert,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  LayoutAnimation,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { apiGet, apiPost } from '../../lib/api';
import { useCurrentUser } from '../../lib/current-user';
import { spacing } from '../../lib/theme';
import { TabThemeColors, useTabTheme } from '../../lib/tab-theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface TaskCard {
  id: string;
  lead_id: string;
  due_at: string;
  mailbox_email_sent_at?: string;
  type: string;
  lead_state: string;
  summary?: string;
  primary_email?: string;
  primary_phone?: string;
}

interface CompletedDeckTask {
  task: TaskCard;
  completedAt: string;
}

type SnoozeMode = 'today' | 'tomorrow' | 'next_week';
type DeckTab = 'today' | 'upcoming' | 'completed';
type ContactAction = 'call' | 'email' | 'sms';
type FeatherName = React.ComponentProps<typeof Feather>['name'];

const SWIPE_THRESHOLD = 120;
const SWIPE_OUT_DISTANCE = 400;
const MAX_ROTATION = 5;

const DECK_TABS: Array<{ key: DeckTab; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'completed', label: 'Completed' }
];

const SNOOZE_OPTIONS: Array<{ key: SnoozeMode; label: string }> = [
  { key: 'today', label: 'Later today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'next_week', label: 'Next week' }
];

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

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

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function toTitleCase(token: string): string {
  if (!token) {
    return token;
  }
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

function formatTaskType(value: string): string {
  return value
    .split('_')
    .map((word) => toTitleCase(word))
    .join(' ');
}

function getPrimaryContact(task: TaskCard): string {
  return task.primary_email ?? task.primary_phone ?? 'No contact';
}

function formatContactName(contact: string): string {
  if (!contact.includes('@')) {
    return contact;
  }

  const [localPart] = contact.split('@');
  const words = localPart
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return contact;
  }

  return words.map((word) => toTitleCase(word)).join(' ');
}

function formatRelativeTime(value: string | undefined): string {
  const parsed = parseDate(value);
  if (!parsed) {
    return 'Unknown';
  }

  const now = new Date();
  const diffMs = now.getTime() - parsed.getTime();
  const absDiff = Math.abs(diffMs);

  if (absDiff < 2 * 60_000) {
    return 'Just now';
  }

  if (absDiff < 60 * 60_000) {
    return `${Math.max(1, Math.round(absDiff / 60_000))} min ago`;
  }

  const nowDay = startOfLocalDay(now).getTime();
  const parsedDay = startOfLocalDay(parsed).getTime();
  const dayDiff = Math.round((nowDay - parsedDay) / 86_400_000);

  if (dayDiff === 0) {
    return parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (dayDiff === 1) {
    return 'Yesterday';
  }
  if (dayDiff > 1 && dayDiff < 7) {
    return parsed.toLocaleDateString(undefined, { weekday: 'short' });
  }

  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatCardTimeLabel(task: TaskCard, completedAt?: string): string {
  if (completedAt) {
    return `Done ${formatRelativeTime(completedAt)}`;
  }

  if (task.mailbox_email_sent_at) {
    return formatRelativeTime(task.mailbox_email_sent_at);
  }

  return formatRelativeTime(task.due_at);
}

function stateChip(task: TaskCard): { label: string; icon: FeatherName; tint: string } {
  if (task.lead_state === 'At-Risk') {
    return { label: 'At risk', icon: 'alert-triangle', tint: '#E2CEA0' };
  }
  if (task.lead_state === 'Stale') {
    return { label: 'Attention', icon: 'eye', tint: '#DED4C2' };
  }

  const latestInbound = parseDate(task.mailbox_email_sent_at);
  if (latestInbound && Date.now() - latestInbound.getTime() <= 45 * 60_000) {
    return { label: 'New', icon: 'star', tint: '#EFF0F7' };
  }

  return { label: 'Active', icon: 'activity', tint: '#CDD8FF' };
}

function compactAiLine(value: string, options?: { maxWords?: number; maxChars?: number }): string {
  const maxWords = options?.maxWords ?? 8;
  const maxChars = options?.maxChars ?? 56;
  const cleaned = value
    .replace(/^wants:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return '';
  }

  const firstClause = cleaned.split(/[.!?]/)[0]?.trim() ?? cleaned;
  const words = firstClause.split(' ').filter(Boolean);
  const compacted = words.slice(0, maxWords).join(' ');
  const clipped = compacted.length > maxChars ? `${compacted.slice(0, maxChars - 1).trimEnd()}...` : compacted;
  return clipped;
}

function wantsLine(task: TaskCard): string {
  const summary = task.summary?.trim();
  if (summary) {
    const aiContext = compactAiLine(summary, { maxWords: 7, maxChars: 48 });
    if (aiContext) {
      return `Wants: ${aiContext}`;
    }
  }

  const type = task.type.toLowerCase();
  if (type.includes('email')) {
    return 'Wants: quick email response';
  }
  if (type.includes('call')) {
    return 'Wants: quick call update';
  }
  if (type.includes('sms') || type.includes('text') || type.includes('message')) {
    return 'Wants: short text follow-up';
  }
  return `Wants: ${compactAiLine(formatTaskType(task.type).toLowerCase(), { maxWords: 6, maxChars: 40 })}`;
}

function nextActionLine(task: TaskCard): string {
  const contactFirstName = formatContactName(getPrimaryContact(task)).split(' ')[0] || 'lead';
  const type = task.type.toLowerCase();

  if (type.includes('email')) {
    return `Email ${contactFirstName} with one clear next step.`;
  }
  if (type.includes('call')) {
    return `Call ${contactFirstName} and confirm timeline.`;
  }
  if (type.includes('sms') || type.includes('text') || type.includes('message')) {
    return `Text ${contactFirstName} a short follow-up.`;
  }

  const summary = task.summary?.trim();
  if (summary) {
    const compact = compactAiLine(summary, { maxWords: 10, maxChars: 78 });
    if (compact) {
      return compact;
    }
  }

  return `Follow up on ${formatTaskType(task.type).toLowerCase()}.`;
}

function dueTimeMs(task: TaskCard): number {
  return parseDate(task.due_at)?.getTime() ?? Number.MAX_SAFE_INTEGER;
}

function greetingLabel(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) {
    return 'Good morning';
  }
  if (hour < 18) {
    return 'Good afternoon';
  }
  return 'Good evening';
}

const reflow = () =>
  LayoutAnimation.configureNext({
    duration: 260,
    update: { type: LayoutAnimation.Types.easeInEaseOut },
    delete: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity }
  });

interface TaskSwipeCardProps {
  task: TaskCard;
  index: number;
  colors: TabThemeColors;
  mode: 'dark' | 'light';
  completedAt?: string;
  contactMenuOpen: boolean;
  snoozeMenuOpen: boolean;
  onDone: (task: TaskCard) => void;
  onSnooze: (task: TaskCard, mode: SnoozeMode) => void;
  onContactAction: (task: TaskCard, action: ContactAction) => void;
  onOpenLead: (task: TaskCard) => void;
  onOpenContactMenu: (task: TaskCard) => void;
  onOpenSnoozeMenu: (task: TaskCard) => void;
  onCloseMenus: () => void;
  onSwipeStart: () => void;
  onSwipeEnd: () => void;
}

function TaskSwipeCard({
  task,
  index,
  colors,
  mode,
  completedAt,
  contactMenuOpen,
  snoozeMenuOpen,
  onDone,
  onSnooze,
  onContactAction,
  onOpenLead,
  onOpenContactMenu,
  onOpenSnoozeMenu,
  onCloseMenus,
  onSwipeStart,
  onSwipeEnd
}: TaskSwipeCardProps) {
  const cs = useMemo(() => cardStyles(colors, mode), [colors, mode]);
  const translateX = useRef(new Animated.Value(0)).current;
  const entrance = useRef(new Animated.Value(0)).current;
  const isCompleted = Boolean(completedAt);

  const chip = stateChip(task);
  const displayName = formatContactName(getPrimaryContact(task));
  const activityLabel = formatCardTimeLabel(task, completedAt);
  const channelIcon: FeatherName = task.type.includes('call')
    ? 'phone'
    : task.type.includes('email')
      ? 'mail'
      : 'message-square';

  useEffect(() => {
    Animated.timing(entrance, {
      toValue: 1,
      duration: 320,
      delay: index * 50,
      easing: Easing.out(Easing.back(1.3)),
      useNativeDriver: true
    }).start();
  }, [entrance, index]);

  const rotateZ = translateX.interpolate({
    inputRange: [-SWIPE_OUT_DISTANCE, 0, SWIPE_OUT_DISTANCE],
    outputRange: [`-${MAX_ROTATION}deg`, '0deg', `${MAX_ROTATION}deg`],
    extrapolate: 'clamp'
  });

  const doneHintOpacity = translateX.interpolate({
    inputRange: [0, 30, SWIPE_THRESHOLD],
    outputRange: [0, 0.35, 1],
    extrapolate: 'clamp'
  });

  const snoozeHintOpacity = translateX.interpolate({
    inputRange: [-SWIPE_THRESHOLD, -30, 0],
    outputRange: [1, 0.35, 0],
    extrapolate: 'clamp'
  });

  const entranceTranslateY = entrance.interpolate({
    inputRange: [0, 1],
    outputRange: [22, 0]
  });

  const resetPosition = useCallback(() => {
    Animated.spring(translateX, {
      toValue: 0,
      damping: 20,
      stiffness: 180,
      mass: 0.8,
      useNativeDriver: true
    }).start(() => onSwipeEnd());
  }, [onSwipeEnd, translateX]);

  const flyOut = useCallback(
    (direction: 'right' | 'left', cb: () => void) => {
      const toValue = direction === 'right' ? SWIPE_OUT_DISTANCE : -SWIPE_OUT_DISTANCE;
      Animated.timing(translateX, {
        toValue,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      }).start(({ finished }) => {
        onSwipeEnd();
        if (finished) {
          reflow();
          cb();
        }
      });
    },
    [onSwipeEnd, translateX]
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_event, gestureState) =>
          !isCompleted
          && Math.abs(gestureState.dx) > 8
          && Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 0.9,
        onMoveShouldSetPanResponderCapture: () => false,
        onPanResponderGrant: () => {
          if (isCompleted) {
            return;
          }
          translateX.stopAnimation();
          onCloseMenus();
          onSwipeStart();
        },
        onPanResponderMove: (_event, gestureState) => {
          if (isCompleted) {
            return;
          }
          const clamped = Math.max(-SWIPE_OUT_DISTANCE, Math.min(SWIPE_OUT_DISTANCE, gestureState.dx));
          translateX.setValue(clamped);
        },
        onPanResponderRelease: (_event, gestureState) => {
          if (isCompleted) {
            return;
          }

          if (gestureState.dx > SWIPE_THRESHOLD) {
            flyOut('right', () => onDone(task));
            return;
          }
          if (gestureState.dx < -SWIPE_THRESHOLD) {
            flyOut('left', () => onSnooze(task, 'tomorrow'));
            return;
          }
          resetPosition();
        },
        onPanResponderTerminate: () => {
          if (!isCompleted) {
            resetPosition();
          }
        },
        onPanResponderTerminationRequest: () => true,
        onShouldBlockNativeResponder: () => false
      }),
    [flyOut, isCompleted, onCloseMenus, onDone, onSnooze, onSwipeStart, resetPosition, task, translateX]
  );

  return (
    <Animated.View
      style={[
        cs.wrapper,
        {
          opacity: entrance,
          transform: [{ translateY: entranceTranslateY }]
        }
      ]}
    >
      {!isCompleted ? (
        <>
          <Animated.View style={[cs.hintFull, cs.hintDone, { opacity: doneHintOpacity }]}>
            <Feather name="check-circle" size={18} color={colors.white} style={{ marginRight: 6 }} />
            <Text style={cs.hintLabel}>Done</Text>
          </Animated.View>
          <Animated.View style={[cs.hintFull, cs.hintSnooze, { opacity: snoozeHintOpacity }]}>
            <Feather name="clock" size={18} color={colors.white} style={{ marginRight: 6 }} />
            <Text style={cs.hintLabel}>Snooze</Text>
          </Animated.View>
        </>
      ) : null}

      <Animated.View
        style={[cs.cardMotion, { transform: [{ translateX }, { rotateZ: isCompleted ? '0deg' : rotateZ }] }]}
        {...(!isCompleted ? panResponder.panHandlers : {})}
      >
        <Pressable
          style={cs.card}
          onPress={() => {
            onCloseMenus();
            onOpenLead(task);
          }}
        >
          <View style={cs.topRow}>
            <View style={cs.badgeRow}>
              <View style={cs.stateBadge}>
                <Feather name={chip.icon} size={13} color={chip.tint} />
                <Text style={[cs.stateBadgeText, { color: chip.tint }]}>{chip.label}</Text>
              </View>
              <Text style={cs.timeLabel}>{activityLabel}</Text>
            </View>
            <Pressable
              style={cs.mailButton}
              onPress={() => {
                onCloseMenus();
                onOpenLead(task);
              }}
            >
              <Feather name={channelIcon} size={17} color={cs.iconTone.color} />
            </Pressable>
          </View>

          <View style={cs.identityRow}>
            <Pressable
              style={cs.identityPress}
              onPress={() => {
                onCloseMenus();
                onOpenLead(task);
              }}
            >
              <Text style={cs.contactName} numberOfLines={1}>
                {displayName}
              </Text>
              <Text style={cs.wantsLine} numberOfLines={1}>
                {wantsLine(task)}
              </Text>
            </Pressable>

            {!isCompleted ? (
              <Pressable
                style={cs.menuButton}
                onPress={() => {
                  onCloseMenus();
                  onOpenContactMenu(task);
                }}
              >
                <Feather name="more-horizontal" size={16} color={cs.iconTone.color} />
              </Pressable>
            ) : null}
          </View>

          <Pressable
            style={cs.actionStrip}
            onPress={() => {
              onCloseMenus();
              onOpenLead(task);
            }}
          >
            <Feather name="zap" size={17} color={cs.iconTone.color} style={{ marginRight: 10 }} />
            <View style={cs.actionTextWrap}>
              <Text style={cs.actionCaption}>Next action</Text>
              <Text style={cs.actionText} numberOfLines={2}>
                {nextActionLine(task)}
              </Text>
            </View>
          </Pressable>

          <View style={cs.footerRow}>
            {isCompleted ? (
              <View style={cs.donePill}>
                <Feather name="check-circle" size={14} color={cs.iconTone.color} style={{ marginRight: 6 }} />
                <Text style={cs.donePillLabel}>Completed</Text>
              </View>
            ) : (
              <Pressable
                style={cs.snoozeAction}
                onPress={() => {
                  onCloseMenus();
                  onOpenSnoozeMenu(task);
                }}
              >
                <Feather name="clock" size={14} color={cs.iconTone.color} style={{ marginRight: 6 }} />
                <Text style={cs.snoozeLabel}>Snooze</Text>
                <Feather name="chevron-right" size={16} color={cs.iconTone.color} style={cs.snoozeChevron} />
              </Pressable>
            )}
          </View>
        </Pressable>
      </Animated.View>

      {!isCompleted ? (
        <>
          <Modal
            transparent
            animationType="fade"
            visible={contactMenuOpen}
            onRequestClose={onCloseMenus}
          >
            <View style={cs.modalBackdrop}>
              <Pressable style={cs.modalBackdropPress} onPress={onCloseMenus} />
              <View style={cs.modalCard}>
                <Text style={cs.modalTitle}>Contact</Text>
                <Pressable style={cs.modalItem} onPress={() => onContactAction(task, 'call')}>
                  <Feather name="phone" size={16} color={cs.iconTone.color} style={{ marginRight: 10 }} />
                  <Text style={cs.modalItemText}>Call</Text>
                </Pressable>
                <View style={cs.modalSeparator} />
                <Pressable style={cs.modalItem} onPress={() => onContactAction(task, 'email')}>
                  <Feather name="mail" size={16} color={cs.iconTone.color} style={{ marginRight: 10 }} />
                  <Text style={cs.modalItemText}>Email</Text>
                </Pressable>
                <View style={cs.modalSeparator} />
                <Pressable style={cs.modalItem} onPress={() => onContactAction(task, 'sms')}>
                  <Feather name="message-square" size={16} color={cs.iconTone.color} style={{ marginRight: 10 }} />
                  <Text style={cs.modalItemText}>Message SMS</Text>
                </Pressable>
              </View>
            </View>
          </Modal>

          <Modal
            transparent
            animationType="fade"
            visible={snoozeMenuOpen}
            onRequestClose={onCloseMenus}
          >
            <View style={cs.modalBackdrop}>
              <Pressable style={cs.modalBackdropPress} onPress={onCloseMenus} />
              <View style={cs.modalCard}>
                <Text style={cs.modalTitle}>Snooze</Text>
                {SNOOZE_OPTIONS.map((option, index) => (
                  <View key={option.key}>
                    <Pressable style={cs.modalItem} onPress={() => onSnooze(task, option.key)}>
                      <Text style={cs.modalItemText}>{option.label}</Text>
                    </Pressable>
                    {index < SNOOZE_OPTIONS.length - 1 ? <View style={cs.modalSeparator} /> : null}
                  </View>
                ))}
              </View>
            </View>
          </Modal>
        </>
      ) : null}
    </Animated.View>
  );
}

export default function TaskDeckScreen(): JSX.Element {
  const { colors, mode } = useTabTheme();
  const ss = useMemo(() => screenStyles(colors, mode), [colors, mode]);
  const router = useRouter();
  const qc = useQueryClient();
  const currentUser = useCurrentUser();
  const { user } = useUser();

  const taskDeckQueryKey = useMemo(
    () =>
      [
        'task-deck',
        currentUser.data?.userId,
        currentUser.data?.teamId,
        currentUser.data?.role
      ] as const,
    [currentUser.data?.role, currentUser.data?.teamId, currentUser.data?.userId]
  );

  const [activeTab, setActiveTab] = useState<DeckTab>('today');
  const [swipeCount, setSwipeCount] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [contactTaskId, setContactTaskId] = useState<string | null>(null);
  const [snoozeTaskId, setSnoozeTaskId] = useState<string | null>(null);
  const [completedTasks, setCompletedTasks] = useState<CompletedDeckTask[]>([]);
  const [initialDeckSize, setInitialDeckSize] = useState<number | null>(null);

  const tasks = useQuery({
    queryKey: taskDeckQueryKey,
    queryFn: () => apiGet<TaskCard[]>('/task-deck'),
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    refetchOnReconnect: true
  });

  useEffect(() => {
    if (initialDeckSize === null && tasks.data) {
      setInitialDeckSize(tasks.data.length);
    }
  }, [initialDeckSize, tasks.data]);

  const closeMenus = useCallback(() => {
    setContactTaskId(null);
    setSnoozeTaskId(null);
  }, []);

  useEffect(() => {
    const openIds = new Set((tasks.data ?? []).map((task) => task.id));
    if (contactTaskId && !openIds.has(contactTaskId)) {
      setContactTaskId(null);
    }
    if (snoozeTaskId && !openIds.has(snoozeTaskId)) {
      setSnoozeTaskId(null);
    }
  }, [contactTaskId, snoozeTaskId, tasks.data]);

  const doneMutation = useMutation({
    mutationFn: (taskId: string) => apiPost(`/tasks/${taskId}/done`, {}),
    onMutate: async (taskId) => {
      await qc.cancelQueries({ queryKey: ['task-deck'] });
      const prev = qc.getQueryData<TaskCard[]>(taskDeckQueryKey);
      qc.setQueryData<TaskCard[]>(taskDeckQueryKey, (old) => old?.filter((task) => task.id !== taskId));
      return { prev };
    },
    onError: (_error, taskId, context) => {
      if (context?.prev) {
        qc.setQueryData(taskDeckQueryKey, context.prev);
      }
      setCompletedTasks((prev) => prev.filter((entry) => entry.task.id !== taskId));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['task-deck'] })
  });

  const snoozeMutation = useMutation({
    mutationFn: ({ taskId, mode: snoozeMode }: { taskId: string; mode: SnoozeMode }) =>
      apiPost(`/tasks/${taskId}/snooze`, { mode: snoozeMode }),
    onMutate: async ({ taskId }) => {
      await qc.cancelQueries({ queryKey: ['task-deck'] });
      const prev = qc.getQueryData<TaskCard[]>(taskDeckQueryKey);
      qc.setQueryData<TaskCard[]>(taskDeckQueryKey, (old) => old?.filter((task) => task.id !== taskId));
      return { prev };
    },
    onError: (_error, _vars, context) => {
      if (context?.prev) {
        qc.setQueryData(taskDeckQueryKey, context.prev);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['task-deck'] })
  });

  const openTasks = tasks.data ?? [];

  const { todayTasks, upcomingTasks } = useMemo(() => {
    const now = new Date();
    const tomorrowStart = startOfLocalDay(now);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const tomorrowStartMs = tomorrowStart.getTime();

    const sorted = [...openTasks].sort((a, b) => dueTimeMs(a) - dueTimeMs(b));
    const today: TaskCard[] = [];
    const upcoming: TaskCard[] = [];

    for (const task of sorted) {
      const due = parseDate(task.due_at);
      if (!due || due.getTime() < tomorrowStartMs) {
        today.push(task);
        continue;
      }
      upcoming.push(task);
    }

    return { todayTasks: today, upcomingTasks: upcoming };
  }, [openTasks]);

  const completedRows = useMemo(
    () =>
      [...completedTasks].sort((a, b) => {
        const aTime = parseDate(a.completedAt)?.getTime() ?? 0;
        const bTime = parseDate(b.completedAt)?.getTime() ?? 0;
        return bTime - aTime;
      }),
    [completedTasks]
  );

  const visibleRows = useMemo<Array<{ task: TaskCard; completedAt?: string }>>(() => {
    if (activeTab === 'today') {
      return todayTasks.map((task) => ({ task }));
    }
    if (activeTab === 'upcoming') {
      return upcomingTasks.map((task) => ({ task }));
    }
    return completedRows.map((entry) => ({ task: entry.task, completedAt: entry.completedAt }));
  }, [activeTab, completedRows, todayTasks, upcomingTasks]);

  const openCount = openTasks.length;
  const atRiskCount = openTasks.filter((task) => task.lead_state === 'At-Risk').length;

  const urgentCount = useMemo(() => {
    const nowMs = Date.now();
    return openTasks.filter((task) => {
      const due = parseDate(task.due_at);
      if (!due) {
        return false;
      }
      return due.getTime() - nowMs <= 2 * 60 * 60_000;
    }).length;
  }, [openTasks]);

  const waitingSummary = useMemo(() => {
    const nowMs = Date.now();
    const waitDays = openTasks
      .map((task) => parseDate(task.mailbox_email_sent_at))
      .filter((value): value is Date => Boolean(value))
      .map((value) => Math.floor((nowMs - value.getTime()) / 86_400_000))
      .filter((days) => days >= 1);

    if (waitDays.length === 0) {
      return { count: 0, maxDays: 0 };
    }

    return {
      count: waitDays.length,
      maxDays: Math.max(...waitDays)
    };
  }, [openTasks]);

  const trackedTotal = Math.max(initialDeckSize ?? 0, openCount + completedTasks.length, 1);
  const clearedCount = completedTasks.length;
  const progressPct = Math.round((clearedCount / trackedTotal) * 100);

  const userDisplayName = useMemo(() => {
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
    if (name.length > 0) {
      return name;
    }
    const email = user?.primaryEmailAddress?.emailAddress;
    if (email) {
      return formatContactName(email);
    }
    return 'Agent';
  }, [user?.firstName, user?.lastName, user?.primaryEmailAddress?.emailAddress]);

  const userInitials = useMemo(() => {
    const parts = userDisplayName
      .split(' ')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      return 'A';
    }
    return parts
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('');
  }, [userDisplayName]);

  const waitingLabel =
    waitingSummary.count > 0
      ? `${waitingSummary.count} lead${waitingSummary.count === 1 ? '' : 's'} waiting (${waitingSummary.maxDays} day${waitingSummary.maxDays === 1 ? '' : 's'})`
      : 'No leads waiting';

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    closeMenus();
    try {
      await qc.invalidateQueries({ queryKey: ['task-deck'] });
      await tasks.refetch();
    } finally {
      setIsRefreshing(false);
    }
  }, [closeMenus, qc, tasks]);

  const openLead = useCallback(
    (task: TaskCard) => {
      closeMenus();
      const params: Record<string, string> = {
        id: task.lead_id,
        lead_state: task.lead_state,
        task_type: task.type,
        due_at: task.due_at
      };

      if (task.primary_email) {
        params.primary_email = task.primary_email;
      }
      if (task.primary_phone) {
        params.primary_phone = task.primary_phone;
      }

      router.push({ pathname: '/lead/[id]', params });
    },
    [closeMenus, router]
  );

  const handleDone = useCallback(
    (task: TaskCard) => {
      closeMenus();
      setCompletedTasks((prev) => {
        if (prev.some((entry) => entry.task.id === task.id)) {
          return prev;
        }
        return [{ task, completedAt: new Date().toISOString() }, ...prev];
      });
      doneMutation.mutate(task.id);
    },
    [closeMenus, doneMutation]
  );

  const handleSnooze = useCallback(
    (task: TaskCard, snoozeMode: SnoozeMode) => {
      closeMenus();
      snoozeMutation.mutate({ taskId: task.id, mode: snoozeMode });
    },
    [closeMenus, snoozeMutation]
  );

  const handleContactAction = useCallback(
    async (task: TaskCard, action: ContactAction) => {
      closeMenus();

      const email = task.primary_email?.trim();
      const phone = task.primary_phone?.trim();

      let url: string | null = null;
      if (action === 'email') {
        if (!email) {
          Alert.alert('No email found', 'This lead does not have an email address yet.');
          return;
        }
        url = `mailto:${email}`;
      } else if (action === 'call') {
        if (!phone) {
          Alert.alert('No phone found', 'This lead does not have a phone number yet.');
          return;
        }
        url = `tel:${phone}`;
      } else {
        if (!phone) {
          Alert.alert('No phone found', 'This lead does not have a phone number yet.');
          return;
        }
        url = `sms:${phone}`;
      }

      try {
        const canOpen = await Linking.canOpenURL(url);
        if (!canOpen) {
          Alert.alert('Unavailable', 'No app is available to complete this action.');
          return;
        }
        await Linking.openURL(url);
      } catch (_error) {
        Alert.alert('Unable to open', 'Please try again.');
      }
    },
    [closeMenus]
  );

  const emptyStateTitle = activeTab === 'completed' ? 'No completed tasks yet' : 'No tasks in this section';
  const emptyStateBody =
    activeTab === 'completed'
      ? 'Completed tasks from this session will appear here.'
      : activeTab === 'today'
        ? 'You are clear for today. Pull to refresh for new activity.'
        : 'Nothing upcoming right now. Use snooze to move tasks here.';

  return (
    <SafeAreaView style={ss.safeArea} edges={['top']}>
      <ScrollView
        contentContainerStyle={ss.content}
        scrollEnabled={swipeCount === 0}
        onScrollBeginDrag={closeMenus}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => {
              void onRefresh();
            }}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      >
        <View style={ss.heroShell}>
          <View style={ss.heroGlowLeft} />
          <View style={ss.heroGlowRight} />

          <View style={ss.navRow}>
            <View style={ss.navSpacer} />
            <Text style={ss.navTitle}>Task Deck</Text>
            <Pressable style={ss.bellButton} onPress={() => router.push('/notifications')}>
              <Feather name="bell" size={20} color={ss.iconTone.color} />
            </Pressable>
          </View>

          <Text style={ss.greetingText}>{greetingLabel()}</Text>

          <View style={ss.profileRow}>
            {user?.imageUrl ? (
              <Image source={{ uri: user.imageUrl }} style={ss.profileAvatar} />
            ) : (
              <View style={ss.profileAvatarFallback}>
                <Text style={ss.profileAvatarInitials}>{userInitials}</Text>
              </View>
            )}

            <View style={ss.profileMain}>
              <Text style={ss.profileName} numberOfLines={1}>
                {userDisplayName}
              </Text>
              <View style={ss.progressInfo}>
                <View style={ss.progressIconPill}>
                  <Feather name="zap" size={13} color={ss.iconTone.color} />
                </View>
                <Text style={ss.progressLabel}>
                  {clearedCount}/{trackedTotal} cleared
                </Text>
              </View>
              <View style={ss.progressTrack}>
                <View style={[ss.progressFill, { width: `${progressPct}%` }]} />
              </View>
            </View>

            <View style={ss.statusColumn}>
              <Text style={ss.statusLine}>
                {urgentCount} urgent · {atRiskCount} at risk
              </Text>
              <Text style={ss.statusLine}>{waitingLabel}</Text>
            </View>
          </View>

          <View style={ss.segmentControl}>
            {DECK_TABS.map((tab) => {
              const selected = activeTab === tab.key;
              return (
                <Pressable
                  key={tab.key}
                  style={[ss.segmentItem, selected ? ss.segmentItemActive : null]}
                  onPress={() => {
                    closeMenus();
                    setActiveTab(tab.key);
                  }}
                >
                  <Text style={[ss.segmentText, selected ? ss.segmentTextActive : null]}>{tab.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={ss.cardsArea}>
          {isRefreshing ? (
            <View style={ss.refreshRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={ss.refreshText}>Refreshing latest activity...</Text>
            </View>
          ) : null}

          {tasks.isLoading && activeTab !== 'completed' && visibleRows.length === 0 ? (
            <View style={ss.messageCard}>
              <Text style={ss.messageText}>Loading task deck...</Text>
            </View>
          ) : null}

          {tasks.error ? (
            <View style={ss.messageCard}>
              <Text style={ss.errorText}>
                Unable to load task deck.
                {tasks.error instanceof Error ? ` (${tasks.error.message})` : ''}
              </Text>
            </View>
          ) : null}

          {visibleRows.map((row, index) => (
            <TaskSwipeCard
              key={`${row.task.id}:${row.completedAt ?? 'open'}`}
              task={row.task}
              index={index}
              colors={colors}
              mode={mode}
              completedAt={row.completedAt}
              contactMenuOpen={contactTaskId === row.task.id && !row.completedAt}
              snoozeMenuOpen={snoozeTaskId === row.task.id && !row.completedAt}
              onDone={handleDone}
              onSnooze={handleSnooze}
              onContactAction={handleContactAction}
              onOpenLead={openLead}
              onOpenContactMenu={(task) => {
                setSnoozeTaskId(null);
                setContactTaskId(task.id);
              }}
              onOpenSnoozeMenu={(task) => {
                setContactTaskId(null);
                setSnoozeTaskId(task.id);
              }}
              onCloseMenus={closeMenus}
              onSwipeStart={() => setSwipeCount((count) => count + 1)}
              onSwipeEnd={() => setSwipeCount((count) => Math.max(0, count - 1))}
            />
          ))}

          {!tasks.isLoading && !tasks.error && visibleRows.length === 0 ? (
            <View style={ss.emptyCard}>
              <Feather name="inbox" size={28} color={ss.iconTone.color} style={{ marginBottom: 10 }} />
              <Text style={ss.emptyTitle}>{emptyStateTitle}</Text>
              <Text style={ss.emptyBody}>{emptyStateBody}</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function cardStyles(colors: TabThemeColors, mode: 'dark' | 'light') {
  const isDark = mode === 'dark';
  const cardBackground = isDark ? 'rgba(35, 38, 53, 0.96)' : colors.surface;
  const cardBorder = isDark ? 'rgba(118, 124, 145, 0.5)' : colors.border;
  const textPrimary = isDark ? '#F0F2F8' : colors.text;
  const textMuted = isDark ? 'rgba(240, 242, 248, 0.72)' : colors.textSecondary;
  const iconTone = isDark ? '#E9EBF5' : colors.text;

  return StyleSheet.create({
    wrapper: {
      marginBottom: 16,
      borderRadius: 26
    },
    hintFull: {
      ...StyleSheet.absoluteFillObject,
      borderRadius: 26,
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center'
    },
    hintDone: {
      backgroundColor: colors.accent
    },
    hintSnooze: {
      backgroundColor: colors.warning
    },
    hintLabel: {
      color: colors.white,
      fontWeight: '800',
      fontSize: 14,
      letterSpacing: 0.3
    },
    cardMotion: {
      borderRadius: 26
    },
    card: {
      borderRadius: 26,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: cardBackground,
      paddingHorizontal: 16,
      paddingVertical: 14,
      overflow: 'visible',
      shadowColor: '#030509',
      shadowOpacity: 0.25,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
      elevation: 8
    },
    topRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12
    },
    badgeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm
    },
    stateBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(110, 118, 140, 0.38)' : colors.border,
      paddingHorizontal: 10,
      paddingVertical: 5,
      backgroundColor: isDark ? 'rgba(25, 29, 42, 0.9)' : colors.surfaceMuted
    },
    stateBadgeText: {
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 0.25
    },
    timeLabel: {
      color: textMuted,
      fontSize: 12
    },
    mailButton: {
      width: 30,
      height: 30,
      borderRadius: 15,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(110, 118, 140, 0.5)' : colors.border,
      backgroundColor: isDark ? 'rgba(27, 30, 44, 0.95)' : colors.surfaceMuted,
      alignItems: 'center',
      justifyContent: 'center'
    },
    identityRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12
    },
    identityPress: {
      flex: 1,
      marginRight: spacing.sm
    },
    contactName: {
      color: textPrimary,
      fontSize: 20,
      fontWeight: '700',
      letterSpacing: 0.2
    },
    wantsLine: {
      color: textMuted,
      fontSize: 14,
      marginTop: 2
    },
    menuButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(190, 196, 178, 0.55)' : colors.border,
      backgroundColor: isDark ? 'rgba(33, 36, 49, 0.95)' : colors.surface,
      alignItems: 'center',
      justifyContent: 'center'
    },
    actionStrip: {
      borderRadius: 14,
      backgroundColor: isDark ? 'rgba(255, 255, 255, 0.05)' : colors.surfaceMuted,
      paddingHorizontal: 12,
      paddingVertical: 12,
      flexDirection: 'row',
      alignItems: 'flex-start'
    },
    actionTextWrap: {
      flex: 1
    },
    actionCaption: {
      color: textMuted,
      fontSize: 12,
      marginBottom: 2
    },
    actionText: {
      color: textPrimary,
      fontSize: 15,
      lineHeight: 22
    },
    footerRow: {
      marginTop: 10,
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center'
    },
    snoozeAction: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(109, 117, 140, 0.4)' : colors.border,
      backgroundColor: isDark ? 'rgba(24, 28, 40, 0.95)' : colors.surfaceMuted,
      paddingHorizontal: 12,
      paddingVertical: 7,
      flexDirection: 'row',
      alignItems: 'center'
    },
    snoozeLabel: {
      color: textMuted,
      fontSize: 13
    },
    snoozeChevron: {
      marginLeft: 2
    },
    donePill: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(109, 117, 140, 0.4)' : colors.border,
      backgroundColor: isDark ? 'rgba(24, 28, 40, 0.95)' : colors.surfaceMuted,
      paddingHorizontal: 12,
      paddingVertical: 7,
      flexDirection: 'row',
      alignItems: 'center'
    },
    donePillLabel: {
      color: textMuted,
      fontSize: 13
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(5, 8, 14, 0.45)',
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 24
    },
    modalBackdropPress: {
      ...StyleSheet.absoluteFillObject
    },
    modalCard: {
      width: '100%',
      maxWidth: 280,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(111, 118, 142, 0.5)' : colors.border,
      backgroundColor: isDark ? '#1C1E2A' : colors.surface,
      paddingVertical: 8,
      shadowColor: '#030406',
      shadowOpacity: 0.35,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 6 },
      elevation: 12
    },
    modalTitle: {
      color: textMuted,
      fontSize: 12,
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      paddingHorizontal: 14,
      paddingVertical: 8
    },
    modalItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingVertical: 12
    },
    modalItemText: {
      color: textPrimary,
      fontSize: 15
    },
    modalSeparator: {
      height: 1,
      backgroundColor: isDark ? 'rgba(120, 126, 148, 0.45)' : colors.border,
      marginHorizontal: 10
    },
    iconTone: {
      color: iconTone
    }
  });
}

function screenStyles(colors: TabThemeColors, mode: 'dark' | 'light') {
  const isDark = mode === 'dark';
  const pageBg = isDark ? '#111320' : colors.background;
  const heroBg = isDark ? '#171A2C' : colors.surface;
  const heroBorder = isDark ? 'rgba(96, 103, 129, 0.35)' : colors.border;
  const textPrimary = isDark ? '#F0F2F7' : colors.text;
  const textMuted = isDark ? 'rgba(237, 239, 247, 0.74)' : colors.textSecondary;
  const iconTone = isDark ? '#F0F2F7' : colors.text;

  return StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: pageBg
    },
    content: {
      paddingBottom: 124
    },
    heroShell: {
      marginBottom: spacing.md,
      backgroundColor: heroBg,
      borderBottomWidth: 1,
      borderBottomColor: heroBorder,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.lg,
      overflow: 'hidden'
    },
    heroGlowLeft: {
      position: 'absolute',
      top: -88,
      left: -38,
      width: 256,
      height: 256,
      borderRadius: 128,
      backgroundColor: 'rgba(77, 94, 184, 0.38)'
    },
    heroGlowRight: {
      position: 'absolute',
      top: -110,
      right: -78,
      width: 300,
      height: 300,
      borderRadius: 150,
      backgroundColor: 'rgba(54, 74, 171, 0.26)'
    },
    navRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between'
    },
    navSpacer: {
      width: 34
    },
    navTitle: {
      flex: 1,
      textAlign: 'center',
      color: textPrimary,
      fontSize: 20,
      fontWeight: '600',
      letterSpacing: 0.2
    },
    bellButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center'
    },
    greetingText: {
      marginTop: spacing.md,
      color: textPrimary,
      fontSize: 17,
      fontWeight: '500'
    },
    profileRow: {
      marginTop: spacing.sm,
      flexDirection: 'row',
      alignItems: 'center'
    },
    profileAvatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: 'rgba(239, 241, 248, 0.2)'
    },
    profileAvatarFallback: {
      width: 48,
      height: 48,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: 'rgba(239, 241, 248, 0.2)',
      backgroundColor: 'rgba(237, 240, 247, 0.2)',
      alignItems: 'center',
      justifyContent: 'center'
    },
    profileAvatarInitials: {
      color: textPrimary,
      fontSize: 16,
      fontWeight: '700'
    },
    profileMain: {
      flex: 1,
      marginLeft: spacing.md,
      minWidth: 0
    },
    profileName: {
      color: textPrimary,
      fontSize: 16,
      fontWeight: '700'
    },
    progressInfo: {
      marginTop: spacing.xs,
      flexDirection: 'row',
      alignItems: 'center'
    },
    progressIconPill: {
      width: 26,
      height: 26,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: 'rgba(99, 108, 133, 0.7)',
      backgroundColor: 'rgba(20, 24, 38, 0.92)',
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: spacing.sm
    },
    progressLabel: {
      color: textPrimary,
      fontSize: 13
    },
    progressTrack: {
      marginTop: spacing.xs,
      width: '100%',
      height: 6,
      borderRadius: 999,
      backgroundColor: isDark ? '#222739' : colors.surfaceMuted,
      overflow: 'hidden'
    },
    progressFill: {
      height: '100%',
      backgroundColor: '#F0F2F7'
    },
    statusColumn: {
      width: 126,
      marginLeft: spacing.sm
    },
    statusLine: {
      color: textMuted,
      fontSize: 12,
      lineHeight: 19
    },
    segmentControl: {
      marginTop: spacing.lg,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(97, 104, 130, 0.52)' : colors.border,
      backgroundColor: isDark ? 'rgba(18, 21, 33, 0.68)' : colors.surface,
      padding: 3,
      flexDirection: 'row'
    },
    segmentItem: {
      flex: 1,
      borderRadius: 11,
      paddingVertical: 8,
      alignItems: 'center'
    },
    segmentItemActive: {
      backgroundColor: '#E7E7EB'
    },
    segmentText: {
      color: textPrimary,
      fontWeight: '500',
      fontSize: 17
    },
    segmentTextActive: {
      color: '#1C1F2E'
    },
    cardsArea: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm
    },
    refreshRow: {
      marginBottom: spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs
    },
    refreshText: {
      color: textMuted,
      fontSize: 13,
      fontWeight: '600'
    },
    messageCard: {
      borderRadius: 18,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(96, 103, 129, 0.45)' : colors.border,
      backgroundColor: isDark ? 'rgba(33, 36, 50, 0.9)' : colors.surface,
      padding: 16,
      marginBottom: spacing.sm
    },
    messageText: {
      color: textPrimary
    },
    errorText: {
      color: '#FF9B9B'
    },
    emptyCard: {
      borderRadius: 22,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(96, 103, 129, 0.45)' : colors.border,
      backgroundColor: isDark ? 'rgba(33, 36, 50, 0.9)' : colors.surface,
      paddingVertical: 30,
      paddingHorizontal: 24,
      alignItems: 'center'
    },
    emptyTitle: {
      color: textPrimary,
      fontSize: 17,
      fontWeight: '700'
    },
    emptyBody: {
      marginTop: spacing.xs,
      color: textMuted,
      textAlign: 'center',
      lineHeight: 20
    },
    iconTone: {
      color: iconTone
    }
  });
}
