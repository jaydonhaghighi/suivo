import { Client } from 'pg';
import { loadEnv } from './load-env';
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

const teamId = '00000000-0000-0000-0000-000000000010';
const agentId = '00000000-0000-0000-0000-000000000001';
const teamLeadId = '00000000-0000-0000-0000-000000000002';

const templateEmailId = '00000000-0000-0000-0000-000000000301';
const templateSmsId = '00000000-0000-0000-0000-000000000302';
const rescueSequenceId = '00000000-0000-0000-0000-000000000401';
const rescueStepTaskId = '00000000-0000-0000-0000-000000000411';
const rescueStepSmsId = '00000000-0000-0000-0000-000000000412';
const rescueStepEmailId = '00000000-0000-0000-0000-000000000413';

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function hoursFromNow(hours: number): string {
  return minutesFromNow(hours * 60);
}

const escalationUpdatedAt = new Date().toISOString();

const defaultEscalationRules = {
  templates: [
    {
      id: templateEmailId,
      language: 'en',
      channel: 'email',
      name: 'Friendly Follow-Up Email',
      body: 'Hi {{first_name}}, just checking in. I am available for a quick call whenever works for you.',
      updated_at: escalationUpdatedAt
    },
    {
      id: templateSmsId,
      language: 'en',
      channel: 'sms',
      name: 'Rescue SMS Touch',
      body: 'Quick check-in from your real estate team. Want me to send over next-step options?',
      updated_at: escalationUpdatedAt
    }
  ],
  rescue_sequences: [
    {
      id: rescueSequenceId,
      name: 'Default Stale Rescue',
      language: 'en',
      steps: [
        {
          id: rescueStepTaskId,
          offset_minutes: 0,
          channel: 'task',
          requires_human_send: true,
          enabled: true
        },
        {
          id: rescueStepSmsId,
          offset_minutes: 15,
          channel: 'sms',
          template_id: templateSmsId,
          requires_human_send: true,
          enabled: true
        },
        {
          id: rescueStepEmailId,
          offset_minutes: 120,
          channel: 'email',
          template_id: templateEmailId,
          requires_human_send: true,
          enabled: true
        }
      ],
      updated_at: escalationUpdatedAt
    }
  ],
  broker_intake: {
    mailbox_connection_ids: [],
    phone_number_ids: [],
    stale_hours_for_assigned: 168
  }
};

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

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query('BEGIN');
    await applyRlsContext(client, teamLeadId, teamId, 'TEAM_LEAD');

    await client.query(
      `INSERT INTO "Team" (id, stale_rules, sla_rules, escalation_rules)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)
       ON CONFLICT (id) DO UPDATE
       SET stale_rules = EXCLUDED.stale_rules,
           sla_rules = EXCLUDED.sla_rules,
           escalation_rules = EXCLUDED.escalation_rules`,
      [teamId, JSON.stringify(defaultStaleRules), JSON.stringify(defaultSlaRules), JSON.stringify(defaultEscalationRules)]
    );

    await client.query(
      `INSERT INTO "User" (id, team_id, role, language)
       VALUES
         ($1, $3, 'AGENT', 'en'),
         ($2, $3, 'TEAM_LEAD', 'en')
       ON CONFLICT (id) DO UPDATE
       SET team_id = EXCLUDED.team_id,
           role = EXCLUDED.role,
           language = EXCLUDED.language`,
      [agentId, teamLeadId, teamId]
    );

    await applyRlsContext(client, agentId, teamId, 'AGENT');

    const leads = [
      {
        id: '00000000-0000-0000-0000-000000000100',
        state: 'New',
        source: 'email',
        primary_email: 'sample-lead@example.com',
        primary_phone: '+15550000000',
        last_touch_at: null,
        next_action_at: minutesFromNow(-15)
      },
      {
        id: '00000000-0000-0000-0000-000000000101',
        state: 'Active',
        source: 'sms',
        primary_email: 'maria.gomez@example.com',
        primary_phone: '+15550000001',
        last_touch_at: hoursFromNow(-4),
        next_action_at: minutesFromNow(30)
      },
      {
        id: '00000000-0000-0000-0000-000000000102',
        state: 'At-Risk',
        source: 'call',
        primary_email: 'andrew.choi@example.com',
        primary_phone: '+15550000002',
        last_touch_at: hoursFromNow(-38),
        next_action_at: minutesFromNow(-10)
      },
      {
        id: '00000000-0000-0000-0000-000000000103',
        state: 'Stale',
        source: 'email',
        primary_email: 'zoe.patel@example.com',
        primary_phone: '+15550000003',
        last_touch_at: hoursFromNow(-60),
        next_action_at: hoursFromNow(-5)
      },
      {
        id: '00000000-0000-0000-0000-000000000104',
        state: 'Active',
        source: 'manual',
        primary_email: 'devon.lee@example.com',
        primary_phone: '+15550000004',
        last_touch_at: minutesFromNow(-75),
        next_action_at: hoursFromNow(2)
      }
    ];

    for (const lead of leads) {
      await client.query(
        `INSERT INTO "Lead" (id, team_id, owner_agent_id, state, source, primary_email, primary_phone, last_touch_at, next_action_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE
         SET team_id = EXCLUDED.team_id,
             owner_agent_id = EXCLUDED.owner_agent_id,
             state = EXCLUDED.state,
             source = EXCLUDED.source,
             primary_email = EXCLUDED.primary_email,
             primary_phone = EXCLUDED.primary_phone,
             last_touch_at = EXCLUDED.last_touch_at,
             next_action_at = EXCLUDED.next_action_at`,
        [
          lead.id,
          teamId,
          agentId,
          lead.state,
          lead.source,
          lead.primary_email,
          lead.primary_phone,
          lead.last_touch_at,
          lead.next_action_at
        ]
      );
    }

    const profiles = [
      {
        lead_id: '00000000-0000-0000-0000-000000000100',
        summary: 'New lead from inbound email. Needs first touch and scheduling intent.',
        fields: {
          budget: '$750k',
          area: 'Downtown',
          bedrooms: 2,
          timeline: '30-60 days'
        },
        metrics: { urgency: 'high', touches_last_48h: 0 }
      },
      {
        lead_id: '00000000-0000-0000-0000-000000000101',
        summary: 'Engaged over SMS. Wants options in the west side area this week.',
        fields: {
          budget: '$1.2M',
          area: 'West Side',
          bedrooms: 3,
          timeline: 'This month'
        },
        metrics: { urgency: 'medium', touches_last_48h: 2 }
      },
      {
        lead_id: '00000000-0000-0000-0000-000000000102',
        summary: 'Follow-up lagging and close to stale threshold. Needs quick outbound touch.',
        fields: {
          budget: '$540k',
          area: 'North End',
          bedrooms: 1,
          timeline: '90+ days'
        },
        metrics: { urgency: 'high', touches_last_48h: 1 }
      },
      {
        lead_id: '00000000-0000-0000-0000-000000000103',
        summary: 'No recent valid touches. In stale rescue path and ready for intervention.',
        fields: {
          budget: '$950k',
          area: 'Suburbs',
          bedrooms: 4,
          timeline: '60-90 days'
        },
        metrics: { urgency: 'critical', touches_last_48h: 0 }
      },
      {
        lead_id: '00000000-0000-0000-0000-000000000104',
        summary: 'Recent phone interaction completed. Awaiting follow-up note and next step.',
        fields: {
          budget: '$680k',
          area: 'River District',
          bedrooms: 2,
          timeline: '45 days'
        },
        metrics: { urgency: 'medium', touches_last_48h: 1 }
      }
    ];

    for (const profile of profiles) {
      await client.query(
        `INSERT INTO "DerivedLeadProfile" (lead_id, summary, language, fields_json, metrics_json, updated_at)
         VALUES ($1, $2, 'en', $3::jsonb, $4::jsonb, now())
         ON CONFLICT (lead_id) DO UPDATE
         SET summary = EXCLUDED.summary,
             language = EXCLUDED.language,
             fields_json = EXCLUDED.fields_json,
             metrics_json = EXCLUDED.metrics_json,
             updated_at = EXCLUDED.updated_at`,
        [
          profile.lead_id,
          profile.summary,
          JSON.stringify(profile.fields ?? {}),
          JSON.stringify(profile.metrics)
        ]
      );
    }

    const tasks = [
      {
        id: '00000000-0000-0000-0000-000000000200',
        lead_id: '00000000-0000-0000-0000-000000000100',
        due_at: minutesFromNow(-20),
        status: 'open',
        type: 'contact_now'
      },
      {
        id: '00000000-0000-0000-0000-000000000201',
        lead_id: '00000000-0000-0000-0000-000000000101',
        due_at: minutesFromNow(25),
        status: 'open',
        type: 'follow_up'
      },
      {
        id: '00000000-0000-0000-0000-000000000202',
        lead_id: '00000000-0000-0000-0000-000000000102',
        due_at: minutesFromNow(-8),
        status: 'open',
        type: 'follow_up'
      },
      {
        id: '00000000-0000-0000-0000-000000000203',
        lead_id: '00000000-0000-0000-0000-000000000103',
        due_at: minutesFromNow(-3),
        status: 'open',
        type: 'rescue'
      },
      {
        id: '00000000-0000-0000-0000-000000000204',
        lead_id: '00000000-0000-0000-0000-000000000104',
        due_at: minutesFromNow(90),
        status: 'open',
        type: 'call_outcome'
      },
      {
        id: '00000000-0000-0000-0000-000000000205',
        lead_id: '00000000-0000-0000-0000-000000000101',
        due_at: hoursFromNow(-12),
        status: 'done',
        type: 'manual'
      }
    ] as const;

    for (const task of tasks) {
      await client.query(
        `INSERT INTO "Task" (id, lead_id, owner_id, due_at, status, type)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE
         SET lead_id = EXCLUDED.lead_id,
             owner_id = EXCLUDED.owner_id,
             due_at = EXCLUDED.due_at,
             status = EXCLUDED.status,
             type = EXCLUDED.type`,
        [task.id, task.lead_id, agentId, task.due_at, task.status, task.type]
      );
    }

    const conversationEvents = [
      // ── Lead 100 (New) ──
      {
        id: '00000000-0000-0000-0000-000000000500',
        lead_id: '00000000-0000-0000-0000-000000000100',
        channel: 'email',
        type: 'inbound_message',
        direction: 'inbound',
        created_at: hoursFromNow(-2)
      },
      {
        id: '00000000-0000-0000-0000-000000000504',
        lead_id: '00000000-0000-0000-0000-000000000100',
        channel: 'system',
        type: 'lead_created',
        direction: 'internal',
        created_at: hoursFromNow(-2)
      },
      {
        id: '00000000-0000-0000-0000-000000000505',
        lead_id: '00000000-0000-0000-0000-000000000100',
        channel: 'system',
        type: 'auto_assigned',
        direction: 'internal',
        created_at: hoursFromNow(-2)
      },

      // ── Lead 101 (Active, SMS) ──
      {
        id: '00000000-0000-0000-0000-000000000506',
        lead_id: '00000000-0000-0000-0000-000000000101',
        channel: 'system',
        type: 'lead_created',
        direction: 'internal',
        created_at: hoursFromNow(-72)
      },
      {
        id: '00000000-0000-0000-0000-000000000507',
        lead_id: '00000000-0000-0000-0000-000000000101',
        channel: 'sms',
        type: 'inbound_message',
        direction: 'inbound',
        created_at: hoursFromNow(-70)
      },
      {
        id: '00000000-0000-0000-0000-000000000508',
        lead_id: '00000000-0000-0000-0000-000000000101',
        channel: 'sms',
        type: 'outbound_message',
        direction: 'outbound',
        created_at: hoursFromNow(-69)
      },
      {
        id: '00000000-0000-0000-0000-000000000509',
        lead_id: '00000000-0000-0000-0000-000000000101',
        channel: 'call',
        type: 'call_completed',
        direction: 'outbound',
        created_at: hoursFromNow(-48)
      },
      {
        id: '00000000-0000-0000-0000-000000000510',
        lead_id: '00000000-0000-0000-0000-000000000101',
        channel: 'note',
        type: 'agent_note',
        direction: 'internal',
        created_at: hoursFromNow(-48)
      },
      {
        id: '00000000-0000-0000-0000-000000000511',
        lead_id: '00000000-0000-0000-0000-000000000101',
        channel: 'email',
        type: 'outbound_message',
        direction: 'outbound',
        created_at: hoursFromNow(-24)
      },
      {
        id: '00000000-0000-0000-0000-000000000512',
        lead_id: '00000000-0000-0000-0000-000000000101',
        channel: 'email',
        type: 'inbound_message',
        direction: 'inbound',
        created_at: hoursFromNow(-20)
      },
      {
        id: '00000000-0000-0000-0000-000000000501',
        lead_id: '00000000-0000-0000-0000-000000000101',
        channel: 'sms',
        type: 'outbound_message',
        direction: 'outbound',
        created_at: hoursFromNow(-3)
      },
      {
        id: '00000000-0000-0000-0000-000000000513',
        lead_id: '00000000-0000-0000-0000-000000000101',
        channel: 'sms',
        type: 'inbound_message',
        direction: 'inbound',
        created_at: hoursFromNow(-2)
      },

      // ── Lead 102 (At-Risk) ──
      {
        id: '00000000-0000-0000-0000-000000000514',
        lead_id: '00000000-0000-0000-0000-000000000102',
        channel: 'system',
        type: 'lead_created',
        direction: 'internal',
        created_at: hoursFromNow(-120)
      },
      {
        id: '00000000-0000-0000-0000-000000000515',
        lead_id: '00000000-0000-0000-0000-000000000102',
        channel: 'email',
        type: 'outbound_message',
        direction: 'outbound',
        created_at: hoursFromNow(-118)
      },
      {
        id: '00000000-0000-0000-0000-000000000516',
        lead_id: '00000000-0000-0000-0000-000000000102',
        channel: 'email',
        type: 'inbound_message',
        direction: 'inbound',
        created_at: hoursFromNow(-96)
      },
      {
        id: '00000000-0000-0000-0000-000000000517',
        lead_id: '00000000-0000-0000-0000-000000000102',
        channel: 'call',
        type: 'call_no_answer',
        direction: 'outbound',
        created_at: hoursFromNow(-72)
      },
      {
        id: '00000000-0000-0000-0000-000000000518',
        lead_id: '00000000-0000-0000-0000-000000000102',
        channel: 'sms',
        type: 'outbound_message',
        direction: 'outbound',
        created_at: hoursFromNow(-71)
      },
      {
        id: '00000000-0000-0000-0000-000000000502',
        lead_id: '00000000-0000-0000-0000-000000000102',
        channel: 'call',
        type: 'call_completed',
        direction: 'outbound',
        created_at: hoursFromNow(-22)
      },
      {
        id: '00000000-0000-0000-0000-000000000519',
        lead_id: '00000000-0000-0000-0000-000000000102',
        channel: 'note',
        type: 'agent_note',
        direction: 'internal',
        created_at: hoursFromNow(-22)
      },
      {
        id: '00000000-0000-0000-0000-000000000520',
        lead_id: '00000000-0000-0000-0000-000000000102',
        channel: 'system',
        type: 'at_risk_warning',
        direction: 'internal',
        created_at: hoursFromNow(-6)
      },

      // ── Lead 103 (Stale) ──
      {
        id: '00000000-0000-0000-0000-000000000521',
        lead_id: '00000000-0000-0000-0000-000000000103',
        channel: 'system',
        type: 'lead_created',
        direction: 'internal',
        created_at: hoursFromNow(-168)
      },
      {
        id: '00000000-0000-0000-0000-000000000522',
        lead_id: '00000000-0000-0000-0000-000000000103',
        channel: 'email',
        type: 'outbound_message',
        direction: 'outbound',
        created_at: hoursFromNow(-166)
      },
      {
        id: '00000000-0000-0000-0000-000000000523',
        lead_id: '00000000-0000-0000-0000-000000000103',
        channel: 'email',
        type: 'inbound_message',
        direction: 'inbound',
        created_at: hoursFromNow(-140)
      },
      {
        id: '00000000-0000-0000-0000-000000000524',
        lead_id: '00000000-0000-0000-0000-000000000103',
        channel: 'call',
        type: 'call_no_answer',
        direction: 'outbound',
        created_at: hoursFromNow(-120)
      },
      {
        id: '00000000-0000-0000-0000-000000000525',
        lead_id: '00000000-0000-0000-0000-000000000103',
        channel: 'sms',
        type: 'outbound_message',
        direction: 'outbound',
        created_at: hoursFromNow(-96)
      },
      {
        id: '00000000-0000-0000-0000-000000000526',
        lead_id: '00000000-0000-0000-0000-000000000103',
        channel: 'call',
        type: 'call_no_answer',
        direction: 'outbound',
        created_at: hoursFromNow(-72)
      },
      {
        id: '00000000-0000-0000-0000-000000000527',
        lead_id: '00000000-0000-0000-0000-000000000103',
        channel: 'email',
        type: 'outbound_message',
        direction: 'outbound',
        created_at: hoursFromNow(-60)
      },
      {
        id: '00000000-0000-0000-0000-000000000528',
        lead_id: '00000000-0000-0000-0000-000000000103',
        channel: 'system',
        type: 'sla_breach',
        direction: 'internal',
        created_at: hoursFromNow(-12)
      },
      {
        id: '00000000-0000-0000-0000-000000000503',
        lead_id: '00000000-0000-0000-0000-000000000103',
        channel: 'system',
        type: 'stale_transition',
        direction: 'internal',
        created_at: hoursFromNow(-4)
      },
      {
        id: '00000000-0000-0000-0000-000000000529',
        lead_id: '00000000-0000-0000-0000-000000000103',
        channel: 'system',
        type: 'rescue_sequence_started',
        direction: 'internal',
        created_at: hoursFromNow(-4)
      },

      // ── Lead 104 (Active, manual) ──
      {
        id: '00000000-0000-0000-0000-000000000530',
        lead_id: '00000000-0000-0000-0000-000000000104',
        channel: 'system',
        type: 'lead_created',
        direction: 'internal',
        created_at: hoursFromNow(-36)
      },
      {
        id: '00000000-0000-0000-0000-000000000531',
        lead_id: '00000000-0000-0000-0000-000000000104',
        channel: 'call',
        type: 'inbound_call',
        direction: 'inbound',
        created_at: hoursFromNow(-34)
      },
      {
        id: '00000000-0000-0000-0000-000000000532',
        lead_id: '00000000-0000-0000-0000-000000000104',
        channel: 'note',
        type: 'agent_note',
        direction: 'internal',
        created_at: hoursFromNow(-34)
      },
      {
        id: '00000000-0000-0000-0000-000000000533',
        lead_id: '00000000-0000-0000-0000-000000000104',
        channel: 'email',
        type: 'outbound_message',
        direction: 'outbound',
        created_at: hoursFromNow(-30)
      },
      {
        id: '00000000-0000-0000-0000-000000000534',
        lead_id: '00000000-0000-0000-0000-000000000104',
        channel: 'email',
        type: 'inbound_message',
        direction: 'inbound',
        created_at: hoursFromNow(-18)
      },
      {
        id: '00000000-0000-0000-0000-000000000535',
        lead_id: '00000000-0000-0000-0000-000000000104',
        channel: 'sms',
        type: 'outbound_message',
        direction: 'outbound',
        created_at: hoursFromNow(-6)
      },
      {
        id: '00000000-0000-0000-0000-000000000536',
        lead_id: '00000000-0000-0000-0000-000000000104',
        channel: 'call',
        type: 'call_completed',
        direction: 'outbound',
        created_at: hoursFromNow(-1)
      },
      {
        id: '00000000-0000-0000-0000-000000000537',
        lead_id: '00000000-0000-0000-0000-000000000104',
        channel: 'note',
        type: 'agent_note',
        direction: 'internal',
        created_at: hoursFromNow(-1)
      }
    ] as const;

    for (const event of conversationEvents) {
      await client.query(
        `INSERT INTO "ConversationEvent" (
           id,
           lead_id,
           channel,
           type,
           direction,
           mailbox_connection_id,
           phone_number_id,
           provider_event_id,
           raw_body,
           meta,
           created_at
         )
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, NULL, '{}'::jsonb, $6)
         ON CONFLICT (id) DO UPDATE
         SET lead_id = EXCLUDED.lead_id,
             channel = EXCLUDED.channel,
             type = EXCLUDED.type,
             direction = EXCLUDED.direction,
             meta = EXCLUDED.meta,
             created_at = EXCLUDED.created_at`,
        [event.id, event.lead_id, event.channel, event.type, event.direction, event.created_at]
      );
    }

    await client.query('COMMIT');
    process.stdout.write('Seed complete\n');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
