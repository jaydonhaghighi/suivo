import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '../components/card';
import { apiGet, apiPost } from '../lib/api';
import { useCurrentUser } from '../lib/current-user';
import { spacing } from '../lib/theme';
import { TabThemeColors, useTabTheme } from '../lib/tab-theme';

type AssignableAgent = {
  id: string;
  role: 'AGENT';
  language: string;
  display_name?: string | null;
};

type QueueItem = {
  task_id: string | null;
  lead_id: string;
  lead_state: string;
  owner_agent_id: string;
  task_type: string | null;
  due_at: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  summary: string | null;
  latest_event?: {
    channel: string;
    type: string;
    direction: string;
    created_at: string;
  } | null;
};

type AssignDraft = {
  assignee_user_id: string;
  reason: string;
};

type AssignmentModalState = {
  taskId: string;
  actionLabel: string;
};

function formatDue(value: string | null): string {
  if (!value) return 'No due date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No due date';
  return date.toLocaleString();
}

function firstErrorMessage(errors: Array<unknown>): string | null {
  for (const error of errors) {
    if (error instanceof Error && error.message) {
      return error.message;
    }
  }
  return null;
}

export default function AdminScreen(): JSX.Element {
  const { colors, mode } = useTabTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const canLoadAdmin = currentUser.effectiveRole === 'TEAM_LEAD';
  const [draftByTask, setDraftByTask] = useState<Record<string, AssignDraft>>({});
  const [assignmentModal, setAssignmentModal] = useState<AssignmentModalState | null>(null);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [modalDraft, setModalDraft] = useState<AssignDraft>({
    assignee_user_id: '',
    reason: ''
  });

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showListener = Keyboard.addListener(showEvent, () => setIsKeyboardVisible(true));
    const hideListener = Keyboard.addListener(hideEvent, () => setIsKeyboardVisible(false));

    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);

  const agents = useQuery({
    queryKey: ['admin-agents'],
    queryFn: () => apiGet<AssignableAgent[]>('/team/admin/agents'),
    enabled: canLoadAdmin
  });
  const intakeQueue = useQuery({
    queryKey: ['admin-intake-queue'],
    queryFn: () => apiGet<QueueItem[]>('/team/admin/intake-queue'),
    enabled: canLoadAdmin
  });
  const assignedQueue = useQuery({
    queryKey: ['admin-assigned-queue'],
    queryFn: () => apiGet<QueueItem[]>('/team/admin/assigned-queue'),
    enabled: canLoadAdmin
  });
  const reassignQueue = useQuery({
    queryKey: ['admin-reassign-queue'],
    queryFn: () => apiGet<QueueItem[]>('/team/admin/reassign-queue'),
    enabled: canLoadAdmin
  });

  const assignMutation = useMutation({
    mutationFn: (payload: { taskId: string; assigneeUserId: string; reason: string }) =>
      apiPost(`/team/admin/tasks/${payload.taskId}/assign`, {
        assignee_user_id: payload.assigneeUserId,
        reason: payload.reason
      }),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-intake-queue'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-assigned-queue'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-reassign-queue'] }),
        queryClient.invalidateQueries({ queryKey: ['task-deck'] })
      ]);

      setDraftByTask((current) => {
        const next = { ...current };
        delete next[variables.taskId];
        return next;
      });
      setAssignmentModal(null);
      setModalDraft({ assignee_user_id: '', reason: '' });
    }
  });

  const loadError = firstErrorMessage([
    currentUser.effectiveRole ? null : currentUser.error,
    agents.error,
    intakeQueue.error,
    assignedQueue.error,
    reassignQueue.error
  ]);

  const agentLabelById = useMemo(() => {
    const labels: Record<string, string> = {};

    for (const [index, agent] of (agents.data ?? []).entries()) {
      const preferredName = agent.display_name?.trim();
      labels[agent.id] = preferredName && preferredName.length > 0 ? preferredName : `Agent ${index + 1}`;
    }

    if (currentUser.data?.userId && currentUser.effectiveRole === 'TEAM_LEAD') {
      labels[currentUser.data.userId] = 'Team Lead';
    }

    return labels;
  }, [agents.data, currentUser.data?.userId, currentUser.effectiveRole]);

  function getAgentLabel(agentId: string | null | undefined, fallback = 'Assigned Agent'): string {
    if (!agentId) {
      return fallback;
    }
    return agentLabelById[agentId] ?? fallback;
  }

  function updateDraft(taskId: string, patch: Partial<AssignDraft>): void {
    setDraftByTask((current) => ({
      ...current,
      [taskId]: {
        assignee_user_id: current[taskId]?.assignee_user_id ?? '',
        reason: current[taskId]?.reason ?? '',
        ...patch
      }
    }));
  }

  function openAssignModal(item: QueueItem, title: string): void {
    if (!item.task_id) {
      return;
    }

    const existing = draftByTask[item.task_id];
    setAssignmentModal({
      taskId: item.task_id,
      actionLabel: title.includes('Reassign') ? 'Reassign Lead' : 'Assign Lead'
    });
    setModalDraft({
      assignee_user_id: existing?.assignee_user_id ?? '',
      reason: existing?.reason ?? ''
    });
  }

  function closeAssignModal(): void {
    if (assignMutation.isPending) {
      return;
    }
    Keyboard.dismiss();
    setIsKeyboardVisible(false);
    setAssignmentModal(null);
  }

  function onModalBackdropPress(): void {
    if (isKeyboardVisible) {
      Keyboard.dismiss();
      return;
    }
    closeAssignModal();
  }

  function submitModalAssignment(): void {
    if (!assignmentModal) {
      return;
    }

    const assigneeUserId = modalDraft.assignee_user_id.trim();
    const reason = modalDraft.reason.trim();

    if (!assigneeUserId || !reason) {
      return;
    }

    updateDraft(assignmentModal.taskId, {
      assignee_user_id: assigneeUserId,
      reason
    });

    assignMutation.mutate({
      taskId: assignmentModal.taskId,
      assigneeUserId,
      reason
    });
  }

  function renderAssignModal(): JSX.Element {
    const selectedAgent = agents.data?.find((agent) => agent.id === modalDraft.assignee_user_id);
    const modalError = assignMutation.error instanceof Error ? assignMutation.error.message : null;

    return (
      <Modal
        visible={Boolean(assignmentModal)}
        transparent
        animationType="slide"
        onRequestClose={closeAssignModal}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 12 : 0}
        >
          <Pressable style={styles.modalOverlay} onPress={onModalBackdropPress} />
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>{assignmentModal?.actionLabel ?? 'Assign Lead'}</Text>
            <Text style={styles.modalMeta}>Select an agent from your team and enter a reason.</Text>

            <Text style={styles.label}>Pick Team Agent</Text>
            <ScrollView
              style={styles.modalAgentList}
              contentContainerStyle={styles.modalAgentListContent}
              keyboardShouldPersistTaps="handled"
            >
              {agents.data?.map((agent) => (
                <Pressable
                  key={agent.id}
                  style={[
                    styles.agentRow,
                    modalDraft.assignee_user_id === agent.id ? styles.agentRowSelected : null
                  ]}
                  onPress={() => setModalDraft((current) => ({ ...current, assignee_user_id: agent.id }))}
                >
                  <Text style={styles.agentRowId}>{getAgentLabel(agent.id)}</Text>
                  <Text style={styles.agentRowMeta}>{agent.role} · {agent.language.toUpperCase()}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <Text style={styles.selectedAgent}>
              {selectedAgent ? `Selected: ${getAgentLabel(selectedAgent.id)}` : 'No assignee selected'}
            </Text>

            <Text style={styles.label}>Reason</Text>
            <TextInput
              value={modalDraft.reason}
              onChangeText={(value) => setModalDraft((current) => ({ ...current, reason: value }))}
              placeholder="Reason for assignment"
              placeholderTextColor={colors.textSecondary}
              style={styles.input}
              returnKeyType="done"
              onSubmitEditing={Keyboard.dismiss}
            />

            {modalError ? <Text style={styles.error}>Assignment failed: {modalError}</Text> : null}

            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalCancelButton}
                onPress={closeAssignModal}
                disabled={assignMutation.isPending}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.modalSubmitButton}
                onPress={submitModalAssignment}
                disabled={assignMutation.isPending}
              >
                <Text style={styles.modalSubmitText}>
                  {assignMutation.isPending ? 'Saving…' : assignmentModal?.actionLabel ?? 'Assign Lead'}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    );
  }

  function renderQueueCard(title: string, items: QueueItem[] | undefined, allowAssign: boolean): JSX.Element {
    return (
      <Card tone={mode}>
        <Text style={styles.sectionTitle}>
          {title} ({items?.length ?? 0})
        </Text>

        {!items?.length ? <Text style={styles.meta}>No leads in this queue.</Text> : null}

        {items?.map((item) => {
          const draft = item.task_id ? draftByTask[item.task_id] : undefined;
          const selectedAssignee = draft?.assignee_user_id ?? '';
          const reason = draft?.reason ?? '';

          return (
            <View key={`${title}-${item.lead_id}-${item.task_id ?? 'none'}`} style={styles.queueRow}>
              <Text style={styles.contact}>{item.primary_email ?? item.primary_phone ?? 'Unknown contact'}</Text>
              <Text style={styles.summary}>{item.summary ?? 'No summary available.'}</Text>
              <Text style={styles.meta}>
                State: {item.lead_state} | Task: {item.task_type ?? 'n/a'} | Due: {formatDue(item.due_at)}
              </Text>
              <Text style={styles.meta}>
                Owner:{' '}
                {getAgentLabel(
                  item.owner_agent_id,
                  item.owner_agent_id === currentUser.data?.userId && currentUser.effectiveRole === 'TEAM_LEAD'
                    ? 'Team Lead'
                    : 'Assigned Agent'
                )}
              </Text>

              {allowAssign && item.task_id ? (
                <View style={styles.assignBox}>
                  <Pressable
                    style={styles.assignButton}
                    onPress={() => openAssignModal(item, title)}
                    disabled={assignMutation.isPending}
                  >
                    <Text style={styles.assignButtonText}>
                      {title.includes('Reassign') ? 'Reassign Lead' : 'Assign Lead'}
                    </Text>
                  </Pressable>
                  {selectedAssignee ? (
                    <Text style={styles.meta}>Draft assignee: {getAgentLabel(selectedAssignee)}</Text>
                  ) : null}
                  {reason ? <Text style={styles.meta}>Draft reason saved</Text> : null}
                </View>
              ) : null}
            </View>
          );
        })}
      </Card>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.heading}>Admin Routing</Text>
        <Text style={styles.subtitle}>
          Broker-channel lead assignment and stale reassign workflow.
        </Text>

        {currentUser.isLoading && !currentUser.effectiveRole ? (
          <Card tone={mode}>
            <Text style={styles.meta}>Checking access…</Text>
          </Card>
        ) : null}

        {!currentUser.isLoading && currentUser.effectiveRole && !canLoadAdmin ? (
          <Card tone={mode}>
            <Text style={styles.error}>Admin access is restricted to Team Leads.</Text>
          </Card>
        ) : null}

        {loadError ? (
          <Card tone={mode}>
            <Text style={styles.error}>Unable to load admin data. {loadError}</Text>
            <Text style={styles.meta}>This screen requires Team Lead access.</Text>
          </Card>
        ) : null}

        {assignMutation.error instanceof Error ? (
          <Card tone={mode}>
            <Text style={styles.error}>Assignment failed: {assignMutation.error.message}</Text>
          </Card>
        ) : null}

        {canLoadAdmin ? (
          <>
            {renderQueueCard('Incoming Broker Queue', intakeQueue.data, true)}
            {renderQueueCard('Assigned Broker Leads', assignedQueue.data, false)}
            {renderQueueCard('Stale Reassign Queue', reassignQueue.data, true)}
          </>
        ) : null}
      </ScrollView>
      {renderAssignModal()}
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
    queueRow: {
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceMuted,
      padding: 12,
      marginBottom: 10
    },
    contact: {
      color: colors.text,
      fontWeight: '700'
    },
    summary: {
      color: colors.text,
      marginTop: spacing.xs
    },
    meta: {
      color: colors.textSecondary,
      marginTop: spacing.xs,
      fontSize: 12
    },
    assignBox: {
      marginTop: spacing.sm
    },
    label: {
      color: colors.textSecondary,
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      fontWeight: '700',
      marginBottom: 4
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 10,
      backgroundColor: colors.surface,
      color: colors.text
    },
    assignButton: {
      borderRadius: 10,
      backgroundColor: colors.primary,
      paddingVertical: 10,
      alignItems: 'center'
    },
    assignButtonText: {
      color: colors.white,
      fontWeight: '800'
    },
    error: {
      color: '#FF8A8A',
      fontWeight: '700'
    },
    modalBackdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0, 0, 0, 0.45)'
    },
    modalOverlay: {
      flex: 1
    },
    modalSheet: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: 28,
      maxHeight: '78%'
    },
    modalTitle: {
      color: colors.text,
      fontSize: 22,
      fontWeight: '800'
    },
    modalMeta: {
      color: colors.textSecondary,
      marginTop: 3,
      fontSize: 12
    },
    modalAgentList: {
      marginTop: 8,
      maxHeight: 220
    },
    modalAgentListContent: {
      gap: 8
    },
    agentRow: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.surfaceMuted,
      paddingVertical: 10,
      paddingHorizontal: 12
    },
    agentRowSelected: {
      borderColor: colors.primary,
      backgroundColor: colors.cardMuted
    },
    agentRowId: {
      color: colors.text,
      fontWeight: '700',
      fontSize: 13
    },
    agentRowMeta: {
      color: colors.textSecondary,
      marginTop: 3,
      fontSize: 12
    },
    selectedAgent: {
      color: colors.textSecondary,
      marginTop: 8,
      marginBottom: 8,
      fontSize: 12
    },
    modalActions: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.md
    },
    modalCancelButton: {
      flex: 1,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingVertical: 12,
      alignItems: 'center'
    },
    modalSubmitButton: {
      flex: 1,
      borderRadius: 10,
      backgroundColor: colors.primary,
      paddingVertical: 12,
      alignItems: 'center'
    },
    modalCancelText: {
      color: colors.text,
      fontWeight: '700'
    },
    modalSubmitText: {
      color: colors.white,
      fontWeight: '800'
    }
  });
}
