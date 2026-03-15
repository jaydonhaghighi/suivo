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
import { apiGet, apiPost, apiPut } from '../lib/api';
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

type VoiceMode = 'manual' | 'auto' | 'both';
type VoiceAssistantProvider = 'telnyx_ai' | 'openai_sip';

type VoiceLabLead = {
  id: string;
  state: string;
  source: string;
  contact: string | null;
  primary_phone: string | null;
  summary: string | null;
  voice_contact_status: string | null;
};

type VoiceLabConfig = {
  timezone: string;
  voice_qualification: {
    enabled: boolean;
    mode: VoiceMode;
    assistant_provider: VoiceAssistantProvider;
    assistant_model: string;
    assistant_voice: string;
    call_window_start: string;
    call_window_end: string;
    quiet_window_start: string;
    quiet_window_end: string;
    max_attempts: number;
    retry_schedule_minutes: number[];
  };
  dummy_leads: VoiceLabLead[];
};

type VoiceLabSession = {
  id: string;
  lead_id: string;
  trigger_mode: 'manual' | 'auto';
  status: 'queued' | 'dialing' | 'in_progress' | 'completed' | 'failed' | 'opt_out' | 'escalated' | 'unreachable' | 'cancelled';
  destination_number: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  summary: string | null;
  qualification_payload?: {
    qualification_status?: string;
    structured_profile?: Record<string, unknown>;
    recommended_next_action?: string;
    transcript_status?: string;
  };
  error_text: string | null;
  transcript_available: boolean;
  transcript_event_id: string | null;
  lead_state: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
};

type EmailIntakeDecision = 'create_lead' | 'needs_review' | 'reject';

type EmailReviewQueueItem = {
  intake_id: string;
  mailbox_connection_id: string;
  mailbox_email: string;
  provider: 'gmail' | 'outlook';
  provider_event_id: string;
  ingest_source: 'webhook' | 'poll' | 'backfill';
  sender_email: string;
  subject: string;
  score: number;
  decision: EmailIntakeDecision;
  decision_reasons: unknown;
  classifier?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  review_assignee_user_id?: string | null;
  review_status: 'none' | 'review_pending' | 'lead_created' | 'rejected';
  created_at: string;
  age_minutes: number;
  sla_minutes: number;
  sla_breached: boolean;
  body?: string;
  body_preview?: string;
};

type EmailIntakeReviewQueueResponse = {
  items: EmailReviewQueueItem[];
};

type EmailIntakeDailyRow = {
  day: string;
  provider: 'gmail' | 'outlook';
  ingest_source: 'webhook' | 'poll' | 'backfill';
  intake_count: number;
  create_lead_count: number;
  needs_review_count: number;
  rejected_count: number;
  pending_review_count: number;
  avg_score: number | null;
  shadow_disagreement_count: number;
};

