import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import {
  Animated,
  Easing,
  LayoutAnimation,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View,
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
  type: string;
  lead_state: string;
  summary?: string;
  primary_email?: string;
  primary_phone?: string;
}

const SWIPE_THRESHOLD = 120;
const SWIPE_OUT_DISTANCE = 400;
const MAX_ROTATION = 5;

function formatTaskType(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatDueDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function getPrimaryContact(task: TaskCard): string {
  return task.primary_email ?? task.primary_phone ?? 'No contact';
}

function getStateColor(colors: TabThemeColors, state: string): string {
  if (state === 'Active') return colors.accent;
  if (state === 'At-Risk') return colors.warning;
  if (state === 'Stale') return '#FF7A7A';
  return colors.primary;
}

const reflow = () =>
  LayoutAnimation.configureNext({
    duration: 280,
    update: { type: LayoutAnimation.Types.easeInEaseOut },
    delete: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },
  });

/* ────────────────────────────────────────────────────────────
   Swipeable Task Card
   Swipe right → Done  ·  Swipe left → Snooze  ·  Tap → Open
   ──────────────────────────────────────────────────────────── */

interface TaskSwipeCardProps {
  task: TaskCard;
  index: number;
  colors: TabThemeColors;
  mode: 'dark' | 'light';
  onDone: (taskId: string) => void;
  onSnooze: (taskId: string) => void;
  onOpenLead: (task: TaskCard) => void;
  onSwipeStart: () => void;
  onSwipeEnd: () => void;
}

