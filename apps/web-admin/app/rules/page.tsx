import { redirect } from 'next/navigation';

import { apiGet, apiPut } from '../../lib/api';

type TeamRulesResponse = {
  stale_rules: {
    new_lead_sla_minutes: number;
    active_stale_hours: number;
    at_risk_threshold_percent: number;
    timezone: string;
  };
  sla_rules: {
    escalation_enabled: boolean;
    response_target_minutes: number;
  };
  escalation_rules: {
    broker_intake: {
      mailbox_connection_ids: string[];
      phone_number_ids: string[];
      stale_hours_for_assigned: number;
    };
  };
};

async function saveRulesAction(formData: FormData): Promise<void> {
  'use server';

  const threshold = Number(formData.get('at_risk_threshold_percent') ?? 80);
  const timezone = String(formData.get('timezone') ?? 'UTC');
  const mailboxCsv = String(formData.get('mailbox_connection_ids') ?? '');
  const phoneCsv = String(formData.get('phone_number_ids') ?? '');
  const staleHours = Number(formData.get('stale_hours_for_assigned') ?? 168);

  const mailboxConnectionIds = mailboxCsv
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const phoneNumberIds = phoneCsv
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  await apiPut('/team/rules', {
    at_risk_threshold_percent: threshold,
    timezone,
    broker_intake: {
      mailbox_connection_ids: mailboxConnectionIds,
      phone_number_ids: phoneNumberIds,
      stale_hours_for_assigned: staleHours
    }
  });

  redirect('/rules?saved=1');
}

export default async function RulesPage({
  searchParams
}: {
  searchParams?: Promise<{ saved?: string }>;
}): Promise<JSX.Element> {
  const rules = await apiGet<TeamRulesResponse>('/team/rules');
  const resolvedSearchParams = searchParams ? await searchParams : {};

  return (
    <div>
      <h1 style={{ fontSize: 36, marginBottom: 12, color: '#1A3B2E' }}>SLA / Escalation Rules</h1>
      <form action={saveRulesAction} style={{ display: 'grid', gap: 10, maxWidth: 620 }}>
        <label>
          At-Risk Threshold %
          <input
            type="number"
            min={1}
            max={99}
            name="at_risk_threshold_percent"
            defaultValue={rules.stale_rules.at_risk_threshold_percent}
            style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #bbb' }}
          />
        </label>
        <label>
          Timezone
          <input
            type="text"
            name="timezone"
            defaultValue={rules.stale_rules.timezone}
            style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #bbb' }}
          />
        </label>
        <label>
          Broker Intake Mailbox Connection IDs (comma-separated UUIDs)
          <textarea
            name="mailbox_connection_ids"
            defaultValue={rules.escalation_rules.broker_intake.mailbox_connection_ids.join(', ')}
            rows={3}
            style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #bbb' }}
          />
        </label>
        <label>
          Broker Intake Phone Number IDs (comma-separated UUIDs)
          <textarea
            name="phone_number_ids"
            defaultValue={rules.escalation_rules.broker_intake.phone_number_ids.join(', ')}
            rows={3}
            style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #bbb' }}
          />
        </label>
        <label>
          Broker-Assigned Stale Threshold (hours)
          <input
            type="number"
            min={1}
            name="stale_hours_for_assigned"
            defaultValue={rules.escalation_rules.broker_intake.stale_hours_for_assigned}
            style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #bbb' }}
          />
        </label>
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
          Save Rules
        </button>
        {resolvedSearchParams.saved ? <p style={{ color: '#1F7A4C' }}>Rules saved.</p> : null}
      </form>
    </div>
  );
}
