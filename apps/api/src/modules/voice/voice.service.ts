import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { escalationRuleSchema, staleRuleSchema, voiceQualificationRuleSchema } from '@mvp/shared-types';
import OpenAI from 'openai';
import { PoolClient } from 'pg';
import { Queue } from 'bullmq';
import WebSocket from 'ws';

import { UserContext } from '../../common/auth/user-context';
import { RawContentCryptoService } from '../../common/crypto/raw-content-crypto.service';
import { DatabaseService } from '../../common/db/database.service';
import { TelnyxClient } from './telnyx.client';
import {
  alignToCallWindow,
  allowsAutoVoiceCalls,
  allowsManualVoiceCalls,
  computeNextAttemptTime,
  extractVoiceStructuredProfile,
  isVoiceProfileSufficient,
  mergeVoiceProfileFields,
  normalizeE164,
  pickQualificationStatus,
  shouldSuppressAutoVoiceCalls,
  VoiceStructuredProfile
} from './voice-qualification.utils';
import {
  createVoiceLabSessionSchema,
  internalVoiceDispatchSchema,
  listVoiceLabSessionsSchema,
  voiceLabConfigUpdateSchema,
  voiceLabTranscriptQuerySchema
} from './voice.schemas';

interface TeamVoiceRules {
  timezone: string;
  config: ReturnType<typeof voiceQualificationRuleSchema.parse>;
}

interface TeamVoiceRulesRow {
  stale_rules: unknown;
  escalation_rules: unknown;
}

interface VoiceLabLeadRow {
  id: string;
  state: string;
  primary_email: string | null;
  primary_phone: string | null;
  source: string;
  summary: string | null;
  fields_json: Record<string, unknown> | null;
}

interface LeadLookupRow {
  id: string;
  team_id: string;
  owner_agent_id: string;
  state: string;
  primary_phone: string | null;
  fields_json: Record<string, unknown> | null;
  summary: string | null;
}

interface VoiceSessionRow {
  id: string;
  team_id: string;
  lead_id: string;
  owner_agent_id: string;
  initiated_by_user_id: string | null;
  trigger_mode: 'manual' | 'auto';
  status: string;
  destination_number: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  provider: string;
  provider_call_control_id: string | null;
  provider_call_leg_id: string | null;
  provider_payload: Record<string, unknown>;
  qualification_payload: Record<string, unknown>;
  summary: string | null;
  error_text: string | null;
  transcript_event_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_webhook_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DispatchTargetRow {
  id: string;
}

interface DispatchSessionRow {
  id: string;
  team_id: string;
  lead_id: string;
  owner_agent_id: string;
  trigger_mode: 'manual' | 'auto';
  status: string;
  destination_number: string;
  attempt_count: number;
  max_attempts: number;
  provider_payload: Record<string, unknown>;
  provider_call_control_id: string | null;
  primary_phone: string | null;
  lead_state: string;
  summary: string | null;
  fields_json: Record<string, unknown> | null;
  stale_rules: unknown;
  escalation_rules: unknown;
}

interface TeamPhoneRow {
  id: string;
  number: string;
}

interface TelnyxWebhookEnvelope {
  event_id: string | null;
  event_type: string;
  occurred_at: string | null;
  payload: Record<string, unknown>;
}

interface SessionLookupForWebhook {
  id: string;
  team_id: string;
  lead_id: string;
  owner_agent_id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  provider_payload: Record<string, unknown>;
  provider_call_control_id: string | null;
  provider_call_leg_id: string | null;
  transcript_event_id: string | null;
  stale_rules: unknown;
  escalation_rules: unknown;
  lead_state: string;
  fields_json: Record<string, unknown> | null;
  summary: string | null;
}

interface FinalizeSessionPayload {
  status: 'qualified' | 'partial' | 'opt_out' | 'escalated' | 'not_interested';
  structuredProfile: VoiceStructuredProfile;
  summary: string;
  recommendedNextAction: string;
  transcript: string;
  transcriptStatus: 'complete' | 'partial' | 'unavailable';
  providerPayload: Record<string, unknown>;
}

interface OpenAiExtraction {
  summary: string;
  qualification_status: 'qualified' | 'partial' | 'opt_out' | 'escalated' | 'not_interested';
  recommended_next_action: 'send_listings' | 'book_showing' | 'callback' | 'transfer_to_agent' | 'nurture' | 'none';
  structured_profile: VoiceStructuredProfile;
}

interface DispatchSummary {
  processed: number;
  dialed: number;
  rescheduled: number;
  failed: number;
  completed: number;
  auto_created: number;
}

interface OpenAiRealtimeWebhookEnvelope {
  event_type: string;
  call_id: string | null;
  payload: Record<string, unknown>;
}

@Injectable()
export class VoiceService implements OnModuleDestroy {
  private readonly logger = new Logger(VoiceService.name);
  private readonly openAiClient?: OpenAI;
  private readonly openAiModel: string;
  private readonly dispatchQueue: Queue;

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly rawContentCryptoService: RawContentCryptoService,
    private readonly telnyxClient: TelnyxClient
  ) {
    const openAiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openAiModel = this.configService.get<string>('OPENAI_MODEL', 'gpt-4o-mini');
    if (openAiKey) {
      this.openAiClient = new OpenAI({ apiKey: openAiKey });
    }

    this.dispatchQueue = new Queue('voice-dispatch', {
      connection: {
        url: this.configService.getOrThrow<string>('REDIS_URL')
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.dispatchQueue.close();
  }

  async getVoiceLabConfig(user: UserContext): Promise<Record<string, unknown>> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const teamResult = await client.query<TeamVoiceRulesRow>(
        `SELECT stale_rules, escalation_rules
         FROM "Team"
         WHERE id = $1
         LIMIT 1`,
        [user.teamId]
      );

      if (!teamResult.rowCount || !teamResult.rows[0]) {
        throw new NotFoundException('Team not found');
      }

      const rules = this.parseTeamVoiceRules(teamResult.rows[0]);

      const leads = await client.query<VoiceLabLeadRow>(
        `SELECT l.id,
                l.state,
                l.primary_email,
                l.primary_phone,
                l.source,
                d.summary,
                d.fields_json
         FROM "Lead" l
         LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = l.id
         WHERE l.team_id = $1
         ORDER BY l.created_at DESC
         LIMIT 40`,
        [user.teamId]
      );

      return {
        timezone: rules.timezone,
        voice_qualification: rules.config,
        dummy_leads: leads.rows.map((row) => ({
          id: row.id,
          state: row.state,
          source: row.source,
          contact: row.primary_phone ?? row.primary_email,
          primary_phone: row.primary_phone,
          summary: row.summary,
          voice_contact_status:
            typeof row.fields_json?.voice_contact_status === 'string'
              ? row.fields_json.voice_contact_status
              : null
        }))
      };
    });
  }

  async updateVoiceLabConfig(user: UserContext, payload: unknown): Promise<Record<string, unknown>> {
    const patch = voiceLabConfigUpdateSchema.parse(payload);

    return this.databaseService.withUserTransaction(user, async (client) => {
      const teamResult = await client.query<TeamVoiceRulesRow>(
        `SELECT stale_rules, escalation_rules
         FROM "Team"
         WHERE id = $1
         LIMIT 1`,
        [user.teamId]
      );

      if (!teamResult.rowCount || !teamResult.rows[0]) {
        throw new NotFoundException('Team not found');
      }

      const staleRules = staleRuleSchema.parse(teamResult.rows[0].stale_rules);
      const escalationRules = escalationRuleSchema.parse(teamResult.rows[0].escalation_rules);
      const nextVoiceRules = voiceQualificationRuleSchema.parse({
        ...escalationRules.voice_qualification,
        ...patch
      });

      const nextEscalationRules = {
        ...escalationRules,
        voice_qualification: nextVoiceRules
      };

      await client.query(
        `UPDATE "Team"
         SET escalation_rules = $2::jsonb,
             stale_rules = $3::jsonb
         WHERE id = $1`,
        [user.teamId, JSON.stringify(nextEscalationRules), JSON.stringify(staleRules)]
      );

      return {
        timezone: staleRules.timezone,
        voice_qualification: nextVoiceRules
      };
    });
  }