function TaskSwipeCard({
  task,
  index,
  colors,
  mode,
  onDone,
  onSnooze,
  onOpenLead,
  onSwipeStart,
  onSwipeEnd,
}: TaskSwipeCardProps) {
  const cs = useMemo(() => cardStyles(colors, mode), [colors, mode]);
  const translateX = useRef(new Animated.Value(0)).current;
  const entrance = useRef(new Animated.Value(0)).current;

  const stateColor = getStateColor(colors, task.lead_state);
  const contact = getPrimaryContact(task);
  const contactInitial = contact.charAt(0).toUpperCase();

  // Staggered entrance
  useEffect(() => {
    Animated.timing(entrance, {
      toValue: 1,
      duration: 350,
      delay: index * 60,
      easing: Easing.out(Easing.back(1.4)),
      useNativeDriver: true,
    }).start();
  }, []);

  const rotateZ = translateX.interpolate({
    inputRange: [-SWIPE_OUT_DISTANCE, 0, SWIPE_OUT_DISTANCE],
    outputRange: [`-${MAX_ROTATION}deg`, '0deg', `${MAX_ROTATION}deg`],
    extrapolate: 'clamp',
  });

  const doneHintOpacity = translateX.interpolate({
    inputRange: [0, 30, SWIPE_THRESHOLD],
    outputRange: [0, 0.4, 1],
    extrapolate: 'clamp',
  });

  const snoozeHintOpacity = translateX.interpolate({
    inputRange: [-SWIPE_THRESHOLD, -30, 0],
    outputRange: [1, 0.4, 0],
    extrapolate: 'clamp',
  });

  const entranceOpacity = entrance;
  const entranceTranslateY = entrance.interpolate({
    inputRange: [0, 1],
    outputRange: [24, 0],
  });

  const resetPosition = useCallback(() => {
    Animated.spring(translateX, {
      toValue: 0,
      damping: 20,
      stiffness: 180,
      mass: 0.8,
      useNativeDriver: true,
    }).start(() => onSwipeEnd());
  }, [translateX, onSwipeEnd]);

  const flyOut = useCallback(
    (direction: 'right' | 'left', cb: () => void) => {
      const toValue = direction === 'right' ? SWIPE_OUT_DISTANCE : -SWIPE_OUT_DISTANCE;
      Animated.timing(translateX, {
        toValue,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        onSwipeEnd();
        if (finished) {
          reflow();
          cb();
        }
      });
    },
    [translateX, onSwipeEnd]
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_e, gs) =>
          Math.abs(gs.dx) > 8 && Math.abs(gs.dx) > Math.abs(gs.dy) * 0.9,
        onMoveShouldSetPanResponderCapture: () => false,
        onPanResponderGrant: () => {
          translateX.stopAnimation();
          onSwipeStart();
        },
        onPanResponderMove: (_e, gs) => {
          const clamped = Math.max(-SWIPE_OUT_DISTANCE, Math.min(SWIPE_OUT_DISTANCE, gs.dx));
          translateX.setValue(clamped);
        },
        onPanResponderRelease: (_e, gs) => {
          if (gs.dx > SWIPE_THRESHOLD) {
            flyOut('right', () => onDone(task.id));
            return;
          }
          if (gs.dx < -SWIPE_THRESHOLD) {
            flyOut('left', () => onSnooze(task.id));
            return;
          }
          resetPosition();
        },
        onPanResponderTerminate: resetPosition,
        // Allow native controls (including tab bar buttons) to take focus when needed.
        onPanResponderTerminationRequest: () => true,
        onShouldBlockNativeResponder: () => false,
      }),
    [translateX, onSwipeStart, onDone, onSnooze, task.id, flyOut, resetPosition]
  );

  return (
    <Animated.View
      style={[
        cs.wrapper,
        { opacity: entranceOpacity, transform: [{ translateY: entranceTranslateY }] },
      ]}
    >
      {/* Full-bleed colored hints that reveal behind the card during drag */}
      <Animated.View style={[cs.hintFull, cs.hintDone, { opacity: doneHintOpacity }]}>
        <Feather name="check-circle" size={18} color={colors.white} style={{ marginRight: 6 }} />
        <Text style={cs.hintLabel}>Done</Text>
      </Animated.View>
      <Animated.View style={[cs.hintFull, cs.hintSnooze, { opacity: snoozeHintOpacity }]}>
        <Feather name="clock" size={18} color={colors.white} style={{ marginRight: 6 }} />
        <Text style={cs.hintLabel}>Snooze</Text>
      </Animated.View>

      {/* Draggable card */}
      <Animated.View
        style={[cs.cardMotion, { transform: [{ translateX }, { rotateZ }] }]}
        {...panResponder.panHandlers}
      >
        <Pressable onPress={() => onOpenLead(task)}>
          <View style={cs.card}>
            {/* State pill + due date */}
            <View style={cs.topRow}>
              <View style={[cs.pill, { borderColor: stateColor }]}>
                <Text style={[cs.pillText, { color: stateColor }]}>{task.lead_state}</Text>
              </View>
              <Text style={cs.due}>{formatDueDate(task.due_at)}</Text>
            </View>

            {/* Contact identity */}
            <View style={cs.identity}>
              <View style={cs.avatar}>
                <Text style={cs.avatarLetter}>{contactInitial}</Text>
              </View>
              <View style={cs.identityText}>
                <Text style={cs.contactName} numberOfLines={1}>
                  {contact}
                </Text>
                <Text style={cs.taskType}>{formatTaskType(task.type)}</Text>
              </View>
            </View>

            <Text style={cs.summary} numberOfLines={2}>
              {task.summary ?? 'No summary yet'}
            </Text>

            {/* Action buttons */}
            <View style={cs.actionsRow}>
              <Pressable
                style={[cs.btn, cs.btnDone]}
                onPress={() => {
                  reflow();
                  onDone(task.id);
                }}
              >
                <Text style={cs.btnDoneLabel}>Done</Text>
              </Pressable>
              <Pressable
                style={[cs.btn, cs.btnSnooze]}
                onPress={() => {
                  reflow();
                  onSnooze(task.id);
                }}
              >
                <Text style={cs.btnSnoozeLabel}>Snooze</Text>
              </Pressable>
              <Pressable style={[cs.btn, cs.btnOpen]} onPress={() => onOpenLead(task)}>
                <Text style={cs.btnOpenLabel}>Open →</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}

/* ────────────────────────────────────────────────────────────
   Task Deck Screen
   ──────────────────────────────────────────────────────────── */

