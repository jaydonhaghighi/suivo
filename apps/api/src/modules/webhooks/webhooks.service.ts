import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PoolClient } from 'pg';
import { createHmac, timingSafeEqual } from 'crypto';
import { EscalationRules, escalationRuleSchema } from '@mvp/shared-types';

import { RawContentCryptoService } from '../../common/crypto/raw-content-crypto.service';
import { DatabaseService } from '../../common/db/database.service';
import { EmailClassifierService } from '../ai/email-classifier.service';
import { LeadsService } from '../leads/leads.service';

interface EmailWebhookPayload {
  provider_event_id: string;
  mailbox_connection_id?: string | undefined;
  mailbox_email?: string | undefined;
  from_email: string;
  direction: 'inbound' | 'outbound';
  subject?: string | undefined;
  body?: string | undefined;
  thread_id?: string | undefined;
  timestamp?: string | undefined;
}

interface SmsWebhookPayload {
  provider_event_id: string;
  phone_number_id?: string | undefined;
  to_number?: string | undefined;
  from_number: string;
  direction: 'inbound' | 'outbound';
  body?: string | undefined;
  timestamp?: string | undefined;
}

interface CallWebhookPayload {
  provider_event_id: string;
  phone_number_id?: string | undefined;
  to_number?: string | undefined;
  from_number: string;
  direction: 'inbound' | 'outbound';
  status: string;
  duration_seconds?: number | undefined;
  timestamp?: string | undefined;
}

interface BrokerIntakeSettings {
  mailbox_connection_ids: string[];
  phone_number_ids: string[];
}

interface EmailIngestDbResult {
  accepted: boolean;
  deduped: boolean;
  lead_id?: string | undefined;
  event_id?: string | undefined;
  should_classify?: boolean | undefined;
}

type EmailClassificationStatus = 'not_applicable' | 'queued' | 'completed' | 'failed';

interface IngestEmailOptions {
  awaitClassification?: boolean | undefined;
}

