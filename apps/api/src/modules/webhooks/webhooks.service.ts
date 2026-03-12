import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PoolClient } from 'pg';
import { createHmac, timingSafeEqual } from 'crypto';
import { EscalationRules, escalationRuleSchema } from '@mvp/shared-types';

import { UserContext } from '../../common/auth/user-context';
import { RawContentCryptoService } from '../../common/crypto/raw-content-crypto.service';
import { DatabaseService } from '../../common/db/database.service';
import { EmailClassifierService } from '../ai/email-classifier.service';
import {
  EmailIngestSource,
  EmailIntakeDecision,
  EmailIntakeQualificationService
} from './email-intake-qualification.service';
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

type EmailClassification = Awaited<ReturnType<EmailClassifierService['classifyInboundEmail']>>;
type EmailClassificationStatus = 'not_applicable' | 'queued' | 'completed' | 'failed';
type EmailIntakeReviewStatus = 'none' | 'review_pending' | 'lead_created' | 'rejected';
type EmailIntakeMode = 'disabled' | 'shadow' | 'cutover';

interface IngestEmailOptions {
  awaitClassification?: boolean | undefined;
  ingestSource?: EmailIngestSource | undefined;
}

interface EmailIngestDbResult {
  accepted: boolean;
  deduped: boolean;
  lead_id?: string | undefined;
  event_id?: string | undefined;
  should_classify?: boolean | undefined;
  intake_id?: string | undefined;
  intake_decision?: EmailIntakeDecision | undefined;
  precomputed_classification?: EmailClassification | undefined;
}

interface EmailIntakeDedupeRow {
  id: string;
  decision: EmailIntakeDecision;
  lead_id: string | null;
  conversation_event_id: string | null;
}

interface EmailIntakeReviewRow {
  id: string;
  team_id: string;
  mailbox_connection_id: string;
  mailbox_user_id: string;
  provider: 'gmail' | 'outlook';
  provider_event_id: string;
  ingest_source: EmailIngestSource;
  sender_email: string;
  subject: string;
  raw_body: Buffer | null;
  metadata: Record<string, unknown> | null;
  classifier_json: Record<string, unknown> | null;
  score: number;
  decision: EmailIntakeDecision;
  decision_reasons: unknown;
  review_assignee_user_id: string | null;
  review_status: EmailIntakeReviewStatus;
  lead_id: string | null;
  conversation_event_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  mailbox_email: string;
}

interface EmailIntakeDailyCalibrationRow {
  day: string;
  provider: 'gmail' | 'outlook';
  ingest_source: EmailIngestSource;
  intake_count: number;
  create_lead_count: number;
  needs_review_count: number;
  rejected_count: number;
  pending_review_count: number;
  avg_score: string | null;
  shadow_disagreement_count: number;
}

interface ReviewQueueOptions {
  limit: number;
  include_body: boolean;
}