  async createManualVoiceSession(user: UserContext, payload: unknown): Promise<Record<string, unknown>> {
    const parsed = createVoiceLabSessionSchema.parse(payload);

    if (!this.telnyxClient.isConfigured()) {
      throw new BadRequestException('Outbound voice is not configured. TELNYX_API_KEY is missing.');
    }

    const session = await this.databaseService.withUserTransaction(user, async (client) => {
      const leadResult = await client.query<LeadLookupRow>(
        `SELECT l.id,
                l.team_id,
                l.owner_agent_id,
                l.state,
                l.primary_phone,
                d.fields_json,
                d.summary
         FROM "Lead" l
         LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = l.id
         WHERE l.id = $1
           AND l.team_id = $2
         LIMIT 1`,
        [parsed.lead_id, user.teamId]
      );

      if (!leadResult.rowCount || !leadResult.rows[0]) {
        throw new NotFoundException('Lead not found');
      }

      const lead = leadResult.rows[0];
      const rules = await this.getTeamVoiceRules(client, user.teamId);
      if (!rules.config.enabled || !allowsManualVoiceCalls(rules.config.mode)) {
        throw new ForbiddenException('Voice Lab manual mode is disabled in team configuration');
      }

      const normalizedDestination = normalizeE164(parsed.destination_number ?? lead.primary_phone ?? '');
      if (!normalizedDestination) {
        throw new BadRequestException('A valid destination phone number is required in E.164 format');
      }

      const profile = this.profileFromDerivedFields(lead.fields_json);
      const qualificationStatus = pickQualificationStatus(profile);

      const insert = await client.query<VoiceSessionRow>(
        `INSERT INTO "VoiceQualificationSession" (
           team_id,
           lead_id,
           owner_agent_id,
           initiated_by_user_id,
           trigger_mode,
           status,
           destination_number,
           max_attempts,
           next_attempt_at,
           qualification_payload,
           summary
         ) VALUES (
           $1,
           $2,
           $3,
           $4,
           'manual',
           'queued',
           $5,
           $6,
           now(),
           $7::jsonb,
           $8
         )
         RETURNING *`,
        [
          user.teamId,
          lead.id,
          lead.owner_agent_id,
          user.userId,
          normalizedDestination,
          rules.config.max_attempts,
          JSON.stringify({
            qualification_status: qualificationStatus,
            structured_profile: profile,
            transcript_status: 'unavailable'
          }),
          lead.summary ?? null
        ]
      );

      if (!insert.rowCount || !insert.rows[0]) {
        throw new Error('Unable to create voice session');
      }

      return insert.rows[0];
    });

    await this.enqueueDispatch('manual_session_created', session.id);

    // Fallback path: attempt immediate dispatch from API so manual calls still work
    // even when the background worker is not running.
    try {
      await this.dispatchSingleSession(session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Immediate manual voice dispatch failed for session ${session.id}: ${message}`);
    }

    return this.mapSessionRecord(session, null);
  }

  async listVoiceLabSessions(user: UserContext, query: unknown): Promise<Record<string, unknown>[]> {
    const parsed = listVoiceLabSessionsSchema.parse(query ?? {});

    return this.databaseService.withUserTransaction(user, async (client) => {
      const params: unknown[] = [user.teamId];
      const where: string[] = ['v.team_id = $1'];
      if (parsed.lead_id) {
        params.push(parsed.lead_id);
        where.push(`v.lead_id = $${params.length}`);
      }

      params.push(parsed.limit);

      const result = await client.query<VoiceSessionRow & { lead_state: string }>(
        `SELECT v.*,
                l.state AS lead_state
         FROM "VoiceQualificationSession" v
         JOIN "Lead" l ON l.id = v.lead_id
         WHERE ${where.join(' AND ')}
         ORDER BY v.created_at DESC
         LIMIT $${params.length}`,
        params
      );

      return result.rows.map((row) => this.mapSessionRecord(row, row.lead_state));
    });
  }

  async getVoiceSessionTranscript(
    user: UserContext,
    sessionId: string,
    query: unknown
  ): Promise<Record<string, unknown>> {
    const parsedQuery = voiceLabTranscriptQuerySchema.parse(query ?? {});

    return this.databaseService.withUserTransaction(user, async (client) => {
      const sessionResult = await client.query<VoiceSessionRow & { lead_state: string }>(
        `SELECT v.*,
                l.state AS lead_state
         FROM "VoiceQualificationSession" v
         JOIN "Lead" l ON l.id = v.lead_id
         WHERE v.id = $1
           AND v.team_id = $2
         LIMIT 1`,
        [sessionId, user.teamId]
      );

      if (!sessionResult.rowCount || !sessionResult.rows[0]) {
        throw new NotFoundException('Voice session not found');
      }

      const session = sessionResult.rows[0];
      if (!session.transcript_event_id) {
        return {
          session_id: sessionId,
          transcript_status: 'unavailable',
          transcript: null
        };
      }

      if (session.lead_state !== 'Stale') {
        throw new ForbiddenException('Transcript raw access is only available for stale leads');
      }

      if (!parsedQuery.reason) {
        throw new ForbiddenException('A reason is required for transcript raw access');
      }

      await client.query(
        `INSERT INTO "AuditLog" (actor_id, lead_id, action, reason)
         VALUES ($1, $2, 'TEAM_LEAD_RAW_ACCESS', $3)`,
        [user.userId, session.lead_id, parsedQuery.reason]
      );

      const event = await client.query<{
        id: string;
        created_at: string;
        raw_body: Buffer | null;
        meta: Record<string, unknown>;
      }>(
        `SELECT id, created_at, raw_body, meta
         FROM "ConversationEvent"
         WHERE id = $1
         LIMIT 1`,
        [session.transcript_event_id]
      );

      const eventRow = event.rows[0];
      if (!eventRow) {
        return {
          session_id: sessionId,
          transcript_status: 'unavailable',
          transcript: null
        };
      }

      return {
        session_id: sessionId,
        transcript_status: 'complete',
        transcript_event_id: eventRow.id,
        created_at: eventRow.created_at,
        transcript: this.rawContentCryptoService.decrypt(eventRow.raw_body),
        meta: eventRow.meta
      };
    });
  }

  async dispatchDueSessions(payload: unknown): Promise<DispatchSummary> {
    const options = internalVoiceDispatchSchema.parse(payload ?? {});

    const summary: DispatchSummary = {
      processed: 0,
      dialed: 0,
      rescheduled: 0,
      failed: 0,
      completed: 0,
      auto_created: 0
    };

    if (options.include_auto) {
      summary.auto_created = await this.createAutoSessions(options.limit);
    }

    const targets = await this.databaseService.withSystemTransaction(async (client) => {
      const due = await client.query<DispatchTargetRow>(
        `SELECT id
         FROM "VoiceQualificationSession"
         WHERE status = 'queued'
           AND next_attempt_at IS NOT NULL
           AND next_attempt_at <= now()
         ORDER BY next_attempt_at ASC
         LIMIT $1`,
        [options.limit]
      );
      return due.rows;
    });

    for (const target of targets) {
      summary.processed += 1;

      const result = await this.dispatchSingleSession(target.id);
      if (result === 'dialed') {
        summary.dialed += 1;
      } else if (result === 'rescheduled') {
        summary.rescheduled += 1;
      } else if (result === 'failed') {
        summary.failed += 1;
      } else if (result === 'completed') {
        summary.completed += 1;
      }
    }

    return summary;
  }

  isTelnyxWebhookSignatureValid(rawBody: string, timestamp?: string, signature?: string): boolean {
    const publicKey = this.configService.get<string>('TELNYX_WEBHOOK_PUBLIC_KEY');
    if (!publicKey) {
      return true;
    }

    return this.telnyxClient.verifyWebhookSignature(rawBody, timestamp, signature);
  }

  async ingestTelnyxVoiceWebhook(body: unknown): Promise<{ accepted: boolean; ignored?: boolean; session_id?: string }> {
    const envelope = this.extractWebhookEnvelope(body);
    if (!envelope) {
      return { accepted: true, ignored: true };
    }
    const eventType = this.normalizeTelnyxVoiceEventType(envelope.event_type);

    return this.databaseService.withSystemTransaction(async (client) => {
      const session = await this.resolveWebhookSession(client, envelope.payload);
      if (!session) {
        this.logger.warn(`No voice session found for webhook event type=${eventType}`);
        return { accepted: true, ignored: true };
      }

      const rules = this.parseTeamVoiceRules({
        stale_rules: session.stale_rules,
        escalation_rules: session.escalation_rules
      });

      await client.query(
        `UPDATE "VoiceQualificationSession"
         SET last_webhook_at = now(),
             provider_payload = provider_payload || $2::jsonb
         WHERE id = $1`,
        [
          session.id,
          JSON.stringify({
            last_event: {
              event_id: envelope.event_id,
              event_type: eventType,
              raw_event_type: envelope.event_type,
              occurred_at: envelope.occurred_at,
              payload: envelope.payload
            }
          })
        ]
      );

      if (eventType === 'call.answered') {
        await this.handleAnsweredEvent(client, session, rules, envelope.payload);
        return { accepted: true, session_id: session.id };
      }

      if (eventType === 'call.ai_gather.ended') {
        await this.handleGatherEndedEvent(client, session, rules, envelope);
        return { accepted: true, session_id: session.id };
      }

      if (eventType === 'call.hangup' || eventType === 'call.failed') {
        await this.handleTerminalEvent(client, session, rules, eventType, envelope.payload);
        return { accepted: true, session_id: session.id };
      }

      if (eventType === 'call.initiated' || eventType === 'call.ringing') {
        await client.query(
          `UPDATE "VoiceQualificationSession"
           SET status = CASE WHEN status = 'queued' THEN 'dialing' ELSE status END,
               provider_call_control_id = COALESCE(provider_call_control_id, $2),
               provider_call_leg_id = COALESCE(provider_call_leg_id, $3)
           WHERE id = $1`,
          [
            session.id,
            this.pickString(envelope.payload, ['call_control_id', 'call_session_id']),
            this.pickString(envelope.payload, ['call_leg_id'])
          ]
        );
        return { accepted: true, session_id: session.id };
      }

      return { accepted: true, ignored: true, session_id: session.id };
    });
  }

  private normalizeTelnyxVoiceEventType(value: string): string {
    const normalized = value.trim().toLowerCase();

    switch (normalized) {
      case 'call_answered':
      case 'call.answered':
        return 'call.answered';
      case 'call_initiated':
      case 'call.initiated':
        return 'call.initiated';
      case 'call_ringing':
      case 'call.ringing':
        return 'call.ringing';
      case 'call_hangup':
      case 'call.hangup':
        return 'call.hangup';
      case 'call_failed':
      case 'call.failed':
        return 'call.failed';
      case 'call_ai_gather_ended':
      case 'call.ai_gather.ended':
      case 'call.ai.gather.ended':
        return 'call.ai_gather.ended';
      default:
        return normalized;
    }
  }

  async ingestOpenAiRealtimeWebhook(body: unknown): Promise<{ accepted: boolean; ignored?: boolean; call_id?: string }> {
    const envelope = this.extractOpenAiRealtimeWebhookEnvelope(body);
    if (!envelope) {
      return { accepted: true, ignored: true };
    }

    if (envelope.event_type !== 'realtime.call.incoming') {
      return { accepted: true, ignored: true };
    }

    if (!envelope.call_id) {
      this.logger.warn('OpenAI realtime incoming webhook missing call_id');
      return { accepted: true, ignored: true };
    }

    try {
      await this.acceptOpenAiRealtimeCall(envelope.call_id);
      this.startOpenAiRealtimeGreeting(envelope.call_id);
      return { accepted: true, call_id: envelope.call_id };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Failed to accept OpenAI realtime call ${envelope.call_id}: ${message}`);
      return { accepted: false, call_id: envelope.call_id };
    }
  }