type EmailIntakeCalibrationResponse = {
  window_days: number;
  daily: EmailIntakeDailyRow[];
  review_backlog: {
    pending_count: number;
    oldest_age_minutes: number;
  };
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

function formatDecisionLabel(value: EmailIntakeDecision): string {
  if (value === 'create_lead') return 'Create Lead';
  if (value === 'needs_review') return 'Needs Review';
  return 'Reject';
}

export default function AdminScreen(): JSX.Element {
  const { colors, mode } = useTabTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const canLoadAdmin = currentUser.effectiveRole === 'TEAM_LEAD';
  const canLoadIntakeReview = currentUser.effectiveRole === 'TEAM_LEAD' || currentUser.effectiveRole === 'AGENT';
  const [draftByTask, setDraftByTask] = useState<Record<string, AssignDraft>>({});
  const [assignmentModal, setAssignmentModal] = useState<AssignmentModalState | null>(null);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [modalDraft, setModalDraft] = useState<AssignDraft>({
    assignee_user_id: '',
    reason: ''
  });
  const [reviewReasonByIntake, setReviewReasonByIntake] = useState<Record<string, string>>({});
  const [selectedVoiceLeadId, setSelectedVoiceLeadId] = useState('');
  const [voiceDestinationNumber, setVoiceDestinationNumber] = useState('');
  const [voiceFormError, setVoiceFormError] = useState<string | null>(null);
  const [transcriptModalSession, setTranscriptModalSession] = useState<VoiceLabSession | null>(null);
  const [transcriptReason, setTranscriptReason] = useState('');
  const [transcriptOutput, setTranscriptOutput] = useState<{
    sessionId: string;
    transcript: string | null;
    transcriptStatus: string;
  } | null>(null);

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
  const emailReviewQueue = useQuery({
    queryKey: ['email-intake-review-queue'],
    queryFn: () =>
      apiGet<EmailIntakeReviewQueueResponse>(
        '/intake/emails/review-queue?limit=100&include_body=false'
      ),
    enabled: canLoadIntakeReview
  });
  const emailIntakeCalibration = useQuery({
    queryKey: ['email-intake-calibration'],
    queryFn: () =>
      apiGet<EmailIntakeCalibrationResponse>(
        '/intake/emails/calibration/daily?days=14'
      ),
    enabled: canLoadIntakeReview
  });
  const voiceLabConfig = useQuery({
    queryKey: ['voice-lab-config'],
    queryFn: () => apiGet<VoiceLabConfig>('/team/admin/voice-lab/config'),
    enabled: canLoadAdmin
  });
  const voiceLabSessions = useQuery({
    queryKey: ['voice-lab-sessions', selectedVoiceLeadId],
    queryFn: () =>
      apiGet<VoiceLabSession[]>(
        selectedVoiceLeadId
          ? `/team/admin/voice-lab/sessions?lead_id=${encodeURIComponent(selectedVoiceLeadId)}`
          : '/team/admin/voice-lab/sessions'
      ),
    enabled: canLoadAdmin
  });

  useEffect(() => {
    const leads = voiceLabConfig.data?.dummy_leads ?? [];
    if (!leads.length) {
      return;
    }

    if (!selectedVoiceLeadId) {
      const firstLead = leads[0];
      if (!firstLead) {
        return;
      }
      setSelectedVoiceLeadId(firstLead.id);
      if (firstLead.primary_phone) {
        setVoiceDestinationNumber(firstLead.primary_phone);
      }
    }
  }, [voiceLabConfig.data?.dummy_leads, selectedVoiceLeadId]);

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
  const intakeDecisionMutation = useMutation({
    mutationFn: (payload: { intakeId: string; action: 'approve' | 'reject'; reason?: string }) =>
      apiPost(`/intake/emails/${payload.intakeId}/${payload.action}`, {
        reason: payload.reason?.trim() ? payload.reason.trim() : undefined
      }),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['email-intake-review-queue'] }),
        queryClient.invalidateQueries({ queryKey: ['email-intake-calibration'] }),
        queryClient.invalidateQueries({ queryKey: ['task-deck'] })
      ]);

      setReviewReasonByIntake((current) => {
        const next = { ...current };
        delete next[variables.intakeId];
        return next;
      });
    }
  });
  const voiceConfigMutation = useMutation({
    mutationFn: (patch: Partial<VoiceLabConfig['voice_qualification']>) =>
      apiPut<Record<string, unknown>>('/team/admin/voice-lab/config', patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['voice-lab-config'] });
    }
  });
  const voiceSessionMutation = useMutation({
    mutationFn: (payload: { leadId: string; destinationNumber: string }) =>
      apiPost<Record<string, unknown>>('/team/admin/voice-lab/sessions', {
        lead_id: payload.leadId,
        destination_number: payload.destinationNumber
      }),
    onSuccess: async () => {
      setVoiceFormError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['voice-lab-sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['voice-lab-config'] })
      ]);
    }
  });
  const transcriptMutation = useMutation({
    mutationFn: (payload: { sessionId: string; reason: string }) =>
      apiGet<{ transcript: string | null; transcript_status: string }>(
        `/team/admin/voice-lab/sessions/${payload.sessionId}/transcript?reason=${encodeURIComponent(payload.reason)}`
      ),
    onSuccess: (data, variables) => {
      setTranscriptOutput({
        sessionId: variables.sessionId,
        transcript: data.transcript,
        transcriptStatus: data.transcript_status
      });
      setTranscriptModalSession(null);
      setTranscriptReason('');
    }
  });

  const loadError = firstErrorMessage([
    currentUser.effectiveRole ? null : currentUser.error,
    agents.error,
    intakeQueue.error,
    assignedQueue.error,
    reassignQueue.error,
    emailReviewQueue.error,
    emailIntakeCalibration.error,
    voiceLabConfig.error,
    voiceLabSessions.error,
    voiceSessionMutation.error,
    voiceConfigMutation.error
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

  function updateReviewReason(intakeId: string, value: string): void {
    setReviewReasonByIntake((current) => ({
      ...current,
      [intakeId]: value
    }));
  }

  function submitIntakeDecision(intakeId: string, action: 'approve' | 'reject'): void {
    if (intakeDecisionMutation.isPending) {
      return;
    }

    intakeDecisionMutation.mutate({
      intakeId,
      action,
      reason: reviewReasonByIntake[intakeId]
    });
  }

  function updateVoiceMode(modeValue: VoiceMode): void {
    voiceConfigMutation.mutate({ mode: modeValue });
  }

  function updateVoiceProvider(provider: VoiceAssistantProvider): void {
    voiceConfigMutation.mutate({ assistant_provider: provider });
  }

  function toggleVoiceEnabled(): void {
    const enabled = voiceLabConfig.data?.voice_qualification.enabled ?? true;
    voiceConfigMutation.mutate({ enabled: !enabled });
  }

  function onSelectVoiceLead(lead: VoiceLabLead): void {
    setSelectedVoiceLeadId(lead.id);
    setVoiceFormError(null);
    if (lead.primary_phone) {
      setVoiceDestinationNumber(lead.primary_phone);
    }
  }

  function submitVoiceSession(): void {
    if (!selectedVoiceLeadId) {
      setVoiceFormError('Pick a lead first, then start the call.');
      return;
    }

    const destination = voiceDestinationNumber.trim();
    if (!destination) {
      setVoiceFormError('Enter a destination number (example: +14165551234).');
      return;
    }

    setVoiceFormError(null);

    voiceSessionMutation.mutate({
      leadId: selectedVoiceLeadId,
      destinationNumber: destination
    });
  }

  function openTranscriptModal(session: VoiceLabSession): void {
    setTranscriptModalSession(session);
    setTranscriptReason('');
  }

  function closeTranscriptModal(): void {
    if (transcriptMutation.isPending) {
      return;
    }
    Keyboard.dismiss();
    setTranscriptModalSession(null);
    setTranscriptReason('');
  }

  function submitTranscriptRequest(): void {
    if (!transcriptModalSession) {
      return;
    }

    const reason = transcriptReason.trim();
    if (!reason) {
      return;
    }

    transcriptMutation.mutate({
      sessionId: transcriptModalSession.id,
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

  function renderEmailIntakeReviewCard(): JSX.Element {
    const items = emailReviewQueue.data?.items ?? [];
    const backlog = emailIntakeCalibration.data?.review_backlog;
    const calibrationRows = emailIntakeCalibration.data?.daily.slice(0, 3) ?? [];
    const decisionError = intakeDecisionMutation.error instanceof Error ? intakeDecisionMutation.error.message : null;

    return (
      <Card tone={mode}>
        <Text style={styles.sectionTitle}>Email Intake Review Queue ({items.length})</Text>

        {emailReviewQueue.isLoading || emailIntakeCalibration.isLoading ? (
          <Text style={styles.meta}>Loading intake review queue…</Text>
        ) : null}

        {backlog ? (
          <Text style={styles.meta}>
            Backlog: {backlog.pending_count} pending · oldest {backlog.oldest_age_minutes}m
          </Text>
        ) : null}

        {calibrationRows.map((row) => (
          <Text key={`${row.day}-${row.provider}-${row.ingest_source}`} style={styles.intakeCalibText}>
            {row.day} · {row.provider} · {row.ingest_source}: +{row.create_lead_count} / review {row.needs_review_count} / reject {row.rejected_count}
          </Text>
        ))}

        {!items.length && !emailReviewQueue.isLoading ? (
          <Text style={styles.meta}>No pending intake items.</Text>
        ) : null}

        {items.map((item) => {
          const reason = reviewReasonByIntake[item.intake_id] ?? '';
          const pending = intakeDecisionMutation.isPending && intakeDecisionMutation.variables?.intakeId === item.intake_id;
          const pendingAction = pending ? intakeDecisionMutation.variables?.action : null;
          const decisionColor =
            item.decision === 'create_lead'
              ? colors.accent
              : item.decision === 'needs_review'
                ? colors.warning
                : '#FF7A7A';

          return (
            <View key={item.intake_id} style={styles.intakeRow}>
              <View style={styles.intakeTopRow}>
                <Text style={styles.contact}>{item.sender_email}</Text>
                <View style={[styles.intakeDecisionPill, { borderColor: decisionColor }]}>
                  <Text style={[styles.intakeDecisionText, { color: decisionColor }]}>
                    {formatDecisionLabel(item.decision)}
                  </Text>
                </View>
              </View>

              <Text style={styles.summary}>{item.subject || '(No subject)'}</Text>
              <Text style={styles.meta}>
                Score {item.score} · Age {item.age_minutes}m · SLA {item.sla_minutes}m
                {item.sla_breached ? ' · Breached' : ''}
              </Text>
              <Text style={styles.meta}>
                {item.provider.toUpperCase()} · {item.ingest_source} · Mailbox {item.mailbox_email}
              </Text>
              {(item.body_preview ?? '').trim().length > 0 ? (
                <Text style={styles.intakeBodyPreview}>{item.body_preview}</Text>
              ) : null}

              <TextInput
                value={reason}
                onChangeText={(value) => updateReviewReason(item.intake_id, value)}
                placeholder="Optional decision note"
                placeholderTextColor={colors.textSecondary}
                style={[styles.input, styles.intakeReasonInput]}
              />

              <View style={styles.intakeActionRow}>
                <Pressable
                  style={[styles.intakeApproveButton, intakeDecisionMutation.isPending ? styles.disabled : null]}
                  onPress={() => submitIntakeDecision(item.intake_id, 'approve')}
                  disabled={intakeDecisionMutation.isPending}
                >
                  <Text style={styles.intakeApproveText}>
                    {pendingAction === 'approve' ? 'Approving…' : 'Approve'}
                  </Text>
                </Pressable>

                <Pressable
                  style={[styles.intakeRejectButton, intakeDecisionMutation.isPending ? styles.disabled : null]}
                  onPress={() => submitIntakeDecision(item.intake_id, 'reject')}
                  disabled={intakeDecisionMutation.isPending}
                >
                  <Text style={styles.intakeRejectText}>
                    {pendingAction === 'reject' ? 'Rejecting…' : 'Reject'}
                  </Text>
                </Pressable>
              </View>
            </View>
          );
        })}

        {decisionError ? <Text style={styles.error}>Review action failed: {decisionError}</Text> : null}
      </Card>
    );
  function updateVoiceMode(modeValue: VoiceMode): void {
    voiceConfigMutation.mutate({ mode: modeValue });
  }

  function updateVoiceProvider(provider: VoiceAssistantProvider): void {
    voiceConfigMutation.mutate({ assistant_provider: provider });
  }

  function toggleVoiceEnabled(): void {
    const enabled = voiceLabConfig.data?.voice_qualification.enabled ?? true;
    voiceConfigMutation.mutate({ enabled: !enabled });
  }

  function onSelectVoiceLead(lead: VoiceLabLead): void {
    setSelectedVoiceLeadId(lead.id);
    setVoiceFormError(null);
    if (lead.primary_phone) {
      setVoiceDestinationNumber(lead.primary_phone);
    }
  }

  function submitVoiceSession(): void {
    if (!selectedVoiceLeadId) {
      setVoiceFormError('Pick a lead first, then start the call.');
      return;
    }

    const destination = voiceDestinationNumber.trim();
    if (!destination) {
      setVoiceFormError('Enter a destination number (example: +14165551234).');
      return;
    }

    setVoiceFormError(null);

    voiceSessionMutation.mutate({
      leadId: selectedVoiceLeadId,
      destinationNumber: destination
    });
  }

  function openTranscriptModal(session: VoiceLabSession): void {
    setTranscriptModalSession(session);
    setTranscriptReason('');
  }

  function closeTranscriptModal(): void {
    if (transcriptMutation.isPending) {
      return;
    }
    Keyboard.dismiss();
    setTranscriptModalSession(null);
    setTranscriptReason('');
  }

  function submitTranscriptRequest(): void {
    if (!transcriptModalSession) {
      return;
    }

    const reason = transcriptReason.trim();
    if (!reason) {
      return;
    }

    transcriptMutation.mutate({
      sessionId: transcriptModalSession.id,
      reason
    });
  }

  function renderTranscriptModal(): JSX.Element {
    const errorMessage = transcriptMutation.error instanceof Error ? transcriptMutation.error.message : null;

    return (
      <Modal
        visible={Boolean(transcriptModalSession)}
        transparent
        animationType="slide"
        onRequestClose={closeTranscriptModal}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 12 : 0}
        >
          <Pressable style={styles.modalOverlay} onPress={closeTranscriptModal} />
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Transcript Access Reason</Text>
            <Text style={styles.modalMeta}>
              Team Lead raw transcript access is available only for stale leads.
            </Text>
            <Text style={styles.label}>Reason</Text>
            <TextInput
              value={transcriptReason}
              onChangeText={setTranscriptReason}
              placeholder="Required reason for audit log"
              placeholderTextColor={colors.textSecondary}
              style={styles.input}
              multiline
            />
            {errorMessage ? <Text style={styles.error}>Transcript request failed: {errorMessage}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancelButton} onPress={closeTranscriptModal} disabled={transcriptMutation.isPending}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.modalSubmitButton}
                onPress={submitTranscriptRequest}
                disabled={transcriptMutation.isPending}
              >
                <Text style={styles.modalSubmitText}>{transcriptMutation.isPending ? 'Loading…' : 'Open Transcript'}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    );
  }

  function renderVoiceLabCard(): JSX.Element {
    const config = voiceLabConfig.data?.voice_qualification;
    const leads = voiceLabConfig.data?.dummy_leads ?? [];
    const selectedLead = leads.find((lead) => lead.id === selectedVoiceLeadId) ?? null;
    const sessions = voiceLabSessions.data ?? [];
    const voiceError = firstErrorMessage([voiceLabConfig.error, voiceLabSessions.error, voiceSessionMutation.error, transcriptMutation.error]);
    const canStartVoiceSession = Boolean(selectedVoiceLeadId) && Boolean(voiceDestinationNumber.trim());

    return (
      <Card tone={mode}>
        <Text style={styles.sectionTitle}>Voice Lab</Text>
        <Text style={styles.meta}>
          Mode: {config?.mode ?? 'n/a'} | Enabled: {config?.enabled ? 'yes' : 'no'} | Timezone: {voiceLabConfig.data?.timezone ?? 'UTC'}
        </Text>
        <Text style={styles.meta}>
          Provider: {config?.assistant_provider ?? 'n/a'} | Model: {config?.assistant_model ?? 'n/a'} | Voice: {config?.assistant_voice ?? 'n/a'}
        </Text>
        <Text style={styles.meta}>
          Call window {config?.call_window_start ?? '09:00'}-{config?.call_window_end ?? '20:00'} | Quiet {config?.quiet_window_start ?? '12:00'}-{config?.quiet_window_end ?? '13:30'}
        </Text>

        <View style={styles.voiceModeRow}>
          {(['manual', 'auto', 'both'] as VoiceMode[]).map((modeValue) => (
            <Pressable
              key={modeValue}
              style={[
                styles.voiceModeButton,
                config?.mode === modeValue ? styles.voiceModeButtonActive : null
              ]}
              onPress={() => updateVoiceMode(modeValue)}
              disabled={voiceConfigMutation.isPending}
            >
              <Text style={styles.voiceModeButtonText}>{modeValue.toUpperCase()}</Text>
            </Pressable>
          ))}
          <Pressable
            style={[styles.voiceModeButton, config?.enabled ? styles.voiceModeButtonActive : null]}
            onPress={toggleVoiceEnabled}
            disabled={voiceConfigMutation.isPending}
          >
            <Text style={styles.voiceModeButtonText}>{config?.enabled ? 'DISABLE' : 'ENABLE'}</Text>
          </Pressable>
        </View>

        <View style={styles.voiceModeRow}>
          {(['openai_sip', 'telnyx_ai'] as VoiceAssistantProvider[]).map((providerValue) => (
            <Pressable
              key={providerValue}
              style={[
                styles.voiceModeButton,
                config?.assistant_provider === providerValue ? styles.voiceModeButtonActive : null
              ]}
              onPress={() => updateVoiceProvider(providerValue)}
              disabled={voiceConfigMutation.isPending}
            >
              <Text style={styles.voiceModeButtonText}>{providerValue.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>Pick Dummy Lead</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.voiceLeadList}>
          {leads.map((lead) => (
            <Pressable
              key={lead.id}
              style={[
                styles.voiceLeadChip,
                selectedVoiceLeadId === lead.id ? styles.voiceLeadChipSelected : null
              ]}
              onPress={() => onSelectVoiceLead(lead)}
            >
              <Text style={styles.voiceLeadChipText}>{lead.contact ?? lead.id.slice(0, 8)}</Text>
              <Text style={styles.voiceLeadChipMeta}>{lead.state} · {lead.source}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {!leads.length ? <Text style={styles.meta}>No leads available in Voice Lab yet.</Text> : null}

        <Text style={styles.meta}>
          Selected lead: {selectedLead?.contact ?? selectedLead?.id ?? 'None selected'}
        </Text>

        <Text style={styles.label}>Destination Phone (E.164)</Text>
        <TextInput
          value={voiceDestinationNumber}
          onChangeText={(value) => {
            setVoiceDestinationNumber(value);
            if (voiceFormError) {
              setVoiceFormError(null);
            }
          }}
          placeholder="+15551234567"
          placeholderTextColor={colors.textSecondary}
          style={styles.input}
        />
        <Pressable
          style={styles.voiceStartButton}
          onPress={submitVoiceSession}
          disabled={voiceSessionMutation.isPending}
        >
          <Text style={styles.voiceStartButtonText}>
            {voiceSessionMutation.isPending ? 'Starting…' : 'Start Manual AI Call'}
          </Text>
        </Pressable>
        {!canStartVoiceSession ? (
          <Text style={styles.meta}>Select a lead and enter a destination number to start a call.</Text>
        ) : null}
        {voiceFormError ? <Text style={styles.error}>{voiceFormError}</Text> : null}
        {voiceSessionMutation.error instanceof Error ? <Text style={styles.error}>{voiceSessionMutation.error.message}</Text> : null}
        {voiceError ? <Text style={styles.error}>{voiceError}</Text> : null}

        <Text style={styles.sectionTitle}>Session Timeline ({sessions.length})</Text>
        {!sessions.length ? <Text style={styles.meta}>No voice sessions yet.</Text> : null}
        {sessions.map((session) => {
          const canRequestTranscript = session.lead_state === 'Stale' && session.transcript_available;
          return (
            <View key={session.id} style={styles.voiceSessionRow}>
              <Text style={styles.contact}>Status: {session.status}</Text>
              <Text style={styles.meta}>
                Trigger: {session.trigger_mode} | Attempt {session.attempt_count}/{session.max_attempts}
              </Text>
              <Text style={styles.meta}>
                Destination: {session.destination_number} | Lead State: {session.lead_state ?? 'n/a'}
              </Text>
              <Text style={styles.meta}>
                Created: {formatDue(session.created_at)} | Next: {formatDue(session.next_attempt_at)}
              </Text>
              {session.summary ? <Text style={styles.summary}>{session.summary}</Text> : null}
              {session.error_text ? <Text style={styles.error}>Error: {session.error_text}</Text> : null}
              <View style={styles.voiceSessionActions}>
                <Pressable
                  style={[styles.voiceTranscriptButton, canRequestTranscript ? null : styles.voiceTranscriptButtonDisabled]}
                  onPress={() => openTranscriptModal(session)}
                  disabled={!canRequestTranscript}
                >
                  <Text style={styles.voiceTranscriptButtonText}>
                    {canRequestTranscript ? 'View Transcript' : 'Transcript (Stale only)'}
                  </Text>
                </Pressable>
              </View>
            </View>
          );
        })}

        {transcriptOutput ? (
          <View style={styles.voiceTranscriptOutput}>
            <Text style={styles.sectionTitle}>Transcript Output</Text>
            <Text style={styles.meta}>
              Session: {transcriptOutput.sessionId} | Status: {transcriptOutput.transcriptStatus}
            </Text>
            <Text style={styles.summary}>{transcriptOutput.transcript ?? 'No transcript available.'}</Text>
          </View>
        ) : null}
      </Card>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.heading}>Admin Routing</Text>
        <Text style={styles.subtitle}>
          Email intake review plus broker-channel lead assignment and stale reassign workflow.
        </Text>

        {currentUser.isLoading && !currentUser.effectiveRole ? (
          <Card tone={mode}>
            <Text style={styles.meta}>Checking access…</Text>
          </Card>
        ) : null}

        {!currentUser.isLoading && currentUser.effectiveRole && !canLoadIntakeReview ? (
          <Card tone={mode}>
            <Text style={styles.error}>Access is restricted to Agents and Team Leads.</Text>
          </Card>
        ) : null}

        {loadError ? (
          <Card tone={mode}>
            <Text style={styles.error}>Unable to load admin data. {loadError}</Text>
            <Text style={styles.meta}>This screen requires Agent or Team Lead access.</Text>
          </Card>
        ) : null}

        {assignMutation.error instanceof Error ? (
          <Card tone={mode}>
            <Text style={styles.error}>Assignment failed: {assignMutation.error.message}</Text>
          </Card>
        ) : null}

        {canLoadIntakeReview ? (
          <>
            {renderEmailIntakeReviewCard()}
            {canLoadAdmin ? (
              <>
                {renderVoiceLabCard()}
                {renderQueueCard('Incoming Broker Queue', intakeQueue.data, true)}
                {renderQueueCard('Assigned Broker Leads', assignedQueue.data, false)}
                {renderQueueCard('Stale Reassign Queue', reassignQueue.data, true)}
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>
      {renderAssignModal()}
      {renderTranscriptModal()}
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
    intakeCalibText: {
      color: colors.textSecondary,
      marginTop: spacing.xs,
      fontSize: 12
    },
    intakeRow: {
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceMuted,
      padding: 12,
      marginTop: spacing.sm
    },
    intakeTopRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: spacing.sm
    },
    intakeDecisionPill: {
      borderRadius: 999,
      borderWidth: 1,
      paddingHorizontal: 9,
      paddingVertical: 3,
      backgroundColor: colors.surface
    },
    intakeDecisionText: {
      fontSize: 11,
      fontWeight: '700'
    },
    intakeBodyPreview: {
      color: colors.textSecondary,
      marginTop: spacing.xs,
      fontSize: 12,
      lineHeight: 18
    },
    intakeReasonInput: {
      marginTop: spacing.sm
    },
    intakeActionRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.sm
    },
    intakeApproveButton: {
      flex: 1,
      borderRadius: 10,
      backgroundColor: colors.accent,
      paddingVertical: 10,
      alignItems: 'center'
    },
    intakeApproveText: {
      color: colors.white,
      fontWeight: '800'
    },
    intakeRejectButton: {
      flex: 1,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingVertical: 10,
      alignItems: 'center'
    },
    intakeRejectText: {
      color: colors.text,
      fontWeight: '700'
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
    voiceModeRow: {
      flexDirection: 'row',
      gap: 8,
      marginTop: spacing.sm,
      marginBottom: spacing.sm,
      flexWrap: 'wrap'
    },
    voiceModeButton: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: 10,
      paddingVertical: 8
    },
    voiceModeButtonActive: {
      borderColor: colors.primary,
      backgroundColor: colors.cardMuted
    },
    voiceModeButtonText: {
      color: colors.text,
      fontSize: 11,
      fontWeight: '700'
    },
    voiceLeadList: {
      gap: 8,
      paddingVertical: 8
    },
    voiceLeadChip: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      minWidth: 130,
      backgroundColor: colors.surfaceMuted
    },
    voiceLeadChipSelected: {
      borderColor: colors.primary,
      backgroundColor: colors.cardMuted
    },
    voiceLeadChipText: {
      color: colors.text,
      fontWeight: '700',
      fontSize: 12
    },
    voiceLeadChipMeta: {
      color: colors.textSecondary,
      fontSize: 11,
      marginTop: 2
    },
    voiceStartButton: {
      borderRadius: 10,
      backgroundColor: colors.primary,
      paddingVertical: 11,
      alignItems: 'center',
      marginTop: spacing.sm
    },
    voiceStartButtonText: {
      color: colors.white,
      fontWeight: '800'
    },
    voiceSessionRow: {
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceMuted,
      padding: 12,
      marginTop: spacing.sm
    },
    voiceSessionActions: {
      marginTop: spacing.sm
    },
    voiceTranscriptButton: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.primary,
      backgroundColor: colors.surface,
      paddingVertical: 9,
      alignItems: 'center'
    },
    voiceTranscriptButtonDisabled: {
      borderColor: colors.border
    },
    voiceTranscriptButtonText: {
      color: colors.text,
      fontSize: 12,
      fontWeight: '700'
    },
    voiceTranscriptOutput: {
      marginTop: spacing.md,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      padding: 10
    },
    error: {
      color: '#FF8A8A',
      fontWeight: '700'
    },
    disabled: {
      opacity: 0.6
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