export interface EmailIngestResult {
  accepted: boolean;
  deduped: boolean;
  lead_id?: string | undefined;
  event_id?: string | undefined;
  classification_status: EmailClassificationStatus;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly leadsService: LeadsService,
    private readonly rawContentCryptoService: RawContentCryptoService,
    private readonly emailClassifierService: EmailClassifierService
  ) {}

  async ingestEmail(
    provider: 'gmail' | 'outlook',
    payload: EmailWebhookPayload
  ): Promise<{ accepted: boolean; deduped: boolean; lead_id?: string }> {
    const detailed = await this.ingestEmailDetailed(provider, payload);
    return {
      accepted: detailed.accepted,
      deduped: detailed.deduped,
      ...(detailed.lead_id ? { lead_id: detailed.lead_id } : {})
    };
  }

  async ingestEmailDetailed(
    provider: 'gmail' | 'outlook',
    payload: EmailWebhookPayload,
    options?: IngestEmailOptions
  ): Promise<EmailIngestResult> {
    const ingestResult = await this.databaseService.withSystemTransaction<EmailIngestDbResult>(async (client) => {
      const mailbox = await this.resolveMailbox(client, provider, payload.mailbox_connection_id, payload.mailbox_email);
      if (!mailbox) {
        return { accepted: false, deduped: false };
      }

      const brokerIntake = await this.getBrokerIntakeSettings(client, mailbox.team_id);
      const isBrokerChannel = brokerIntake.mailbox_connection_ids.includes(mailbox.id);
      const ownerAgentId = isBrokerChannel ? await this.resolveTeamLead(client, mailbox.team_id) : mailbox.user_id;

      const lead = await this.leadsService.findOrCreateLeadByEmail(client, {
        teamId: mailbox.team_id,
        ownerAgentId,
        email: payload.from_email.toLowerCase(),
        source: 'email',
        provenance: {
          intake_origin: isBrokerChannel ? 'broker_channel' : 'agent_direct',
          intake_channel_ref: { mailbox_connection_id: mailbox.id },
          broker_assigned: false
        }
      });

      const insertResult = await client.query(
        `INSERT INTO "ConversationEvent" (
          lead_id,
          channel,
          type,
          direction,
          mailbox_connection_id,
          provider_event_id,
          raw_body,
          meta,
          created_at
        ) VALUES (
          $1,
          'email',
          CASE WHEN $3 = 'inbound' THEN 'email_received' ELSE 'email_sent' END,
          $3,
          $2,
          $4,
          $5,
          $6::jsonb,
          COALESCE($7::timestamptz, now())
        )
        ON CONFLICT (mailbox_connection_id, provider_event_id)
        WHERE channel = 'email' AND provider_event_id IS NOT NULL
        DO NOTHING
        RETURNING id`,
        [
          lead.id,
          mailbox.id,
          payload.direction,
          payload.provider_event_id,
          this.rawContentCryptoService.encrypt(payload.body ?? ''),
          JSON.stringify({
            subject: payload.subject ?? '',
            thread_id: payload.thread_id ?? null,
            provider: mailbox.provider
          }),
          payload.timestamp ?? null
        ]
      );

      if (!insertResult.rowCount) {
        return { accepted: true, deduped: true, lead_id: lead.id };
      }

      const eventIdValue = insertResult.rows[0]?.id;
      const eventId = typeof eventIdValue === 'string' ? eventIdValue : undefined;
      if (payload.direction === 'outbound') {
        await this.leadsService.applyTouch(client, lead.id, lead.owner_agent_id);
      } else {
        await this.ensureInboundTask(client, lead.id, lead.owner_agent_id);
      }

      const result: EmailIngestDbResult = {
        accepted: true,
        deduped: false,
        lead_id: lead.id,
        should_classify: payload.direction === 'inbound'
      };
      if (eventId) {
        result.event_id = eventId;
      }
      return result;
    });

    let classificationStatus: EmailClassificationStatus = 'not_applicable';
    if (
      ingestResult.accepted
      && !ingestResult.deduped
      && ingestResult.should_classify
      && ingestResult.event_id
      && ingestResult.lead_id
    ) {
      const subject = payload.subject ?? '';
      const body = payload.body ?? '';
      const fromEmail = payload.from_email;
      if (options?.awaitClassification) {
        const ok = await this.classifyAndPersistEmail(ingestResult.event_id, ingestResult.lead_id, {
          subject,
          body,
          fromEmail
        });
        classificationStatus = ok ? 'completed' : 'failed';
      } else {
        void this.classifyAndPersistEmail(ingestResult.event_id, ingestResult.lead_id, {
          subject,
          body,
          fromEmail
        });
        classificationStatus = 'queued';
      }
    }

    const result: EmailIngestResult = {
      accepted: ingestResult.accepted,
      deduped: ingestResult.deduped,
      classification_status: classificationStatus
    };
    if (ingestResult.lead_id) {
      result.lead_id = ingestResult.lead_id;
    }
    if (ingestResult.event_id) {
      result.event_id = ingestResult.event_id;
    }
    return result;
  }

  async ingestSms(payload: SmsWebhookPayload): Promise<{ accepted: boolean; deduped: boolean; lead_id?: string }> {
    return this.databaseService.withSystemTransaction(async (client) => {
      const phone = await this.resolvePhone(client, payload.phone_number_id, payload.to_number);
      if (!phone) {
        return { accepted: false, deduped: false };
      }

      const brokerIntake = await this.getBrokerIntakeSettings(client, phone.team_id);
      const isBrokerChannel = brokerIntake.phone_number_ids.includes(phone.id);
      const ownerAgentId = isBrokerChannel
        ? await this.resolveTeamLead(client, phone.team_id)
        : await this.resolveDefaultAgent(client, phone.team_id);

      const lead = await this.leadsService.findOrCreateLeadByPhone(client, {
        teamId: phone.team_id,
        ownerAgentId,
        phone: payload.from_number,
        source: 'sms',
        provenance: {
          intake_origin: isBrokerChannel ? 'broker_channel' : 'agent_direct',
          intake_channel_ref: { phone_number_id: phone.id },
          broker_assigned: false
        }
      });

      const insertResult = await client.query(
        `INSERT INTO "ConversationEvent" (
          lead_id,
          channel,
          type,
          direction,
          phone_number_id,
          provider_event_id,
          raw_body,
          meta,
          created_at
        ) VALUES (
          $1,
          'sms',
          CASE WHEN $3 = 'inbound' THEN 'sms_received' ELSE 'sms_sent' END,
          $3,
          $2,
          $4,
          $5,
          $6::jsonb,
          COALESCE($7::timestamptz, now())
        )
        ON CONFLICT (phone_number_id, provider_event_id)
        WHERE channel = 'sms' AND provider_event_id IS NOT NULL
        DO NOTHING
        RETURNING id`,
        [
          lead.id,
          phone.id,
          payload.direction,
          payload.provider_event_id,
          this.rawContentCryptoService.encrypt(payload.body ?? ''),
          JSON.stringify({ provider: phone.provider }),
          payload.timestamp ?? null
        ]
      );

      if (!insertResult.rowCount) {
        return { accepted: true, deduped: true, lead_id: lead.id };
      }

      if (payload.direction === 'outbound') {
        await this.leadsService.applyTouch(client, lead.id, lead.owner_agent_id);
      } else {
        await this.ensureInboundTask(client, lead.id, lead.owner_agent_id);
      }

      return { accepted: true, deduped: false, lead_id: lead.id };
    });
  }

  async ingestCall(payload: CallWebhookPayload): Promise<{ accepted: boolean; deduped: boolean; lead_id?: string }> {
    return this.databaseService.withSystemTransaction(async (client) => {
      const phone = await this.resolvePhone(client, payload.phone_number_id, payload.to_number);
      if (!phone) {
        return { accepted: false, deduped: false };
      }

      const brokerIntake = await this.getBrokerIntakeSettings(client, phone.team_id);
      const isBrokerChannel = brokerIntake.phone_number_ids.includes(phone.id);
      const ownerAgentId = isBrokerChannel
        ? await this.resolveTeamLead(client, phone.team_id)
        : await this.resolveDefaultAgent(client, phone.team_id);

      const lead = await this.leadsService.findOrCreateLeadByPhone(client, {
        teamId: phone.team_id,
        ownerAgentId,
        phone: payload.from_number,
        source: 'call',
        provenance: {
          intake_origin: isBrokerChannel ? 'broker_channel' : 'agent_direct',
          intake_channel_ref: { phone_number_id: phone.id },
          broker_assigned: false
        }
      });

      const insertResult = await client.query(
        `INSERT INTO "ConversationEvent" (
          lead_id,
          channel,
          type,
          direction,
          phone_number_id,
          provider_event_id,
          raw_body,
          meta,
          created_at
        ) VALUES (
          $1,
          'call',
          'call_status',
          $3,
          $2,
          $4,
          NULL,
          $5::jsonb,
          COALESCE($6::timestamptz, now())
        )
        ON CONFLICT (phone_number_id, provider_event_id)
        WHERE channel = 'call' AND provider_event_id IS NOT NULL
        DO NOTHING
        RETURNING id`,
        [
          lead.id,
          phone.id,
          payload.direction,
          payload.provider_event_id,
          JSON.stringify({
            status: payload.status,
            duration_seconds: payload.duration_seconds ?? null,
            provider: phone.provider
          }),
          payload.timestamp ?? null
        ]
      );

      if (!insertResult.rowCount) {
        return { accepted: true, deduped: true, lead_id: lead.id };
      }

      if (payload.direction === 'inbound') {
        await this.ensureInboundTask(client, lead.id, lead.owner_agent_id);
      }

      return { accepted: true, deduped: false, lead_id: lead.id };
    });
  }

  private async classifyAndPersistEmail(
    eventId: string,
    leadId: string,
    input: { subject: string; body: string; fromEmail: string }
  ): Promise<boolean> {
    try {
      const classification = await this.emailClassifierService.classifyInboundEmail({
        subject: input.subject,
        body: input.body,
        fromEmail: input.fromEmail
      });

      await this.databaseService.withSystemTransaction(async (client) => {
        await client.query(
          `UPDATE "ConversationEvent"
           SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
           WHERE id = $1`,
          [eventId, JSON.stringify({ ai_classification: classification })]
        );

        await client.query(
          `UPDATE "DerivedLeadProfile"
           SET fields_json = COALESCE(fields_json, '{}'::jsonb) || $2::jsonb,
               updated_at = now()
           WHERE lead_id = $1`,
          [
            leadId,
            JSON.stringify({
              last_email_classification: {
                kind: classification.kind,
                urgency: classification.urgency,
                confidence: classification.confidence,
                needs_human_reply: classification.needs_human_reply,
                source: classification.source
              }
            })
          ]
        );
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Email classification persistence failed for event ${eventId}: ${message}`);
      return false;
    }
  }

  private async resolveMailbox(
    client: PoolClient,
    provider: 'gmail' | 'outlook',
    mailboxConnectionId?: string,
    mailboxEmail?: string
  ): Promise<{ id: string; user_id: string; team_id: string; provider: string } | null> {
    if (mailboxConnectionId) {
      const result = await client.query(
        `SELECT m.id, m.user_id, u.team_id, m.provider
         FROM "MailboxConnection" m
         JOIN "User" u ON u.id = m.user_id
         WHERE m.id = $1
           AND m.status = 'active'`,
        [mailboxConnectionId]
      );
      const row = result.rows[0] ?? null;
      if (!row || row.provider !== provider) {
        return null;
      }
      return row;
    }

    if (mailboxEmail) {
      const result = await client.query(
        `SELECT m.id, m.user_id, u.team_id, m.provider
         FROM "MailboxConnection" m
         JOIN "User" u ON u.id = m.user_id
         WHERE m.email_address = $1
           AND m.provider = $2
           AND m.status = 'active'
         ORDER BY m.created_at ASC
         LIMIT 2`,
        [mailboxEmail, provider]
      );
      if (result.rowCount === 1) {
        return result.rows[0];
      }
      return null;
    }

    return null;
  }

  private async resolvePhone(
    client: PoolClient,
    phoneNumberId?: string,
    toNumber?: string
  ): Promise<{ id: string; team_id: string; provider: string } | null> {
    if (phoneNumberId) {
      const result = await client.query(
        `SELECT id, team_id, provider FROM "PhoneNumber" WHERE id = $1`,
        [phoneNumberId]
      );
      return result.rows[0] ?? null;
    }

    if (toNumber) {
      const result = await client.query(
        `SELECT id, team_id, provider
         FROM "PhoneNumber"
         WHERE number = $1
           AND status = 'active'
         LIMIT 1`,
        [toNumber]
      );
      return result.rows[0] ?? null;
    }

    return null;
  }

  private async resolveDefaultAgent(client: PoolClient, teamId: string): Promise<string> {
    const result = await client.query(
      `SELECT id
       FROM "User"
       WHERE team_id = $1 AND role = 'AGENT'
       ORDER BY id
       LIMIT 1`,
      [teamId]
    );

    if (!result.rowCount || !result.rows[0]) {
      throw new Error(`No agent found in team ${teamId}`);
    }

    return result.rows[0].id as string;
  }

  private async resolveTeamLead(client: PoolClient, teamId: string): Promise<string> {
    const result = await client.query(
      `SELECT id
       FROM "User"
       WHERE team_id = $1 AND role = 'TEAM_LEAD'
       ORDER BY id
       LIMIT 1`,
      [teamId]
    );

    if (!result.rowCount || !result.rows[0]) {
      throw new Error(`No team lead found in team ${teamId}`);
    }

    return result.rows[0].id as string;
  }

  private async getBrokerIntakeSettings(client: PoolClient, teamId: string): Promise<BrokerIntakeSettings> {
    const result = await client.query(
      `SELECT escalation_rules
       FROM "Team"
       WHERE id = $1`,
      [teamId]
    );

    if (!result.rowCount || !result.rows[0]) {
      return { mailbox_connection_ids: [], phone_number_ids: [] };
    }

    const rules = escalationRuleSchema.parse(result.rows[0].escalation_rules as EscalationRules);
    return {
      mailbox_connection_ids: rules.broker_intake.mailbox_connection_ids,
      phone_number_ids: rules.broker_intake.phone_number_ids
    };
  }

  private async ensureInboundTask(client: PoolClient, leadId: string, ownerId: string): Promise<void> {
    const existing = await client.query(
      `SELECT id
       FROM "Task"
       WHERE lead_id = $1
         AND status = 'open'
         AND type IN ('contact_now', 'follow_up')
       LIMIT 1`,
      [leadId]
    );

    if (!existing.rowCount) {
      await client.query(
        `INSERT INTO "Task" (lead_id, owner_id, due_at, status, type)
         VALUES ($1, $2, now(), 'open', 'contact_now')`,
        [leadId, ownerId]
      );
    }
  }

  isValidSignature(body: unknown, providedSignature?: string): boolean {
    const secret = this.configService.get<string>('WEBHOOK_SHARED_SECRET');
    if (!secret || !providedSignature) {
      return false;
    }

    const normalizedSignature = providedSignature.trim().replace(/^sha256=/i, '');
    if (!/^[a-fA-F0-9]+$/.test(normalizedSignature)) {
      return false;
    }

    const expectedBuffer = createHmac('sha256', secret).update(JSON.stringify(body)).digest();
    const providedBuffer = Buffer.from(normalizedSignature, 'hex');

    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, providedBuffer);
  }
}