  private async enqueueDispatch(reason: string, sessionId: string): Promise<void> {
    try {
      await this.dispatchQueue.add(
        'dispatch-due',
        {
          reason,
          session_id: sessionId,
          queued_at: new Date().toISOString()
        },
        {
          removeOnComplete: 100,
          removeOnFail: 100
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Unable to enqueue voice-dispatch: ${message}`);
    }
  }

  private mapSessionRecord(row: VoiceSessionRow & { lead_state?: string }, leadState: string | null): Record<string, unknown> {
    return {
      id: row.id,
      lead_id: row.lead_id,
      owner_agent_id: row.owner_agent_id,
      trigger_mode: row.trigger_mode,
      status: row.status,
      destination_number: row.destination_number,
      attempt_count: row.attempt_count,
      max_attempts: row.max_attempts,
      next_attempt_at: row.next_attempt_at,
      provider_call_control_id: row.provider_call_control_id,
      provider_call_leg_id: row.provider_call_leg_id,
      summary: row.summary,
      qualification_payload: row.qualification_payload,
      error_text: row.error_text,
      transcript_event_id: row.transcript_event_id,
      transcript_available: Boolean(row.transcript_event_id),
      lead_state: leadState,
      started_at: row.started_at,
      ended_at: row.ended_at,
      last_webhook_at: row.last_webhook_at,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private parseTeamVoiceRules(row: TeamVoiceRulesRow): TeamVoiceRules {
    const staleRules = staleRuleSchema.parse(row.stale_rules ?? {});
    const escalationRules = escalationRuleSchema.parse(row.escalation_rules ?? {});
    const parsedVoiceRules = voiceQualificationRuleSchema.parse(escalationRules.voice_qualification ?? {});
    const defaultModel = this.configService.get<string>('TELNYX_DEFAULT_ASSISTANT_MODEL');
    const defaultVoice = this.configService.get<string>('TELNYX_DEFAULT_ASSISTANT_VOICE');
    const defaultProvider = this.configService.get<'telnyx_ai' | 'openai_sip'>(
      'VOICE_ASSISTANT_PROVIDER_DEFAULT',
      'openai_sip'
    );
    const config = voiceQualificationRuleSchema.parse({
      ...parsedVoiceRules,
      assistant_provider: defaultProvider && parsedVoiceRules.assistant_provider === 'openai_sip'
        ? defaultProvider
        : parsedVoiceRules.assistant_provider,
      assistant_model: defaultModel && parsedVoiceRules.assistant_model === 'gpt-4o-mini'
        ? defaultModel
        : parsedVoiceRules.assistant_model,
      assistant_voice: defaultVoice && parsedVoiceRules.assistant_voice === 'AWS.Polly.Joanna-Neural'
        ? defaultVoice
        : parsedVoiceRules.assistant_voice
    });

    return {
      timezone: staleRules.timezone || 'UTC',
      config
    };
  }

  private async getTeamVoiceRules(client: PoolClient, teamId: string): Promise<TeamVoiceRules> {
    const result = await client.query<TeamVoiceRulesRow>(
      `SELECT stale_rules, escalation_rules
       FROM "Team"
       WHERE id = $1
       LIMIT 1`,
      [teamId]
    );

    if (!result.rowCount || !result.rows[0]) {
      throw new NotFoundException('Team not found');
    }

    return this.parseTeamVoiceRules(result.rows[0]);
  }

  private profileFromDerivedFields(fields: Record<string, unknown> | null): VoiceStructuredProfile {
    const source = fields ?? {};

    const parseNumber = (value: unknown): number | null => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = Number.parseFloat(value.replace(/[$,]/g, ''));
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return null;
    };

    const stringValue = (value: unknown): string | null => {
      if (typeof value !== 'string') {
        return null;
      }
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : null;
    };

    const locationValue = source.location_preferences;
    const locations = Array.isArray(locationValue)
      ? locationValue
        .map((value) => stringValue(value))
        .filter((value): value is string => Boolean(value))
      : [];

    return {
      intent: stringValue(source.intent),
      property_type: stringValue(source.property_type),
      budget_min: parseNumber(source.budget_min),
      budget_max: parseNumber(source.budget_max),
      budget_approx: parseNumber(source.budget_approx),
      location_preferences: locations,
      timeline: stringValue(source.timeline),
      mortgage_status: stringValue(source.mortgage_status),
      working_with_agent: stringValue(source.working_with_agent),
      preferred_contact_method: stringValue(source.preferred_contact_method),
      listing_reference: stringValue(source.listing_reference)
    };
  }

  private extractWebhookEnvelope(body: unknown): TelnyxWebhookEnvelope | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }

    const root = body as Record<string, unknown>;
    const data = this.toObject(root.data) ?? root;
    const payload = this.toObject(data.payload) ?? this.toObject(root.payload) ?? {};

    const eventTypeRaw = data.event_type ?? root.event_type;
    if (typeof eventTypeRaw !== 'string' || eventTypeRaw.trim().length === 0) {
      return null;
    }

    return {
      event_id: typeof data.id === 'string' ? data.id : null,
      event_type: eventTypeRaw,
      occurred_at: typeof data.occurred_at === 'string' ? data.occurred_at : null,
      payload
    };
  }

  private async resolveWebhookSession(client: PoolClient, payload: Record<string, unknown>): Promise<SessionLookupForWebhook | null> {
    const callControlId = this.pickString(payload, ['call_control_id', 'call_session_id']);
    const callLegId = this.pickString(payload, ['call_leg_id']);

    if (callControlId) {
      const byControl = await client.query<SessionLookupForWebhook>(
        `SELECT v.*, t.stale_rules, t.escalation_rules, l.state AS lead_state, d.fields_json, d.summary
         FROM "VoiceQualificationSession" v
         JOIN "Team" t ON t.id = v.team_id
         JOIN "Lead" l ON l.id = v.lead_id
         LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = v.lead_id
         WHERE v.provider_call_control_id = $1
         ORDER BY v.created_at DESC
         LIMIT 1`,
        [callControlId]
      );
      if (byControl.rowCount && byControl.rows[0]) {
        return byControl.rows[0];
      }
    }

    if (callLegId) {
      const byLeg = await client.query<SessionLookupForWebhook>(
        `SELECT v.*, t.stale_rules, t.escalation_rules, l.state AS lead_state, d.fields_json, d.summary
         FROM "VoiceQualificationSession" v
         JOIN "Team" t ON t.id = v.team_id
         JOIN "Lead" l ON l.id = v.lead_id
         LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = v.lead_id
         WHERE v.provider_call_leg_id = $1
         ORDER BY v.created_at DESC
         LIMIT 1`,
        [callLegId]
      );
      if (byLeg.rowCount && byLeg.rows[0]) {
        return byLeg.rows[0];
      }
    }

    const sessionIdFromClientState = this.extractSessionIdFromClientState(payload);
    if (sessionIdFromClientState) {
      const bySessionId = await client.query<SessionLookupForWebhook>(
        `SELECT v.*, t.stale_rules, t.escalation_rules, l.state AS lead_state, d.fields_json, d.summary
         FROM "VoiceQualificationSession" v
         JOIN "Team" t ON t.id = v.team_id
         JOIN "Lead" l ON l.id = v.lead_id
         LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = v.lead_id
         WHERE v.id = $1
         LIMIT 1`,
        [sessionIdFromClientState]
      );
      if (bySessionId.rowCount && bySessionId.rows[0]) {
        return bySessionId.rows[0];
      }
    }

    return null;
  }

  private extractSessionIdFromClientState(payload: Record<string, unknown>): string | null {
    const clientStateRaw = payload.client_state;
    if (typeof clientStateRaw !== 'string' || clientStateRaw.trim().length === 0) {
      return null;
    }

    try {
      const decoded = JSON.parse(Buffer.from(clientStateRaw, 'base64').toString('utf8')) as Record<string, unknown>;
      const sessionId = decoded.session_id;
      return typeof sessionId === 'string' ? sessionId : null;
    } catch {
      return null;
    }
  }

  private async handleAnsweredEvent(
    client: PoolClient,
    session: SessionLookupForWebhook,
    rules: TeamVoiceRules,
    payload: Record<string, unknown>
  ): Promise<void> {
    const callControlId = this.pickString(payload, ['call_control_id', 'call_session_id']) ?? session.provider_call_control_id;
    if (!callControlId) {
      return;
    }

    const callLegId = this.pickString(payload, ['call_leg_id']) ?? session.provider_call_leg_id;
    const existingProviderPayload = this.toObject(session.provider_payload) ?? {};
    const provider = rules.config.assistant_provider;
    const gatherAlreadyStarted = Boolean(existingProviderPayload.ai_gather_started);
    const sipAlreadyTransferred = Boolean(
      existingProviderPayload.openai_sip_transferred
      || existingProviderPayload.openai_sip_referred
    );

    let payloadPatch: Record<string, unknown>;
    if (provider === 'openai_sip') {
      const sipUri = this.configService.get<string>('OPENAI_REALTIME_SIP_URI') ?? '';
      const trimmedSipUri = sipUri.trim();

      if (trimmedSipUri.length === 0) {
        this.logger.warn(
          `Session ${session.id}: assistant_provider=openai_sip but OPENAI_REALTIME_SIP_URI is missing; falling back to telnyx_ai`
        );

        if (!gatherAlreadyStarted) {
          await this.startTelnyxAiGather(callControlId, session, rules);
        }

        payloadPatch = {
          assistant_provider: 'telnyx_ai',
          ai_gather_started: true,
          openai_sip_config_missing: true
        };
      } else {
        if (!sipAlreadyTransferred) {
          await this.telnyxClient.referCallToSip({
            callControlId,
            sipAddress: trimmedSipUri,
            customHeaders: {
              'x-suivo-session-id': session.id,
              'x-suivo-lead-id': session.lead_id
            }
          });
        }

        payloadPatch = {
          assistant_provider: 'openai_sip',
          openai_sip_transferred: true,
          // Backward-compatible flag for older session payload readers.
          openai_sip_referred: true,
          openai_sip_target: this.redactSipUri(trimmedSipUri)
        };
      }
    } else {
      if (!gatherAlreadyStarted) {
        await this.startTelnyxAiGather(callControlId, session, rules);
      }
      payloadPatch = {
        assistant_provider: 'telnyx_ai',
        ai_gather_started: true
      };
    }

    await client.query(
      `UPDATE "VoiceQualificationSession"
       SET status = 'in_progress',
           started_at = COALESCE(started_at, now()),
           provider_call_control_id = COALESCE(provider_call_control_id, $2),
           provider_call_leg_id = COALESCE(provider_call_leg_id, $3),
           provider_payload = provider_payload || $4::jsonb
       WHERE id = $1`,
      [session.id, callControlId, callLegId, JSON.stringify(payloadPatch)]
    );
  }

  private async handleGatherEndedEvent(
    client: PoolClient,
    session: SessionLookupForWebhook,
    _rules: TeamVoiceRules,
    envelope: TelnyxWebhookEnvelope
  ): Promise<void> {
    const transcript = this.extractTranscript(envelope.payload);
    const structuredProfile = extractVoiceStructuredProfile(envelope.payload);
    const statusHint = this.extractStatusHint(envelope.payload);
    const recommendedHint = this.extractRecommendedAction(envelope.payload);
    const summaryHint = this.extractSummary(envelope.payload);

    const extraction = await this.resolveExtraction({
      transcript,
      summaryHint,
      structuredHint: structuredProfile,
      statusHint,
      recommendedHint,
      existingProfile: this.profileFromDerivedFields(session.fields_json)
    });

    let finalStatus = extraction.qualification_status;
    if (this.detectOptOutSignal(transcript, envelope.payload)) {
      finalStatus = 'opt_out';
    }
    if (this.detectEscalationSignal(transcript, envelope.payload)) {
      finalStatus = 'escalated';
    }

    const transcriptStatus: 'complete' | 'partial' | 'unavailable' = transcript ? 'complete' : 'unavailable';

    await this.finalizeSession(client, session, {
      status: finalStatus,
      structuredProfile: extraction.structured_profile,
      summary: extraction.summary,
      recommendedNextAction: extraction.recommended_next_action,
      transcript,
      transcriptStatus,
      providerPayload: {
        gather_event_id: envelope.event_id,
        gather_payload: envelope.payload
      }
    });
  }

  private async handleTerminalEvent(
    client: PoolClient,
    session: SessionLookupForWebhook,
    rules: TeamVoiceRules,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const terminalStatuses = new Set(['completed', 'failed', 'opt_out', 'escalated', 'unreachable', 'cancelled']);
    if (terminalStatuses.has(session.status)) {
      return;
    }

    if (session.transcript_event_id) {
      await client.query(
        `UPDATE "VoiceQualificationSession"
         SET status = 'completed',
             ended_at = now(),
             provider_payload = provider_payload || $2::jsonb
         WHERE id = $1`,
        [
          session.id,
          JSON.stringify({
            terminal_event: {
              type: eventType,
              payload
            }
          })
        ]
      );
      return;
    }

    const providerPayload = this.toObject(session.provider_payload) ?? {};
    const routedToOpenAiSip = providerPayload.openai_sip_transferred === true
      || providerPayload.openai_sip_referred === true
      || providerPayload.assistant_provider === 'openai_sip';

    if (routedToOpenAiSip) {
      const transcript = this.extractTranscript(payload);
      const structuredHint = extractVoiceStructuredProfile(payload);
      const statusHint = this.extractStatusHint(payload) ?? (transcript ? null : 'partial');
      const recommendedHint = this.extractRecommendedAction(payload) ?? (transcript ? null : 'callback');
      const summaryHint = this.extractSummary(payload)
        ?? `Voice qualification call ${eventType === 'call.failed' ? 'ended with a provider failure' : 'completed'} via OpenAI realtime SIP assistant.`;

      const extraction = await this.resolveExtraction({
        transcript,
        summaryHint,
        structuredHint,
        statusHint,
        recommendedHint,
        existingProfile: this.profileFromDerivedFields(session.fields_json)
      });

      let finalStatus = extraction.qualification_status;
      if (this.detectOptOutSignal(transcript, payload)) {
        finalStatus = 'opt_out';
      }
      if (this.detectEscalationSignal(transcript, payload)) {
        finalStatus = 'escalated';
      }

      const transcriptStatus: 'complete' | 'partial' | 'unavailable' = transcript
        ? 'complete'
        : (summaryHint ? 'partial' : 'unavailable');

      await this.finalizeSession(client, session, {
        status: finalStatus,
        structuredProfile: extraction.structured_profile,
        summary: extraction.summary,
        recommendedNextAction: extraction.recommended_next_action,
        transcript,
        transcriptStatus,
        providerPayload: {
          assistant_provider: 'openai_sip',
          terminal_event: {
            type: eventType,
            payload
          }
        }
      });
      return;
    }

    const nextAttemptCount = session.attempt_count;
    if (nextAttemptCount >= session.max_attempts) {
      await this.markSessionUnreachable(client, session.id, session.lead_id, session.owner_agent_id, `${eventType}: max attempts reached`);
      return;
    }

    const offsetMinutes = this.resolveRetryOffsetMinutes(rules.config.retry_schedule_minutes, nextAttemptCount);
    const nextAttemptAt = computeNextAttemptTime(new Date(), offsetMinutes, {
      timeZone: rules.timezone,
      callWindowStart: rules.config.call_window_start,
      callWindowEnd: rules.config.call_window_end,
      quietWindowStart: rules.config.quiet_window_start,
      quietWindowEnd: rules.config.quiet_window_end
    });

    await client.query(
      `UPDATE "VoiceQualificationSession"
       SET status = 'queued',
           next_attempt_at = $2,
           error_text = $3,
           provider_payload = provider_payload || $4::jsonb
       WHERE id = $1`,
      [
        session.id,
        nextAttemptAt.toISOString(),
        `${eventType}: call ended before qualification`,
        JSON.stringify({
          terminal_event: {
            type: eventType,
            payload
          }
        })
      ]
    );
  }

  private async resolveExtraction(args: {
    transcript: string;
    summaryHint: string | null;
    structuredHint: VoiceStructuredProfile;
    statusHint: OpenAiExtraction['qualification_status'] | null;
    recommendedHint: OpenAiExtraction['recommended_next_action'] | null;
    existingProfile: VoiceStructuredProfile;
  }): Promise<OpenAiExtraction> {
    const mergedHint = this.mergeStructuredProfile(args.existingProfile, args.structuredHint);

    if (!args.transcript && args.summaryHint) {
      return {
        summary: args.summaryHint,
        qualification_status: args.statusHint ?? pickQualificationStatus(mergedHint),
        recommended_next_action: args.recommendedHint ?? 'callback',
        structured_profile: mergedHint
      };
    }

    if (!this.openAiClient || !args.transcript) {
      const fallbackStatus = args.statusHint ?? pickQualificationStatus(mergedHint);
      return {
        summary:
          args.summaryHint
          ?? (fallbackStatus === 'qualified'
            ? 'Lead completed AI qualification call with usable profile data.'
            : 'Lead completed AI qualification call with partial profile data.'),
        qualification_status: fallbackStatus,
        recommended_next_action: args.recommendedHint ?? (fallbackStatus === 'qualified' ? 'send_listings' : 'callback'),
        structured_profile: mergedHint
      };
    }

    const prompt = [
      'Extract a structured voice-qualification result from this transcript.',
      'Return strict JSON with keys: summary, qualification_status, recommended_next_action, structured_profile.',
      'Allowed qualification_status: qualified, partial, opt_out, escalated, not_interested.',
      'Allowed recommended_next_action: send_listings, book_showing, callback, transfer_to_agent, nurture, none.',
      'structured_profile keys: intent, property_type, budget_min, budget_max, budget_approx, location_preferences, timeline, mortgage_status, working_with_agent, preferred_contact_method, listing_reference.',
      `Known profile seed: ${JSON.stringify(mergedHint)}`,
      `Transcript:\n${args.transcript}`
    ].join('\n');

    try {
      const response = await this.openAiClient.responses.create({
        model: this.openAiModel,
        temperature: 0,
        input: [
          {
            role: 'system',
            content: 'You are a strict real estate qualification parser. Return JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      const parsed = this.parseJsonObject(response.output_text ?? '');
      if (!parsed) {
        throw new Error('OpenAI returned invalid JSON');
      }

      const status = this.normalizeQualificationStatus(parsed.qualification_status) ?? args.statusHint ?? pickQualificationStatus(mergedHint);
      const recommended = this.normalizeRecommendedAction(parsed.recommended_next_action) ?? args.recommendedHint ?? 'callback';
      const extractedProfile = this.mergeStructuredProfile(
        mergedHint,
        extractVoiceStructuredProfile(parsed.structured_profile ?? parsed)
      );

      return {
        summary:
          (typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
            ? parsed.summary.trim()
            : args.summaryHint)
          ?? 'Voice qualification call completed.',
        qualification_status: status,
        recommended_next_action: recommended,
        structured_profile: extractedProfile
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`OpenAI fallback extraction failed: ${message}`);

      const fallbackStatus = args.statusHint ?? pickQualificationStatus(mergedHint);
      return {
        summary:
          args.summaryHint
          ?? (fallbackStatus === 'qualified'
            ? 'Lead completed AI qualification call with usable profile data.'
            : 'Lead completed AI qualification call with partial profile data.'),
        qualification_status: fallbackStatus,
        recommended_next_action: args.recommendedHint ?? (fallbackStatus === 'qualified' ? 'send_listings' : 'callback'),
        structured_profile: mergedHint
      };
    }
  }

  private normalizeQualificationStatus(value: unknown): OpenAiExtraction['qualification_status'] | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'qualified'
      || normalized === 'partial'
      || normalized === 'opt_out'
      || normalized === 'escalated'
      || normalized === 'not_interested'
    ) {
      return normalized;
    }

    return null;
  }

  private normalizeRecommendedAction(value: unknown): OpenAiExtraction['recommended_next_action'] | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'send_listings'
      || normalized === 'book_showing'
      || normalized === 'callback'
      || normalized === 'transfer_to_agent'
      || normalized === 'nurture'
      || normalized === 'none'
    ) {
      return normalized;
    }

    return null;
  }

  private parseJsonObject(value: string): Record<string, unknown> | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return this.toObject(parsed);
    } catch {
      const match = trimmed.match(/\{[\s\S]*\}/);
      if (!match) {
        return null;
      }

      try {
        const parsed = JSON.parse(match[0]) as unknown;
        return this.toObject(parsed);
      } catch {
        return null;
      }
    }
  }

  private mergeStructuredProfile(base: VoiceStructuredProfile, incoming: VoiceStructuredProfile): VoiceStructuredProfile {
    return {
      intent: incoming.intent ?? base.intent,
      property_type: incoming.property_type ?? base.property_type,
      budget_min: incoming.budget_min ?? base.budget_min,
      budget_max: incoming.budget_max ?? base.budget_max,
      budget_approx: incoming.budget_approx ?? base.budget_approx,
      location_preferences:
        incoming.location_preferences.length > 0
          ? incoming.location_preferences
          : base.location_preferences,
      timeline: incoming.timeline ?? base.timeline,
      mortgage_status: incoming.mortgage_status ?? base.mortgage_status,
      working_with_agent: incoming.working_with_agent ?? base.working_with_agent,
      preferred_contact_method: incoming.preferred_contact_method ?? base.preferred_contact_method,
      listing_reference: incoming.listing_reference ?? base.listing_reference
    };
  }

  private extractTranscript(payload: Record<string, unknown>): string {
    const candidates: unknown[] = [
      payload.transcript,
      this.toObject(payload.ai_gather)?.transcript,
      this.toObject(payload.result)?.transcript,
      this.toObject(payload.response)?.transcript,
      this.toObject(payload.analysis)?.transcript
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    const alternatives: unknown[] = [
      payload.conversation,
      this.toObject(payload.result)?.conversation,
      this.toObject(payload.ai_gather)?.conversation,
      payload.summary
    ];

    for (const alternative of alternatives) {
      if (typeof alternative === 'string' && alternative.trim().length > 0) {
        return alternative.trim();
      }
    }

    return '';
  }

  private extractSummary(payload: Record<string, unknown>): string | null {
    const candidates: unknown[] = [
      payload.summary,
      this.toObject(payload.result)?.summary,
      this.toObject(payload.ai_gather)?.summary
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return null;
  }

  private extractStatusHint(payload: Record<string, unknown>): OpenAiExtraction['qualification_status'] | null {
    const candidates: unknown[] = [
      payload.qualification_status,
      this.toObject(payload.result)?.qualification_status,
      this.toObject(payload.ai_gather)?.qualification_status
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeQualificationStatus(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private extractRecommendedAction(payload: Record<string, unknown>): OpenAiExtraction['recommended_next_action'] | null {
    const candidates: unknown[] = [
      payload.recommended_next_action,
      this.toObject(payload.result)?.recommended_next_action,
      this.toObject(payload.ai_gather)?.recommended_next_action
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeRecommendedAction(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private detectOptOutSignal(transcript: string, payload: Record<string, unknown>): boolean {
    const text = `${transcript}\n${JSON.stringify(payload)}`.toLowerCase();
    return ['opt_out', 'do not contact', 'stop calling', 'remove me', 'not interested'].some((token) => text.includes(token));
  }

  private detectEscalationSignal(transcript: string, payload: Record<string, unknown>): boolean {
    const text = `${transcript}\n${JSON.stringify(payload)}`.toLowerCase();
    return ['transfer_to_agent', 'human', 'talk to agent', 'callback me'].some((token) => text.includes(token));
  }

  private async finalizeSession(
    client: PoolClient,
    session: SessionLookupForWebhook,
    result: FinalizeSessionPayload
  ): Promise<void> {
    const lifecycleStatus = result.status === 'opt_out' || result.status === 'escalated'
      ? result.status
      : 'completed';

    let transcriptEventId: string | null = session.transcript_event_id;
    if (result.transcript) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO "ConversationEvent" (
           lead_id,
           channel,
           type,
           direction,
           provider_event_id,
           raw_body,
           meta,
           created_at
         ) VALUES (
           $1,
           'call',
           'voice_ai_transcript',
           'internal',
           $2,
           $3,
           $4::jsonb,
           now()
         )
         RETURNING id`,
        [
          session.lead_id,
          `voice-session-${session.id}-${Date.now()}`,
          this.rawContentCryptoService.encrypt(result.transcript),
          JSON.stringify({
            source: 'telnyx',
            session_id: session.id,
            transcript_status: result.transcriptStatus
          })
        ]
      );
      transcriptEventId = inserted.rows[0]?.id ?? transcriptEventId;
    }

    const existingFields = session.fields_json ?? {};
    const mergedFields = mergeVoiceProfileFields(existingFields, result.structuredProfile, result.status);

    if (result.status === 'opt_out') {
      mergedFields.voice_opt_out_at = new Date().toISOString();
    }

    const qualificationPayload = {
      qualification_status: result.status,
      structured_profile: result.structuredProfile,
      recommended_next_action: result.recommendedNextAction,
      transcript_status: result.transcriptStatus
    };

    await client.query(
      `UPDATE "VoiceQualificationSession"
       SET status = $2,
           qualification_payload = $3::jsonb,
           summary = $4,
           transcript_event_id = $5,
           ended_at = now(),
           next_attempt_at = NULL,
           provider_payload = provider_payload || $6::jsonb
       WHERE id = $1`,
      [
        session.id,
        lifecycleStatus,
        JSON.stringify(qualificationPayload),
        result.summary,
        transcriptEventId,
        JSON.stringify(result.providerPayload)
      ]
    );

    await client.query(
      `INSERT INTO "DerivedLeadProfile" (lead_id, summary, language, fields_json, metrics_json, updated_at)
       VALUES ($1, $2, 'en', $3::jsonb, '{}'::jsonb, now())
       ON CONFLICT (lead_id)
       DO UPDATE SET summary = EXCLUDED.summary,
                     fields_json = EXCLUDED.fields_json,
                     updated_at = now()`,
      [session.lead_id, result.summary, JSON.stringify(mergedFields)]
    );

    if (result.status === 'escalated' || result.recommendedNextAction === 'callback') {
      await this.ensureFollowUpTask(client, session.lead_id, session.owner_agent_id, 'voice qualification escalation');
    }

    if (result.status === 'not_interested') {
      await this.ensureFollowUpTask(client, session.lead_id, session.owner_agent_id, 'voice qualification not interested');
    }
  }

  private async dispatchSingleSession(
    sessionId: string
  ): Promise<'dialed' | 'rescheduled' | 'failed' | 'completed'> {
    return this.databaseService.withSystemTransaction(async (client) => {
      const sessionResult = await client.query<DispatchSessionRow>(
        `SELECT v.id,
                v.team_id,
                v.lead_id,
                v.owner_agent_id,
                v.trigger_mode,
                v.status,
                v.destination_number,
                v.attempt_count,
                v.max_attempts,
                v.provider_payload,
                v.provider_call_control_id,
                l.primary_phone,
                l.state AS lead_state,
                d.fields_json,
                d.summary,
                t.stale_rules,
                t.escalation_rules
         FROM "VoiceQualificationSession" v
         JOIN "Lead" l ON l.id = v.lead_id
         LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = l.id
         JOIN "Team" t ON t.id = v.team_id
         WHERE v.id = $1
         FOR UPDATE OF v`,
        [sessionId]
      );

      if (!sessionResult.rowCount || !sessionResult.rows[0]) {
        return 'failed';
      }

      const session = sessionResult.rows[0];
      if (session.status !== 'queued') {
        return 'completed';
      }

      const rules = this.parseTeamVoiceRules({
        stale_rules: session.stale_rules,
        escalation_rules: session.escalation_rules
      });

      if (!rules.config.enabled) {
        await client.query(
          `UPDATE "VoiceQualificationSession"
           SET status = 'cancelled',
               error_text = 'Voice qualification disabled by team config',
               next_attempt_at = NULL,
               ended_at = now()
           WHERE id = $1`,
          [session.id]
        );
        return 'completed';
      }

      if (session.trigger_mode === 'manual' && !allowsManualVoiceCalls(rules.config.mode)) {
        await client.query(
          `UPDATE "VoiceQualificationSession"
           SET status = 'cancelled',
               error_text = 'Manual mode disabled by team config',
               next_attempt_at = NULL,
               ended_at = now()
           WHERE id = $1`,
          [session.id]
        );
        return 'completed';
      }

      if (session.trigger_mode === 'auto' && !allowsAutoVoiceCalls(rules.config.mode)) {
        await client.query(
          `UPDATE "VoiceQualificationSession"
           SET status = 'cancelled',
               error_text = 'Auto mode disabled by team config',
               next_attempt_at = NULL,
               ended_at = now()
           WHERE id = $1`,
          [session.id]
        );
        return 'completed';
      }

      if (session.attempt_count >= session.max_attempts) {
        await this.markSessionUnreachable(client, session.id, session.lead_id, session.owner_agent_id, 'max attempts reached');
        return 'completed';
      }

      const currentTime = new Date();
      const aligned = alignToCallWindow(currentTime, {
        timeZone: rules.timezone,
        callWindowStart: rules.config.call_window_start,
        callWindowEnd: rules.config.call_window_end,
        quietWindowStart: rules.config.quiet_window_start,
        quietWindowEnd: rules.config.quiet_window_end
      });

      if (session.trigger_mode !== 'manual' && aligned.getTime() - currentTime.getTime() > 30_000) {
        await client.query(
          `UPDATE "VoiceQualificationSession"
           SET next_attempt_at = $2,
               error_text = NULL
           WHERE id = $1`,
          [session.id, aligned.toISOString()]
        );
        return 'rescheduled';
      }

      const destinationNumber = normalizeE164(session.destination_number ?? session.primary_phone ?? '');
      if (!destinationNumber) {
        await this.markSessionFailed(client, session, rules, 'missing destination number');
        return 'failed';
      }

      if (!this.telnyxClient.isConfigured()) {
        await this.markSessionFailed(client, session, rules, 'TELNYX_API_KEY is missing');
        return 'failed';
      }

      const fromNumber = await this.resolveFromNumber(client, session.team_id);
      if (!fromNumber) {
        await this.markSessionFailed(client, session, rules, 'No active team phone number available for outbound calls');
        return 'failed';
      }

      const nextAttemptCount = session.attempt_count + 1;
      try {
        const response = await this.telnyxClient.createOutboundCall({
          to: destinationNumber,
          from: fromNumber.number,
          connectionId: this.configService.get<string>('TELNYX_CONNECTION_ID') ?? null,
          clientState: {
            session_id: session.id,
            lead_id: session.lead_id,
            trigger_mode: session.trigger_mode
          }
        });

        await client.query(
          `UPDATE "VoiceQualificationSession"
           SET status = 'dialing',
               attempt_count = $2,
               provider_call_control_id = COALESCE($3, provider_call_control_id),
               provider_call_leg_id = COALESCE($4, provider_call_leg_id),
               started_at = COALESCE(started_at, now()),
               error_text = NULL,
               provider_payload = provider_payload || $5::jsonb
           WHERE id = $1`,
          [
            session.id,
            nextAttemptCount,
            response.call_control_id,
            response.call_leg_id,
            JSON.stringify({
              dispatch: {
                from_number: fromNumber.number,
                destination_number: destinationNumber,
                attempted_at: new Date().toISOString(),
                provider_response: response.payload
              }
            })
          ]
        );

        return 'dialed';
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown Telnyx error';

        const willExhaust = nextAttemptCount >= session.max_attempts;
        if (willExhaust) {
          await this.markSessionUnreachable(client, session.id, session.lead_id, session.owner_agent_id, message, nextAttemptCount);
          return 'completed';
        }

        const retryOffset = this.resolveRetryOffsetMinutes(rules.config.retry_schedule_minutes, nextAttemptCount);
        const nextAttemptAt = computeNextAttemptTime(new Date(), retryOffset, {
          timeZone: rules.timezone,
          callWindowStart: rules.config.call_window_start,
          callWindowEnd: rules.config.call_window_end,
          quietWindowStart: rules.config.quiet_window_start,
          quietWindowEnd: rules.config.quiet_window_end
        });

        await client.query(
          `UPDATE "VoiceQualificationSession"
           SET status = 'queued',
               attempt_count = $2,
               next_attempt_at = $3,
               error_text = $4,
               provider_payload = provider_payload || $5::jsonb
           WHERE id = $1`,
          [
            session.id,
            nextAttemptCount,
            nextAttemptAt.toISOString(),
            message,
            JSON.stringify({
              dispatch_error: {
                at: new Date().toISOString(),
                message
              }
            })
          ]
        );

        return 'failed';
      }
    });
  }

  private async markSessionFailed(
    client: PoolClient,
    session: DispatchSessionRow,
    rules: TeamVoiceRules,
    reason: string
  ): Promise<void> {
    const nextAttemptCount = session.attempt_count + 1;
    if (nextAttemptCount >= session.max_attempts) {
      await this.markSessionUnreachable(client, session.id, session.lead_id, session.owner_agent_id, reason, nextAttemptCount);
      return;
    }

    const retryOffset = this.resolveRetryOffsetMinutes(rules.config.retry_schedule_minutes, nextAttemptCount);
    const nextAttemptAt = computeNextAttemptTime(new Date(), retryOffset, {
      timeZone: rules.timezone,
      callWindowStart: rules.config.call_window_start,
      callWindowEnd: rules.config.call_window_end,
      quietWindowStart: rules.config.quiet_window_start,
      quietWindowEnd: rules.config.quiet_window_end
    });

    await client.query(
      `UPDATE "VoiceQualificationSession"
       SET status = 'queued',
           attempt_count = $2,
           next_attempt_at = $3,
           error_text = $4
       WHERE id = $1`,
      [session.id, nextAttemptCount, nextAttemptAt.toISOString(), reason]
    );
  }

  private async markSessionUnreachable(
    client: PoolClient,
    sessionId: string,
    leadId: string,
    ownerAgentId: string,
    reason: string,
    attemptCountOverride?: number | undefined
  ): Promise<void> {
    if (attemptCountOverride !== undefined) {
      await client.query(
        `UPDATE "VoiceQualificationSession"
         SET status = 'unreachable',
             attempt_count = $2,
             error_text = $3,
             next_attempt_at = NULL,
             ended_at = now()
         WHERE id = $1`,
        [sessionId, attemptCountOverride, reason]
      );
    } else {
      await client.query(
        `UPDATE "VoiceQualificationSession"
         SET status = 'unreachable',
             error_text = $2,
             next_attempt_at = NULL,
             ended_at = now()
         WHERE id = $1`,
        [sessionId, reason]
      );
    }

    await this.ensureFollowUpTask(client, leadId, ownerAgentId, 'voice qualification unreachable');

    const profileUpdate = mergeVoiceProfileFields({}, this.profileFromDerivedFields(null), 'unreachable');
    await client.query(
      `INSERT INTO "DerivedLeadProfile" (lead_id, summary, language, fields_json, metrics_json, updated_at)
       VALUES ($1, 'Voice qualification attempts exhausted; lead marked unreachable.', 'en', $2::jsonb, '{}'::jsonb, now())
       ON CONFLICT (lead_id)
       DO UPDATE SET summary = EXCLUDED.summary,
                     fields_json = "DerivedLeadProfile".fields_json || EXCLUDED.fields_json,
                     updated_at = now()`,
      [leadId, JSON.stringify(profileUpdate)]
    );
  }

  private resolveRetryOffsetMinutes(schedule: number[], attemptsCompleted: number): number {
    if (!schedule.length) {
      return 0;
    }

    const index = Math.min(attemptsCompleted, schedule.length - 1);
    return schedule[index] ?? schedule[schedule.length - 1] ?? 0;
  }

  private async resolveFromNumber(client: PoolClient, teamId: string): Promise<TeamPhoneRow | null> {
    const telnyxResult = await client.query<TeamPhoneRow>(
      `SELECT id, number
       FROM "PhoneNumber"
       WHERE team_id = $1
         AND provider = 'telnyx'
         AND status = 'active'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [teamId]
    );

    if (telnyxResult.rowCount && telnyxResult.rows[0]) {
      return telnyxResult.rows[0];
    }

    const fallbackResult = await client.query<TeamPhoneRow>(
      `SELECT id, number
       FROM "PhoneNumber"
       WHERE team_id = $1
         AND status = 'active'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [teamId]
    );

    return fallbackResult.rows[0] ?? null;
  }

  private async ensureFollowUpTask(
    client: PoolClient,
    leadId: string,
    ownerAgentId: string,
    reason: string
  ): Promise<void> {
    const existing = await client.query<{ id: string }>(
      `SELECT id
       FROM "Task"
       WHERE lead_id = $1
         AND status = 'open'
         AND type = 'follow_up'
       LIMIT 1`,
      [leadId]
    );

    if (!existing.rowCount) {
      await client.query(
        `INSERT INTO "Task" (lead_id, owner_id, due_at, status, type)
         VALUES ($1, $2, now(), 'open', 'follow_up')`,
        [leadId, ownerAgentId]
      );
    }

    await client.query(
      `INSERT INTO "AuditLog" (actor_id, lead_id, action, reason)
       VALUES ($1, $2, 'VOICE_QUALIFICATION_FOLLOW_UP', $3)`,
      [ownerAgentId, leadId, reason]
    );
  }

  private async createAutoSessions(limit: number): Promise<number> {
    return this.databaseService.withSystemTransaction(async (client) => {
      const candidates = await client.query<{
        lead_id: string;
        team_id: string;
        owner_agent_id: string;
        primary_phone: string | null;
        stale_rules: unknown;
        escalation_rules: unknown;
        fields_json: Record<string, unknown> | null;
      }>(
        `SELECT l.id AS lead_id,
                l.team_id,
                l.owner_agent_id,
                l.primary_phone,
                t.stale_rules,
                t.escalation_rules,
                d.fields_json
         FROM "Lead" l
         JOIN "Team" t ON t.id = l.team_id
         LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = l.id
         WHERE l.primary_phone IS NOT NULL
           AND l.state IN ('New', 'Active', 'At-Risk')
           AND NOT EXISTS (
             SELECT 1
             FROM "VoiceQualificationSession" v
             WHERE v.lead_id = l.id
               AND v.trigger_mode = 'auto'
               AND v.status IN ('queued', 'dialing', 'in_progress')
           )
         ORDER BY l.created_at DESC
         LIMIT $1`,
        [limit]
      );

      let created = 0;

      for (const row of candidates.rows) {
        const normalizedPhone = normalizeE164(row.primary_phone ?? '');
        if (!normalizedPhone) {
          continue;
        }

        const rules = this.parseTeamVoiceRules({
          stale_rules: row.stale_rules,
          escalation_rules: row.escalation_rules
        });
        if (!rules.config.enabled || !allowsAutoVoiceCalls(rules.config.mode)) {
          continue;
        }

        if (shouldSuppressAutoVoiceCalls(row.fields_json)) {
          continue;
        }

        const profile = this.profileFromDerivedFields(row.fields_json);
        if (isVoiceProfileSufficient(profile)) {
          continue;
        }

        const nextAttemptAt = computeNextAttemptTime(new Date(), this.resolveRetryOffsetMinutes(rules.config.retry_schedule_minutes, 0), {
          timeZone: rules.timezone,
          callWindowStart: rules.config.call_window_start,
          callWindowEnd: rules.config.call_window_end,
          quietWindowStart: rules.config.quiet_window_start,
          quietWindowEnd: rules.config.quiet_window_end
        });

        const insert = await client.query(
          `INSERT INTO "VoiceQualificationSession" (
             team_id,
             lead_id,
             owner_agent_id,
             trigger_mode,
             status,
             destination_number,
             max_attempts,
             next_attempt_at,
             qualification_payload
           ) VALUES (
             $1,
             $2,
             $3,
             'auto',
             'queued',
             $4,
             $5,
             $6,
             $7::jsonb
           )
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            row.team_id,
            row.lead_id,
            row.owner_agent_id,
            normalizedPhone,
            rules.config.max_attempts,
            nextAttemptAt.toISOString(),
            JSON.stringify({
              qualification_status: 'partial',
              structured_profile: profile,
              transcript_status: 'unavailable'
            })
          ]
        );

        if (insert.rowCount) {
          created += 1;
          const createdId = insert.rows[0]?.id;
          if (typeof createdId === 'string') {
            await this.enqueueDispatch('auto_session_created', createdId);
          }
        }
      }

      return created;
    });
  }

  private async startTelnyxAiGather(
    callControlId: string,
    session: SessionLookupForWebhook,
    rules: TeamVoiceRules
  ): Promise<void> {
    const prompt = this.buildGatherPrompt({
      leadId: session.lead_id,
      sessionId: session.id,
      knownProfile: this.profileFromDerivedFields(session.fields_json)
    });

    const initialMessage =
      'Hi, this is the Suivo assistant calling on behalf of your real estate team. '
      + 'You recently requested information about a property, and I just wanted to gather a couple quick details '
      + 'so your agent can help you better. Is now still an okay time for a quick call?';

    await this.telnyxClient.startAiGather({
      callControlId,
      model: rules.config.assistant_model,
      voice: rules.config.assistant_voice,
      prompt,
      initialMessage,
      maxDurationSeconds: 360
    });
  }

  private buildGatherPrompt(input: {
    leadId: string;
    sessionId: string;
    knownProfile: VoiceStructuredProfile;
  }): string {
    return [
      'You are Suivo\'s AI real-estate qualification assistant.',
      `Session ID: ${input.sessionId}`,
      `Lead ID: ${input.leadId}`,
      `Known profile: ${JSON.stringify(input.knownProfile)}`,
      'Goal: gather enough profile data for a human real-estate agent to follow up quickly.',
      'Conversation rules:',
      '- Sound natural and concise.',
      '- Ask one question at a time.',
      '- Do not ask for fields already known.',
      '- Stop once profile is sufficient: intent + (budget or property_type) + (location or listing_reference) + timeline.',
      '- If caller asks for a human, mark escalation.',
      '- If caller opts out, stop immediately and mark opt-out.',
      '- Max two clarification attempts per missing field.',
      'At the end, return JSON only with keys:',
      'qualification_status, recommended_next_action, summary, structured_profile.',
      'structured_profile keys:',
      'intent, property_type, budget_min, budget_max, budget_approx, location_preferences, timeline, mortgage_status, working_with_agent, preferred_contact_method, listing_reference.',
      'Allowed qualification_status: qualified, partial, opt_out, escalated, not_interested.',
      'Allowed recommended_next_action: send_listings, book_showing, callback, transfer_to_agent, nurture, none.'
    ].join('\n');
  }

  private redactSipUri(uri: string): string {
    const trimmed = uri.trim();
    if (!trimmed) {
      return trimmed;
    }

    // Avoid storing credentials from SIP URIs in provider payload metadata.
    return trimmed.replace(/^(sips?:)([^@]+)@/i, '$1***@');
  }

  private extractOpenAiRealtimeWebhookEnvelope(body: unknown): OpenAiRealtimeWebhookEnvelope | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }

    const root = body as Record<string, unknown>;
    const data = this.toObject(root.data) ?? root;
    const eventType =
      this.pickString(root, ['type', 'event_type'])
      ?? this.pickString(data, ['type', 'event_type']);

    if (!eventType) {
      return null;
    }

    return {
      event_type: eventType.trim().toLowerCase(),
      call_id: this.pickString(data, ['call_id']) ?? this.pickString(root, ['call_id']),
      payload: data
    };
  }

  private async acceptOpenAiRealtimeCall(callId: string): Promise<void> {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing');
    }

    const realtimeModel = this.configService.get<string>('OPENAI_REALTIME_MODEL', 'gpt-realtime');
    const realtimeVoice = this.configService.get<string>('OPENAI_REALTIME_VOICE', 'alloy');
    const realtimeInstructions = this.configService.get<string>(
      'OPENAI_REALTIME_INSTRUCTIONS',
      [
        'You are Suivo\'s AI real-estate qualification assistant.',
        'Keep responses concise and natural.',
        'Ask one question at a time and gather missing buyer profile details.',
        'If the caller asks for a human, offer transfer or callback.'
      ].join(' ')
    );

    const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        type: 'realtime',
        model: realtimeModel,
        instructions: realtimeInstructions,
        audio: {
          input: {
            turn_detection: {
              type: 'server_vad'
            }
          },
          output: {
            voice: realtimeVoice
          }
        }
      })
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`OpenAI realtime accept failed (${response.status}): ${bodyText}`);
    }
  }

  private startOpenAiRealtimeGreeting(callId: string): void {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      return;
    }

    const greeting = this.configService.get<string>(
      'OPENAI_REALTIME_INITIAL_MESSAGE',
      'Hi, this is Suivo\'s AI assistant. Is now a good time for a quick qualification call?'
    );

    const socket = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    let closed = false;
    const closeSafely = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        socket.close();
      } catch {
        // no-op
      }
    };

    const timeout = setTimeout(() => {
      closeSafely();
    }, 10_000);

    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['audio'],
            instructions: greeting
          }
        })
      );
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
        const eventType = typeof parsed.type === 'string' ? parsed.type : null;
        if (eventType === 'response.done' || eventType === 'error') {
          clearTimeout(timeout);
          closeSafely();
        }
      } catch {
        // Ignore non-JSON frames.
      }
    });

    socket.on('error', (error: Error) => {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`OpenAI realtime greeting socket error for call ${callId}: ${message}`);
      clearTimeout(timeout);
      closeSafely();
    });

    socket.on('close', () => {
      clearTimeout(timeout);
      closed = true;
    });
  }

  private toObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private pickString(payload: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }

    return null;
  }
}
