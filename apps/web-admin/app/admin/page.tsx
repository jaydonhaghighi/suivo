import { revalidatePath } from 'next/cache';

import { Card } from '../../components/card';
import { apiGet, apiPost } from '../../lib/api';

type AssignableAgent = {
  id: string;
  role: 'AGENT';
  language: string;
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

async function assignLeadAction(formData: FormData): Promise<void> {
  'use server';

  const taskId = String(formData.get('task_id') ?? '');
  const assigneeUserId = String(formData.get('assignee_user_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  if (!taskId || !assigneeUserId || !reason) {
    return;
  }

  await apiPost(`/team/admin/tasks/${taskId}/assign`, {
    assignee_user_id: assigneeUserId,
    reason
  });

  revalidatePath('/admin');
}

function LeadRow({
  title,
  item,
  agents,
  actionLabel
}: {
  title: string;
  item: QueueItem;
  agents: AssignableAgent[];
  actionLabel: string;
}): JSX.Element {
  return (
    <div style={{ border: '1px solid #d8d2c7', borderRadius: 12, padding: 14, background: '#fff', marginBottom: 10 }}>
      <p style={{ margin: 0, fontWeight: 700, color: '#1A3B2E' }}>{title}</p>
      <p style={{ margin: '6px 0 0 0', color: '#444' }}>
        {item.summary ?? 'No summary available'}
      </p>
      <p style={{ margin: '6px 0 0 0', color: '#666', fontSize: 13 }}>
        State: {item.lead_state} | Task: {item.task_type ?? 'n/a'} | Owner: {item.owner_agent_id}
      </p>
      <p style={{ margin: '4px 0 0 0', color: '#666', fontSize: 13 }}>
        Contact: {item.primary_email ?? 'no email'} / {item.primary_phone ?? 'no phone'}
      </p>
      {item.latest_event ? (
        <p style={{ margin: '4px 0 0 0', color: '#666', fontSize: 13 }}>
          Latest event: {item.latest_event.channel} {item.latest_event.type} ({item.latest_event.direction})
        </p>
      ) : null}
      {item.task_id ? (
        <form action={assignLeadAction} style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          <input type="hidden" name="task_id" value={item.task_id} />
          <select
            name="assignee_user_id"
            defaultValue=""
            required
            style={{ padding: 8, borderRadius: 8, border: '1px solid #bbb' }}
          >
            <option value="" disabled>
              Select assignee
            </option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.id} ({agent.language})
              </option>
            ))}
          </select>
          <input
            type="text"
            name="reason"
            required
            placeholder="Reason for assignment"
            style={{ padding: 8, borderRadius: 8, border: '1px solid #bbb' }}
          />
          <button
            type="submit"
            style={{
              padding: 10,
              borderRadius: 10,
              border: 'none',
              background: '#1F7A4C',
              color: '#fff',
              fontWeight: 700
            }}
          >
            {actionLabel}
          </button>
        </form>
      ) : (
        <p style={{ margin: '10px 0 0 0', color: '#b35c00' }}>No open task available for reassignment.</p>
      )}
    </div>
  );
}

export default async function AdminPage(): Promise<JSX.Element> {
  const [agents, intakeQueue, assignedQueue, reassignQueue] = await Promise.all([
    apiGet<AssignableAgent[]>('/team/admin/agents'),
    apiGet<QueueItem[]>('/team/admin/intake-queue'),
    apiGet<QueueItem[]>('/team/admin/assigned-queue'),
    apiGet<QueueItem[]>('/team/admin/reassign-queue')
  ]);

  return (
    <div>
      <h1 style={{ fontSize: 36, marginBottom: 8, color: '#1A3B2E' }}>Broker Admin Routing</h1>
      <p style={{ color: '#5a5a5a', marginTop: 0 }}>
        Broker-channel leads are shown here. Agent-direct leads are excluded by origin filter.
      </p>

      <Card>
        <h2 style={{ marginTop: 0 }}>Incoming Broker Queue ({intakeQueue.length})</h2>
        {intakeQueue.length === 0 ? <p>No unassigned broker-channel tasks.</p> : null}
        {intakeQueue.map((item) => (
          <LeadRow key={`intake-${item.lead_id}-${item.task_id ?? 'none'}`} title="Incoming" item={item} agents={agents} actionLabel="Assign to Agent" />
        ))}
      </Card>

      <Card>
        <h2 style={{ marginTop: 0 }}>Assigned Broker Leads ({assignedQueue.length})</h2>
        {assignedQueue.length === 0 ? <p>No active broker-assigned leads.</p> : null}
        {assignedQueue.map((item) => (
          <div
            key={`assigned-${item.lead_id}`}
            style={{ border: '1px solid #d8d2c7', borderRadius: 12, padding: 14, background: '#fff', marginBottom: 10 }}
          >
            <p style={{ margin: 0, fontWeight: 700, color: '#1A3B2E' }}>Assigned Lead</p>
            <p style={{ margin: '6px 0 0 0', color: '#444' }}>{item.summary ?? 'No summary available'}</p>
            <p style={{ margin: '6px 0 0 0', color: '#666', fontSize: 13 }}>
              State: {item.lead_state} | Owner: {item.owner_agent_id}
            </p>
          </div>
        ))}
      </Card>

      <Card>
        <h2 style={{ marginTop: 0 }}>Stale Reassign Queue ({reassignQueue.length})</h2>
        <p style={{ color: '#555' }}>
          Leads assigned by broker that hit the stale threshold are listed here for reassignment.
        </p>
        {reassignQueue.length === 0 ? <p>No stale broker-assigned leads to reassign.</p> : null}
        {reassignQueue.map((item) => (
          <LeadRow key={`reassign-${item.lead_id}-${item.task_id ?? 'none'}`} title="Needs Reassignment" item={item} agents={agents} actionLabel="Reassign Lead" />
        ))}
      </Card>
    </div>
  );
}