export interface EmailIngestResult {
  accepted: boolean;
  deduped: boolean;
  lead_id?: string | undefined;
  event_id?: string | undefined;
  intake_id?: string | undefined;
  intake_decision?: EmailIntakeDecision | undefined;
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
    private readonly emailClassifierService: EmailClassifierService,
    private readonly emailIntakeQualificationService: EmailIntakeQualificationService
  ) {}

  async ingestEmail(
    provider: 'gmail' | 'outlook',
    payload: EmailWebhookPayload
  ): Promise<{ accepted: boolean; deduped: boolean; lead_id?: string }> {
    const detailed = await this.ingestEmailDetailed(provider, payload, { ingestSource: 'webhook' });
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
    const intakeMode = this.getEmailIntakeMode();

    const qualification =
      payload.direction === 'inbound' && intakeMode !== 'disabled'
        ? await this.emailIntakeQualificationService.qualifyInboundEmail({
            fromEmail: payload.from_email,
            subject: payload.subject,
            body: payload.body
          })
        : null;

    const ingestResult = await this.databaseService.withSystemTransaction<EmailIngestDbResult>(async (client) => {
      const mailbox = await this.resolveMailbox(client, provider, payload.mailbox_connection_id, payload.mailbox_email);
      if (!mailbox) {
        return { accepted: false, deduped: false };
      }

      const source = options?.ingestSource ?? 'webhook';
      if (payload.direction !== 'inbound' || intakeMode === 'disabled' || !qualification) {
        const legacyResult = await this.ingestEmailDirectCreate(client, mailbox, payload);
        return legacyResult;
      }

      const reviewAssigneeUserId = qualification.decision === 'needs_review' ? mailbox.user_id : null;
      const intakeInsert = await client.query<{ id: string }>(
        `INSERT INTO "EmailIntake" (
           team_id,
           mailbox_connection_id,
           mailbox_user_id,
           provider,
           provider_event_id,
           ingest_source,
           sender_email,
           sender_domain,
           sender_localpart,
           subject,
           raw_body,
           body_fingerprint,
           metadata,
           classifier_json,
           score,
           decision,
           decision_reasons,
           review_assignee_user_id,
           review_status,
           created_at,
           updated_at
         ) VALUES (
           $1,
           $2,
           $3,
           $4,
           $5,
           $6,
           $7,
           $8,
           $9,
           $10,
           $11,
           $12,
           $13::jsonb,
           $14::jsonb,
           $15,
           $16,
           $17::jsonb,
           $18,
           'none',
           now(),
           now()
         )
         ON CONFLICT (mailbox_connection_id, provider_event_id)
         DO NOTHING
         RETURNING id`,
        [
          mailbox.team_id,
          mailbox.id,
          mailbox.user_id,
          mailbox.provider,
          payload.provider_event_id,
          source,
          qualification.normalized_from_email,
          qualification.sender_domain,
          qualification.sender_localpart,
          payload.subject ?? '',
          this.rawContentCryptoService.encrypt(payload.body ?? ''),
          qualification.body_fingerprint,
          JSON.stringify({
            subject: payload.subject ?? '',
            thread_id: payload.thread_id ?? null,
            provider: mailbox.provider,
            direction: payload.direction,
            timestamp: payload.timestamp ?? null,
            ingest_source: source
          }),
          JSON.stringify(qualification.classifier),
          qualification.score,
          qualification.decision,
          JSON.stringify(qualification.reasons),
          reviewAssigneeUserId
        ]
      );

      if (!intakeInsert.rowCount || !intakeInsert.rows[0]) {
        const existing = await client.query<EmailIntakeDedupeRow>(
          `SELECT id, decision, lead_id, conversation_event_id
           FROM "EmailIntake"
           WHERE mailbox_connection_id = $1
             AND provider_event_id = $2
           LIMIT 1`,
          [mailbox.id, payload.provider_event_id]
        );

        const row = existing.rows[0];
        const dedupedResult: EmailIngestDbResult = {
          accepted: true,
          deduped: true,
          intake_id: row?.id,
          intake_decision: row?.decision
        };
        if (row?.lead_id) {
          dedupedResult.lead_id = row.lead_id;
        }
        if (row?.conversation_event_id) {
          dedupedResult.event_id = row.conversation_event_id;
        }
        return dedupedResult;
      }

      const intakeId = intakeInsert.rows[0].id;
      await this.appendEmailIntakeAudit(client, {
        intakeId,
        teamId: mailbox.team_id,
        action: 'decision_applied',
        payload: {
          decision: qualification.decision,
          score: qualification.score,
          reasons: qualification.reasons,
          ingest_source: source,
          mode: intakeMode
        }
      });

      if (intakeMode === 'shadow') {
        const legacyResult = await this.ingestEmailDirectCreate(client, mailbox, payload);
        await client.query(
          `UPDATE "EmailIntake"
           SET lead_id = COALESCE($2, lead_id),
               conversation_event_id = COALESCE($3, conversation_event_id),
               review_status = $4,
               updated_at = now()
           WHERE id = $1`,
          [
            intakeId,
            legacyResult.lead_id ?? null,
            legacyResult.event_id ?? null,
            legacyResult.lead_id ? 'lead_created' : 'none'
          ]
        );

        if (qualification.decision !== 'create_lead') {
          this.logger.log(
            `email_intake_shadow_disagreement decision=${qualification.decision} provider=${provider} source=${source}`
          );
        }

        return {
          ...legacyResult,
          intake_id: intakeId,
          intake_decision: qualification.decision,
          precomputed_classification: qualification.classifier
        };
      }

      if (qualification.decision === 'needs_review') {
        await client.query(
          `UPDATE "EmailIntake"
           SET review_status = 'review_pending',
               review_assignee_user_id = COALESCE(review_assignee_user_id, $2),
               updated_at = now()
           WHERE id = $1`,
          [intakeId, mailbox.user_id]
        );

        this.logger.log(`email_intake_decision=needs_review provider=${provider} source=${source}`);

        return {
          accepted: true,
          deduped: false,
          intake_id: intakeId,
          intake_decision: qualification.decision
        };
      }

      if (qualification.decision === 'reject') {
        await client.query(
          `UPDATE "EmailIntake"
           SET review_status = 'rejected',
               reviewed_at = now(),
               updated_at = now()
           WHERE id = $1`,
          [intakeId]
        );

        this.logger.log(`email_intake_decision=reject provider=${provider} source=${source}`);

        return {
          accepted: true,
          deduped: false,
          intake_id: intakeId,
          intake_decision: qualification.decision
        };
      }

      const createResult = await this.ingestEmailDirectCreate(client, mailbox, payload);
      await client.query(
        `UPDATE "EmailIntake"
         SET review_status = 'lead_created',
             lead_id = $2,
             conversation_event_id = $3,
             reviewed_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [intakeId, createResult.lead_id ?? null, createResult.event_id ?? null]
      );

      this.logger.log(`email_intake_decision=create_lead provider=${provider} source=${source}`);

      return {
        ...createResult,
        intake_id: intakeId,
        intake_decision: qualification.decision,
        precomputed_classification: qualification.classifier
      };
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
        const ok = await this.classifyAndPersistEmail(
          ingestResult.event_id,
          ingestResult.lead_id,
          {
            subject,
            body,
            fromEmail
          },
          ingestResult.precomputed_classification
        );
        classificationStatus = ok ? 'completed' : 'failed';
      } else {
        void this.classifyAndPersistEmail(
          ingestResult.event_id,
          ingestResult.lead_id,
          {
            subject,
            body,
            fromEmail
          },
          ingestResult.precomputed_classification
        );
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
    if (ingestResult.intake_id) {
      result.intake_id = ingestResult.intake_id;
    }
    if (ingestResult.intake_decision) {
      result.intake_decision = ingestResult.intake_decision;
    }
    return result;
  }

  async listEmailReviewQueue(
    user: UserContext,
    options: ReviewQueueOptions
  ): Promise<Record<string, unknown>[]> {
    const limit = Math.max(1, Math.min(200, options.limit));
    const includeBody = options.include_body;
    const slaMinutes = this.getInt('EMAIL_INTAKE_REVIEW_SLA_MINUTES', 60, 1, 24 * 365);

    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query<EmailIntakeReviewRow>(
        `SELECT
            i.id,
            i.team_id,
            i.mailbox_connection_id,
            i.mailbox_user_id,
            i.provider,
            i.provider_event_id,
            i.ingest_source,
            i.sender_email,
            i.subject,
            i.raw_body,
            i.metadata,
            i.classifier_json,
            i.score,
            i.decision,
            i.decision_reasons,
            i.review_assignee_user_id,
            i.review_status,
            i.lead_id,
            i.conversation_event_id,
            i.created_at,
            i.updated_at,
            m.email_address AS mailbox_email
         FROM "EmailIntake" i
         JOIN "MailboxConnection" m ON m.id = i.mailbox_connection_id
         WHERE i.review_status = 'review_pending'
         ORDER BY i.created_at ASC
         LIMIT $1`,
        [limit]
      );

      return result.rows.map((row) => {
        const createdAt = this.toIsoDate(row.created_at);
        const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000));
        const decryptedBody = this.rawContentCryptoService.decrypt(row.raw_body) ?? '';
        const metadata = this.toRecord(row.metadata) ?? {};
        const base: Record<string, unknown> = {
          intake_id: row.id,
          mailbox_connection_id: row.mailbox_connection_id,
          mailbox_email: row.mailbox_email,
          provider: row.provider,
          provider_event_id: row.provider_event_id,
          ingest_source: row.ingest_source,
          sender_email: row.sender_email,
          subject: row.subject,
          score: row.score,
          decision: row.decision,
          decision_reasons: row.decision_reasons,
          classifier: row.classifier_json,
          metadata,
          review_assignee_user_id: row.review_assignee_user_id,
          review_status: row.review_status,
          created_at: createdAt,
          age_minutes: ageMinutes,
          sla_minutes: slaMinutes,
          sla_breached: ageMinutes > slaMinutes
        };

        if (includeBody) {
          base.body = decryptedBody;
        } else {
          base.body_preview = decryptedBody.slice(0, 240);
        }

        return base;
      });
    });
  }

  async approveEmailIntake(
    user: UserContext,
    intakeId: string,
    payload?: { reason?: string | undefined }
  ): Promise<{ intake_id: string; status: 'lead_created'; lead_id: string; conversation_event_id?: string | undefined }> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const intake = await this.lockEmailIntake(client, intakeId);
      if (intake.review_status !== 'review_pending') {
        throw new BadRequestException('Intake item is not pending review');
      }

      const ownerAgentId = intake.review_assignee_user_id ?? intake.mailbox_user_id;
      const lead = await this.leadsService.findOrCreateLeadByEmail(client, {
        teamId: intake.team_id,
        ownerAgentId,
        email: intake.sender_email.toLowerCase(),
        source: 'email',
        provenance: {
          intake_origin: 'agent_direct',
          intake_channel_ref: { mailbox_connection_id: intake.mailbox_connection_id },
          broker_assigned: false
        }
      });

      const metadata = this.toRecord(intake.metadata) ?? {};
      const upsertedEvent = await this.upsertEmailConversationEvent(client, {
        leadId: lead.id,
        mailboxConnectionId: intake.mailbox_connection_id,
        providerEventId: intake.provider_event_id,
        direction: 'inbound',
        body: this.rawContentCryptoService.decrypt(intake.raw_body) ?? '',
        subject: intake.subject,
        threadId: typeof metadata.thread_id === 'string' ? metadata.thread_id : null,
        provider: intake.provider,
        timestamp: typeof metadata.timestamp === 'string' ? metadata.timestamp : null
      });

      if (upsertedEvent.event_id) {
        await this.ensureInboundTask(client, lead.id, lead.owner_agent_id);

        const storedClassification = this.toEmailClassification(intake.classifier_json);
        if (storedClassification) {
          await this.persistEmailClassification(client, upsertedEvent.event_id, lead.id, storedClassification);
        }
      }

      await client.query(
        `UPDATE "EmailIntake"
         SET review_status = 'lead_created',
             lead_id = $2,
             conversation_event_id = $3,
             reviewed_by_user_id = $4,
             reviewed_at = now(),
             review_note = $5,
             updated_at = now()
         WHERE id = $1`,
        [intakeId, lead.id, upsertedEvent.event_id ?? null, user.userId, payload?.reason ?? null]
      );

      await this.appendEmailIntakeAudit(client, {
        intakeId,
        teamId: intake.team_id,
        actorUserId: user.userId,
        action: 'approve',
        payload: {
          reason: payload?.reason ?? null,
          lead_id: lead.id,
          conversation_event_id: upsertedEvent.event_id ?? null
        }
      });

      const result: {
        intake_id: string;
        status: 'lead_created';
        lead_id: string;
        conversation_event_id?: string | undefined;
      } = {
        intake_id: intakeId,
        status: 'lead_created',
        lead_id: lead.id
      };
      if (upsertedEvent.event_id) {
        result.conversation_event_id = upsertedEvent.event_id;
      }
      return result;
    });
  }

  async rejectEmailIntake(
    user: UserContext,
    intakeId: string,
    payload?: { reason?: string | undefined }
  ): Promise<{ intake_id: string; status: 'rejected' }> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const intake = await this.lockEmailIntake(client, intakeId);
      if (intake.review_status !== 'review_pending') {
        throw new BadRequestException('Intake item is not pending review');
      }

      await client.query(
        `UPDATE "EmailIntake"
         SET review_status = 'rejected',
             reviewed_by_user_id = $2,
             reviewed_at = now(),
             review_note = $3,
             updated_at = now()
         WHERE id = $1`,
        [intakeId, user.userId, payload?.reason ?? null]
      );

      await this.appendEmailIntakeAudit(client, {
        intakeId,
        teamId: intake.team_id,
        actorUserId: user.userId,
        action: 'reject',
        payload: {
          reason: payload?.reason ?? null
        }
      });

      return {
        intake_id: intakeId,
        status: 'rejected'
      };
    });
  }

  async getEmailIntakeDailyCalibration(
    user: UserContext,
    days: number
  ): Promise<{
    window_days: number;
    daily: Array<Record<string, unknown>>;
    review_backlog: { pending_count: number; oldest_age_minutes: number };
  }> {
    const boundedDays = Math.max(1, Math.min(90, days));
    return this.databaseService.withUserTransaction(user, async (client) => {
      const daily = await client.query<EmailIntakeDailyCalibrationRow>(
        `SELECT
            to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            provider,
            ingest_source,
            COUNT(*)::int AS intake_count,
            COUNT(*) FILTER (WHERE decision = 'create_lead')::int AS create_lead_count,
            COUNT(*) FILTER (WHERE decision = 'needs_review')::int AS needs_review_count,
            COUNT(*) FILTER (WHERE decision = 'reject')::int AS rejected_count,
            COUNT(*) FILTER (WHERE review_status = 'review_pending')::int AS pending_review_count,
            ROUND(AVG(score)::numeric, 2)::text AS avg_score,
            COUNT(*) FILTER (
              WHERE decision <> 'create_lead'
                AND review_status = 'lead_created'
            )::int AS shadow_disagreement_count
         FROM "EmailIntake"
         WHERE created_at >= now() - make_interval(days => $1::int)
         GROUP BY date_trunc('day', created_at), provider, ingest_source
         ORDER BY date_trunc('day', created_at) DESC, provider, ingest_source`,
        [boundedDays]
      );

      const backlog = await client.query<{ pending_count: number; oldest_age_minutes: number }>(
        `SELECT
            COUNT(*)::int AS pending_count,
            COALESCE(
              FLOOR(EXTRACT(EPOCH FROM (now() - MIN(created_at))) / 60)::int,
              0
            ) AS oldest_age_minutes
         FROM "EmailIntake"
         WHERE review_status = 'review_pending'`
      );

      return {
        window_days: boundedDays,
        daily: daily.rows.map((row) => ({
          day: row.day,
          provider: row.provider,
          ingest_source: row.ingest_source,
          intake_count: row.intake_count,
          create_lead_count: row.create_lead_count,
          needs_review_count: row.needs_review_count,
          rejected_count: row.rejected_count,
          pending_review_count: row.pending_review_count,
          avg_score: row.avg_score ? Number(row.avg_score) : null,
          shadow_disagreement_count: row.shadow_disagreement_count
        })),
        review_backlog: {
          pending_count: backlog.rows[0]?.pending_count ?? 0,
          oldest_age_minutes: backlog.rows[0]?.oldest_age_minutes ?? 0
        }
      };
    });
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

  private async ingestEmailDirectCreate(
    client: PoolClient,
    mailbox: { id: string; user_id: string; team_id: string; provider: 'gmail' | 'outlook' },
    payload: EmailWebhookPayload
  ): Promise<EmailIngestDbResult> {
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

    const insertedEvent = await this.upsertEmailConversationEvent(client, {
      leadId: lead.id,
      mailboxConnectionId: mailbox.id,
      providerEventId: payload.provider_event_id,
      direction: payload.direction,
      body: payload.body ?? '',
      subject: payload.subject ?? '',
      threadId: payload.thread_id ?? null,
      provider: mailbox.provider,
      timestamp: payload.timestamp ?? null
    });

    if (insertedEvent.deduped) {
      const deduped: EmailIngestDbResult = {
        accepted: true,
        deduped: true,
        lead_id: lead.id
      };
      if (insertedEvent.event_id) {
        deduped.event_id = insertedEvent.event_id;
      }
      return deduped;
    }

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
    if (insertedEvent.event_id) {
      result.event_id = insertedEvent.event_id;
    }
    return result;
  }

  private async classifyAndPersistEmail(
    eventId: string,
    leadId: string,
    input: { subject: string; body: string; fromEmail: string },
    precomputedClassification?: EmailClassification
  ): Promise<boolean> {
    try {
      const classification = precomputedClassification
        ?? await this.emailClassifierService.classifyInboundEmail({
          subject: input.subject,
          body: input.body,
          fromEmail: input.fromEmail
        });

      await this.databaseService.withSystemTransaction(async (client) => {
        await this.persistEmailClassification(client, eventId, leadId, classification);
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Email classification persistence failed for event ${eventId}: ${message}`);
      return false;
    }
  }

  private async persistEmailClassification(
    client: PoolClient,
    eventId: string,
    leadId: string,
    classification: EmailClassification
  ): Promise<void> {
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
  }

  private async upsertEmailConversationEvent(
    client: PoolClient,
    input: {
      leadId: string;
      mailboxConnectionId: string;
      providerEventId: string;
      direction: 'inbound' | 'outbound';
      body: string;
      subject: string;
      threadId: string | null;
      provider: string;
      timestamp: string | null;
    }
  ): Promise<{ deduped: boolean; event_id?: string | undefined }> {
    const insertResult = await client.query<{ id: string }>(
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
        input.leadId,
        input.mailboxConnectionId,
        input.direction,
        input.providerEventId,
        this.rawContentCryptoService.encrypt(input.body),
        JSON.stringify({
          subject: input.subject,
          thread_id: input.threadId,
          provider: input.provider
        }),
        input.timestamp
      ]
    );

    if (insertResult.rowCount && insertResult.rows[0]?.id) {
      return {
        deduped: false,
        event_id: insertResult.rows[0].id
      };
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id
       FROM "ConversationEvent"
       WHERE channel = 'email'
         AND mailbox_connection_id = $1
         AND provider_event_id = $2
       LIMIT 1`,
      [input.mailboxConnectionId, input.providerEventId]
    );

    return {
      deduped: true,
      event_id: existing.rows[0]?.id
    };
  }

  private async lockEmailIntake(client: PoolClient, intakeId: string): Promise<EmailIntakeReviewRow> {
    const result = await client.query<EmailIntakeReviewRow>(
      `SELECT
          i.id,
          i.team_id,
          i.mailbox_connection_id,
          i.mailbox_user_id,
          i.provider,
          i.provider_event_id,
          i.ingest_source,
          i.sender_email,
          i.subject,
          i.raw_body,
          i.metadata,
          i.classifier_json,
          i.score,
          i.decision,
          i.decision_reasons,
          i.review_assignee_user_id,
          i.review_status,
          i.lead_id,
          i.conversation_event_id,
          i.created_at,
          i.updated_at,
          m.email_address AS mailbox_email
       FROM "EmailIntake" i
       JOIN "MailboxConnection" m ON m.id = i.mailbox_connection_id
       WHERE i.id = $1
       FOR UPDATE`,
      [intakeId]
    );

    if (!result.rowCount || !result.rows[0]) {
      throw new NotFoundException('Intake item not found');
    }

    return result.rows[0];
  }

  private async appendEmailIntakeAudit(
    client: PoolClient,
    input: {
      intakeId: string;
      teamId: string;
      action: string;
      actorUserId?: string | undefined;
      payload?: Record<string, unknown> | undefined;
    }
  ): Promise<void> {
    await client.query(
      `INSERT INTO "EmailIntakeAudit" (
         email_intake_id,
         team_id,
         actor_user_id,
         action,
         payload,
         created_at
       ) VALUES (
         $1,
         $2,
         $3,
         $4,
         $5::jsonb,
         now()
       )`,
      [
        input.intakeId,
        input.teamId,
        input.actorUserId ?? null,
        input.action,
        JSON.stringify(input.payload ?? {})
      ]
    );
  }

  private getEmailIntakeMode(): EmailIntakeMode {
    if (!this.getBoolean('EMAIL_INTAKE_ENABLED', true)) {
      return 'disabled';
    }

    if (this.getBoolean('EMAIL_INTAKE_CUTOVER_ENABLED', false)) {
      return 'cutover';
    }

    if (this.getBoolean('EMAIL_INTAKE_SHADOW_MODE', true)) {
      return 'shadow';
    }

    return 'disabled';
  }

  private getBoolean(key: string, fallback: boolean): boolean {
    const raw = this.configService.get<string | boolean>(key);
    if (raw === undefined || raw === null) {
      return fallback;
    }

    if (typeof raw === 'boolean') {
      return raw;
    }

    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }

    return fallback;
  }

  private getInt(key: string, fallback: number, min: number, max: number): number {
    const raw = this.configService.get<string | number>(key);
    if (raw === undefined || raw === null) {
      return fallback;
    }

    const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      return fallback;
    }

    return Math.max(min, Math.min(max, parsed));
  }

  private toIsoDate(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : value;
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    return null;
  }

  private toEmailClassification(value: unknown): EmailClassification | null {
    const record = this.toRecord(value);
    if (!record) {
      return null;
    }

    if (
      typeof record.kind !== 'string'
      || typeof record.confidence !== 'number'
      || typeof record.urgency !== 'string'
      || typeof record.sentiment !== 'string'
      || typeof record.language !== 'string'
      || typeof record.needs_human_reply !== 'boolean'
      || typeof record.reason !== 'string'
      || typeof record.source !== 'string'
    ) {
      return null;
    }

    return record as unknown as EmailClassification;
  }

  private async resolveMailbox(
    client: PoolClient,
    provider: 'gmail' | 'outlook',
    mailboxConnectionId?: string,
    mailboxEmail?: string
  ): Promise<{ id: string; user_id: string; team_id: string; provider: 'gmail' | 'outlook' } | null> {
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
        [mailboxEmail.toLowerCase(), provider]
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