export default function TaskDeckScreen(): JSX.Element {
  const { colors, mode } = useTabTheme();
  const ss = useMemo(() => screenStyles(colors), [colors]);
  const router = useRouter();
  const qc = useQueryClient();
  const [swipeCount, setSwipeCount] = useState(0);
  const currentUser = useCurrentUser();

  const tasks = useQuery({
    queryKey: ['task-deck', currentUser.data?.userId, currentUser.data?.teamId, currentUser.data?.role],
    queryFn: () => apiGet<TaskCard[]>('/task-deck'),
  });

  const doneMutation = useMutation({
    mutationFn: (taskId: string) => apiPost(`/tasks/${taskId}/done`, {}),
    onMutate: async (taskId) => {
      await qc.cancelQueries({ queryKey: ['task-deck'] });
      const prev = qc.getQueryData<TaskCard[]>(['task-deck']);
      qc.setQueryData<TaskCard[]>(['task-deck'], (old) => old?.filter((t) => t.id !== taskId));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['task-deck'], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['task-deck'] }),
  });

  const snoozeMutation = useMutation({
    mutationFn: (taskId: string) => apiPost(`/tasks/${taskId}/snooze`, { mode: 'tomorrow' }),
    onMutate: async (taskId) => {
      await qc.cancelQueries({ queryKey: ['task-deck'] });
      const prev = qc.getQueryData<TaskCard[]>(['task-deck']);
      qc.setQueryData<TaskCard[]>(['task-deck'], (old) => old?.filter((t) => t.id !== taskId));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['task-deck'], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['task-deck'] }),
  });

  const openCount = tasks.data?.length ?? 0;
  const atRiskCount = tasks.data?.filter((t) => t.lead_state === 'At-Risk').length ?? 0;
  const staleCount = tasks.data?.filter((t) => t.lead_state === 'Stale').length ?? 0;
  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  function openLead(task: TaskCard): void {
    const params: Record<string, string> = {
      id: task.lead_id,
      lead_state: task.lead_state,
      task_type: task.type,
      due_at: task.due_at,
    };
    if (task.primary_email) params.primary_email = task.primary_email;
    if (task.primary_phone) params.primary_phone = task.primary_phone;
    router.push({ pathname: '/lead/[id]', params });
  }

  return (
    <SafeAreaView style={ss.safeArea} edges={['top']}>
      <ScrollView contentContainerStyle={ss.container} scrollEnabled={swipeCount === 0}>
        {/* Hero */}
        <View style={ss.hero}>
          <View style={ss.heroTop}>
            <Text style={ss.heroTitle}>Task Deck</Text>
            <Text style={ss.heroDate}>{todayLabel}</Text>
          </View>
          <View style={ss.kpiRow}>
            <View style={ss.kpi}>
              <Text style={ss.kpiValue}>{openCount}</Text>
              <Text style={ss.kpiLabel}>Open</Text>
            </View>
            <View style={ss.kpi}>
              <Text style={[ss.kpiValue, { color: colors.warning }]}>{atRiskCount}</Text>
              <Text style={ss.kpiLabel}>At-Risk</Text>
            </View>
            <View style={ss.kpi}>
              <Text style={[ss.kpiValue, { color: '#FF7A7A' }]}>{staleCount}</Text>
              <Text style={ss.kpiLabel}>Stale</Text>
            </View>
          </View>
        </View>

      {/* Loading */}
      {tasks.isLoading && (
        <View style={ss.msgCard}>
          <Text style={ss.msgText}>Loading task deck…</Text>
        </View>
      )}

      {/* Error */}
      {tasks.error && (
        <View style={ss.msgCard}>
          <Text style={ss.errText}>
            Unable to load task deck.
            {tasks.error instanceof Error ? ` (${tasks.error.message})` : ''}
          </Text>
        </View>
      )}

      {/* Cards */}
      {tasks.data?.map((task, i) => (
        <TaskSwipeCard
          key={task.id}
          task={task}
          index={i}
          colors={colors}
          mode={mode}
          onDone={(id) => doneMutation.mutate(id)}
          onSnooze={(id) => snoozeMutation.mutate(id)}
          onOpenLead={openLead}
          onSwipeStart={() => setSwipeCount((c) => c + 1)}
          onSwipeEnd={() => setSwipeCount((c) => Math.max(0, c - 1))}
        />
      ))}

      {/* Empty state */}
        {!tasks.isLoading && !tasks.error && openCount === 0 && (
          <View style={ss.empty}>
            <Feather name="check-circle" size={36} color={colors.accent} style={{ marginBottom: 12 }} />
            <Text style={ss.emptyTitle}>Deck Cleared</Text>
            <Text style={ss.emptySub}>No open tasks right now. Check back after the next sync.</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/* ────────────────────────────────────────────────────────────
   Card Styles
   ──────────────────────────────────────────────────────────── */

function cardStyles(colors: TabThemeColors, mode: 'dark' | 'light') {
  const cardBg = mode === 'dark' ? '#101A2E' : '#F7F9FC';
  const cardBorder = mode === 'dark' ? '#213452' : '#D4DEEE';

  return StyleSheet.create({
    wrapper: {
      marginBottom: 12,
      borderRadius: 18,
    },
    hintFull: {
      ...StyleSheet.absoluteFillObject,
      borderRadius: 18,
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
    },
    hintDone: {
      backgroundColor: colors.accent,
    },
    hintSnooze: {
      backgroundColor: colors.warning,
    },
    hintLabel: {
      color: colors.white,
      fontWeight: '800',
      fontSize: 14,
      letterSpacing: 0.3,
    },
    cardMotion: {
      borderRadius: 18,
    },
    card: {
      borderRadius: 18,
      borderWidth: 1,
      borderColor: cardBorder,
      backgroundColor: cardBg,
      padding: 16,
      shadowColor: '#040915',
      shadowOpacity: 0.18,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    topRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12,
    },
    pill: {
      borderRadius: 999,
      borderWidth: 1,
      paddingHorizontal: 10,
      paddingVertical: 4,
      backgroundColor: colors.surfaceMuted,
    },
    pillText: {
      fontSize: 11,
      fontWeight: '700',
    },
    due: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '600',
    },
    identity: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 8,
    },
    avatar: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.cardMuted,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: spacing.sm,
    },
    avatarLetter: {
      color: colors.text,
      fontWeight: '800',
      fontSize: 14,
    },
    identityText: {
      flex: 1,
    },
    contactName: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '700',
    },
    taskType: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '600',
      marginTop: 1,
    },
    summary: {
      color: colors.textSecondary,
      fontSize: 14,
      lineHeight: 20,
      marginBottom: 12,
    },
    actionsRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'center',
    },
    btn: {
      paddingHorizontal: 14,
      paddingVertical: 9,
      borderRadius: 10,
    },
    btnDone: {
      backgroundColor: colors.accent,
    },
    btnDoneLabel: {
      color: colors.white,
      fontWeight: '700',
      fontSize: 13,
    },
    btnSnooze: {
      backgroundColor: colors.cardMuted,
    },
    btnSnoozeLabel: {
      color: colors.text,
      fontWeight: '700',
      fontSize: 13,
    },
    btnOpen: {
      marginLeft: 'auto',
      backgroundColor: colors.surfaceMuted,
      borderWidth: 1,
      borderColor: colors.border,
    },
    btnOpenLabel: {
      color: colors.text,
      fontWeight: '700',
      fontSize: 13,
    },
  });
}

/* ────────────────────────────────────────────────────────────
   Screen Styles
   ──────────────────────────────────────────────────────────── */

function screenStyles(colors: TabThemeColors) {
  return StyleSheet.create({
    container: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: 120,
    },
    safeArea: {
      flex: 1,
      backgroundColor: colors.background,
    },
    hero: {
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      marginBottom: spacing.md,
    },
    heroTop: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: spacing.sm,
    },
    heroDate: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '600',
    },
    heroTitle: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '700',
    },
    kpiRow: {
      flexDirection: 'row',
      gap: spacing.md,
      marginTop: 2,
    },
    kpi: {
      flex: 1,
      alignItems: 'flex-start',
    },
    kpiLabel: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: '600',
    },
    kpiValue: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '700',
    },
    msgCard: {
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      padding: 16,
      marginBottom: 12,
    },
    msgText: {
      color: colors.text,
    },
    errText: {
      color: '#FF8A8A',
    },
    empty: {
      borderRadius: 22,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      padding: 32,
      alignItems: 'center',
    },
    emptyTitle: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '800',
    },
    emptySub: {
      color: colors.textSecondary,
      marginTop: spacing.xs,
      lineHeight: 20,
      textAlign: 'center',
    },
  });
}
