import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config as dotenvConfig } from 'dotenv';
import { Client } from 'pg';

import { loadEnv } from './load-env';

type BrokerLeadSeed = {
  id: string;
  ownerAgentId: string;
  state: 'New' | 'Active' | 'Stale';
  source: 'email' | 'sms' | 'call' | 'manual';
  primaryEmail: string | null;
  primaryPhone: string | null;
  lastTouchAt: string | null;
  nextActionAt: string | null;
  summary: string;
  fields: Record<string, unknown>;
  metrics: Record<string, unknown>;
  task: {
    id: string;
    type: 'contact_now' | 'follow_up' | 'rescue' | 'call_outcome' | 'manual';
    status: 'open' | 'done' | 'snoozed' | 'cancelled';
    dueAt: string;
    ownerId: string;
  };
  event: {
    id: string;
    channel: 'email' | 'sms' | 'call' | 'note' | 'system';
    type: string;
    direction: 'inbound' | 'outbound' | 'internal';
    createdAt: string;
  };
};

const DEFAULT_TEAM_ID = '00000000-0000-0000-0000-000000000010';
const DEFAULT_TEAM_LEAD_ID = '00000000-0000-0000-0000-000000000002';
const DEFAULT_AGENT_PRIMARY_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_AGENT_SECONDARY_ID = '00000000-0000-0000-0000-000000000003';

const defaultStaleRules = {
  new_lead_sla_minutes: 60,
  active_stale_hours: 48,
  at_risk_threshold_percent: 80,
  timezone: 'UTC'
};

const defaultSlaRules = {
  escalation_enabled: true,
  response_target_minutes: 60
};

const defaultBrokerIntakeRule = {
  mailbox_connection_ids: [],
  phone_number_ids: [],
  stale_hours_for_assigned: 168
};

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function hoursFromNow(hours: number): string {
  return minutesFromNow(hours * 60);
}

function envValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function loadMobileEnv(): void {
  const mobileEnvCandidates = ['../../apps/mobile/.env.local', '../../apps/mobile/.env'];
  for (const relativePath of mobileEnvCandidates) {
    const absolutePath = resolve(process.cwd(), relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    dotenvConfig({ path: absolutePath, override: false });
  }
}

async function applyRlsContext(
  client: Client,
  userId: string,
  teamId: string,
  role: 'AGENT' | 'TEAM_LEAD'
): Promise<void> {
  await client.query(
    `SELECT
      set_config('app.user_id', $1, false),
      set_config('app.team_id', $2, false),
      set_config('app.role', $3, false)`,
    [userId, teamId, role]
  );
}

async function main(): Promise<void> {
  loadEnv();
  loadMobileEnv();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const teamId = envValue('SEED_TEAM_ID', 'EXPO_PUBLIC_DEV_TEAM_ID') ?? DEFAULT_TEAM_ID;
  const teamLeadId = envValue('SEED_TEAM_LEAD_ID', 'EXPO_PUBLIC_DEV_USER_ID') ?? DEFAULT_TEAM_LEAD_ID;
  const agentPrimaryId = envValue('SEED_AGENT_PRIMARY_ID') ?? DEFAULT_AGENT_PRIMARY_ID;
  const agentSecondaryId = envValue('SEED_AGENT_SECONDARY_ID') ?? DEFAULT_AGENT_SECONDARY_ID;

  if (new Set([teamLeadId, agentPrimaryId, agentSecondaryId]).size < 3) {
    throw new Error(
      'SEED_TEAM_LEAD_ID, SEED_AGENT_PRIMARY_ID, and SEED_AGENT_SECONDARY_ID must be distinct UUID values'
    );
  }

  const assignedAtRecent = hoursFromNow(-5);
  const assignedAtOld = hoursFromNow(-240);

  const leads: BrokerLeadSeed[] = [
    {
      id: '00000000-0000-0000-0000-000000000710',
      ownerAgentId: teamLeadId,
      state: 'New',
      source: 'email',
      primaryEmail: 'intake.alex@broker-example.com',
      primaryPhone: '+15551000710',
      lastTouchAt: null,
      nextActionAt: minutesFromNow(-20),
      summary: 'Broker-channel inbound email pending first assignment.',
      fields: {
        intake_origin: 'broker_channel',
        broker_assigned: false,
        broker_channel: 'email'
      },
      metrics: {
        urgency: 'high',
        touches_last_48h: 0
      },
      task: {
        id: '00000000-0000-0000-0000-000000000810',
        type: 'contact_now',
        status: 'open',
        dueAt: minutesFromNow(-25),
        ownerId: teamLeadId
      },
      event: {
        id: '00000000-0000-0000-0000-000000000910',
        channel: 'email',
        type: 'inbound_message',
        direction: 'inbound',
        createdAt: hoursFromNow(-1)
      }
    },
    {
      id: '00000000-0000-0000-0000-000000000711',
      ownerAgentId: teamLeadId,
      state: 'Active',
      source: 'sms',
      primaryEmail: 'intake.maya@broker-example.com',
      primaryPhone: '+15551000711',
      lastTouchAt: hoursFromNow(-3),
      nextActionAt: minutesFromNow(40),
      summary: 'Broker-channel SMS lead ready for assignment to an agent.',
      fields: {
        intake_origin: 'broker_channel',
        broker_assigned: false,
        broker_channel: 'sms'
      },
      metrics: {
        urgency: 'medium',
        touches_last_48h: 1
      },
      task: {
        id: '00000000-0000-0000-0000-000000000811',
        type: 'follow_up',
        status: 'open',
        dueAt: minutesFromNow(35),
        ownerId: teamLeadId
      },
      event: {
        id: '00000000-0000-0000-0000-000000000911',
        channel: 'sms',
        type: 'inbound_message',
        direction: 'inbound',
        createdAt: hoursFromNow(-2)
      }
    },
    {
      id: '00000000-0000-0000-0000-000000000712',
      ownerAgentId: agentPrimaryId,
      state: 'Active',
      source: 'manual',
      primaryEmail: 'assigned.ryan@broker-example.com',
      primaryPhone: '+15551000712',
      lastTouchAt: hoursFromNow(-6),
      nextActionAt: minutesFromNow(90),
      summary: 'Assigned broker lead currently in active follow-up with Agent A.',
      fields: {
        intake_origin: 'broker_channel',
        broker_assigned: true,
        assigned_by_team_lead_id: teamLeadId,
        assigned_owner_id: agentPrimaryId,
        assigned_at: assignedAtRecent
      },
      metrics: {
        urgency: 'medium',
        touches_last_48h: 2
      },
      task: {
        id: '00000000-0000-0000-0000-000000000812',
        type: 'follow_up',
        status: 'open',
        dueAt: minutesFromNow(75),
        ownerId: agentPrimaryId
      },
      event: {
        id: '00000000-0000-0000-0000-000000000912',
        channel: 'note',
        type: 'agent_note',
        direction: 'internal',
        createdAt: hoursFromNow(-4)
      }
    },
    {
      id: '00000000-0000-0000-0000-000000000713',
      ownerAgentId: agentSecondaryId,
      state: 'Stale',
      source: 'call',
      primaryEmail: 'stale.jordan@broker-example.com',
      primaryPhone: '+15551000713',
      lastTouchAt: hoursFromNow(-190),
      nextActionAt: hoursFromNow(-30),
      summary: 'Broker-assigned lead is stale and ready in reassign queue.',
      fields: {
        intake_origin: 'broker_channel',
        broker_assigned: true,
        assigned_by_team_lead_id: teamLeadId,
        assigned_owner_id: agentSecondaryId,
        assigned_at: assignedAtOld
      },
      metrics: {
        urgency: 'critical',
        touches_last_48h: 0
      },
      task: {
        id: '00000000-0000-0000-0000-000000000813',
        type: 'rescue',
        status: 'open',
        dueAt: hoursFromNow(-2),
        ownerId: agentSecondaryId
      },
      event: {
        id: '00000000-0000-0000-0000-000000000913',
        channel: 'system',
        type: 'lead_marked_stale',
        direction: 'internal',
        createdAt: hoursFromNow(-1)
      }
    }
  ];

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query('BEGIN');
    await applyRlsContext(client, teamLeadId, teamId, 'TEAM_LEAD');

    await client.query(
      `INSERT INTO "Team" (id, stale_rules, sla_rules, escalation_rules)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        teamId,
        JSON.stringify(defaultStaleRules),
        JSON.stringify(defaultSlaRules),
        JSON.stringify({ broker_intake: defaultBrokerIntakeRule, templates: [], rescue_sequences: [] })
      ]
    );

    await client.query(
      `UPDATE "Team"
       SET stale_rules = CASE
             WHEN stale_rules = '{}'::jsonb THEN $2::jsonb
             ELSE stale_rules
           END,
           sla_rules = CASE
             WHEN sla_rules = '{}'::jsonb THEN $3::jsonb
             ELSE sla_rules
           END,
           escalation_rules = CASE
             WHEN escalation_rules ? 'broker_intake' THEN escalation_rules
             ELSE jsonb_set(
                    COALESCE(escalation_rules, '{}'::jsonb),
                    '{broker_intake}',
                    $4::jsonb,
                    true
                  )
           END
       WHERE id = $1`,
      [teamId, JSON.stringify(defaultStaleRules), JSON.stringify(defaultSlaRules), JSON.stringify(defaultBrokerIntakeRule)]
    );

    await client.query(
      `INSERT INTO "User" (id, team_id, role, language)
       VALUES
         ($1, $4, 'TEAM_LEAD', 'en'),
         ($2, $4, 'AGENT', 'en'),
         ($3, $4, 'AGENT', 'en')
       ON CONFLICT (id) DO UPDATE
       SET team_id = EXCLUDED.team_id,
           role = EXCLUDED.role,
           language = EXCLUDED.language`,
      [teamLeadId, agentPrimaryId, agentSecondaryId, teamId]
    );

    for (const lead of leads) {
      await applyRlsContext(client, teamLeadId, teamId, 'TEAM_LEAD');

      await client.query(
        `INSERT INTO "Lead" (
           id, team_id, owner_agent_id, state, source, primary_email, primary_phone, last_touch_at, next_action_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE
         SET team_id = EXCLUDED.team_id,
             owner_agent_id = EXCLUDED.owner_agent_id,
             state = EXCLUDED.state,
             source = EXCLUDED.source,
             primary_email = EXCLUDED.primary_email,
             primary_phone = EXCLUDED.primary_phone,
             last_touch_at = EXCLUDED.last_touch_at,
             next_action_at = EXCLUDED.next_action_at,
             updated_at = now()`,
        [
          lead.id,
          teamId,
          lead.ownerAgentId,
          lead.state,
          lead.source,
          lead.primaryEmail,
          lead.primaryPhone,
          lead.lastTouchAt,
          lead.nextActionAt
        ]
      );

      await client.query(
        `INSERT INTO "DerivedLeadProfile" (lead_id, summary, language, fields_json, metrics_json, updated_at)
         VALUES ($1, $2, 'en', $3::jsonb, $4::jsonb, now())
         ON CONFLICT (lead_id) DO UPDATE
         SET summary = EXCLUDED.summary,
             language = EXCLUDED.language,
             fields_json = EXCLUDED.fields_json,
             metrics_json = EXCLUDED.metrics_json,
             updated_at = EXCLUDED.updated_at`,
        [lead.id, lead.summary, JSON.stringify(lead.fields), JSON.stringify(lead.metrics)]
      );

      await client.query(
        `INSERT INTO "Task" (id, lead_id, owner_id, due_at, status, type)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE
         SET lead_id = EXCLUDED.lead_id,
             owner_id = EXCLUDED.owner_id,
             due_at = EXCLUDED.due_at,
             status = EXCLUDED.status,
             type = EXCLUDED.type`,
        [lead.task.id, lead.id, lead.task.ownerId, lead.task.dueAt, lead.task.status, lead.task.type]
      );

      await applyRlsContext(client, lead.ownerAgentId, teamId, 'AGENT');

      await client.query(
        `INSERT INTO "ConversationEvent" (
           id, lead_id, channel, type, direction, mailbox_connection_id, phone_number_id, provider_event_id, raw_body, meta, created_at
         )
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, NULL, '{}'::jsonb, $6)
         ON CONFLICT (id) DO UPDATE
         SET lead_id = EXCLUDED.lead_id,
             channel = EXCLUDED.channel,
             type = EXCLUDED.type,
             direction = EXCLUDED.direction,
             created_at = EXCLUDED.created_at`,
        [lead.event.id, lead.id, lead.event.channel, lead.event.type, lead.event.direction, lead.event.createdAt]
      );
    }

    await client.query('COMMIT');
    process.stdout.write(
      [
        'Seeded admin routing dataset.',
        `team_id=${teamId}`,
        `team_lead_id=${teamLeadId}`,
        `agent_ids=${agentPrimaryId},${agentSecondaryId}`,
        `lead_ids=${leads.map((lead) => lead.id).join(',')}`
      ].join('\n') + '\n'
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
