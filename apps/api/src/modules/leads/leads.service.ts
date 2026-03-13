import {
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { PoolClient } from 'pg';

import { DatabaseService } from '../../common/db/database.service';
import { RawContentCryptoService } from '../../common/crypto/raw-content-crypto.service';
import { UserContext } from '../../common/auth/user-context';
import {
  ConversationEventRow,
  DerivedProfileRow,
  LeadProvenance,
  LeadRow
} from './leads.contracts';

@Injectable()
export class LeadsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly rawContentCryptoService: RawContentCryptoService
  ) {}

  async getDerivedProfile(user: UserContext, leadId: string): Promise<Record<string, unknown>> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query(
        `SELECT d.lead_id, d.summary, d.language, d.fields_json, d.metrics_json, d.updated_at,
                l.state, l.last_touch_at, l.next_action_at
         FROM "DerivedLeadProfile" d
         JOIN "Lead" l ON l.id = d.lead_id
         WHERE d.lead_id = $1`,
        [leadId]
      );

      if (result.rowCount === 0) {
        throw new NotFoundException('Lead profile not found');
      }

      return result.rows[0];
    });
  }

  async getEventMetadata(user: UserContext, leadId: string): Promise<Record<string, unknown>[]> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      if (user.role === 'TEAM_LEAD') {
        const result = await client.query(
          'SELECT id, channel, type, direction, created_at FROM team_event_metadata($1)',
          [leadId]
        );
        return result.rows;
      }

      const result = await client.query(
        `SELECT id, channel, type, direction, created_at
         FROM "ConversationEvent"
         WHERE lead_id = $1
         ORDER BY created_at DESC
         LIMIT 250`,
        [leadId]
      );
      return result.rows;
    });
  }

  async getRawEvents(user: UserContext, leadId: string, reason?: string): Promise<Record<string, unknown>> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const lead = await this.getLeadForAccess(client, leadId, user);

      if (user.role === 'TEAM_LEAD') {
        if (lead.state !== 'Stale') {
          throw new ForbiddenException('Raw access is only available to Team Leads when lead is Stale');
        }
        if (!reason) {
          throw new ForbiddenException('A reason is required for stale raw access');
        }

        await client.query(
          `INSERT INTO "AuditLog" (actor_id, lead_id, action, reason)
           VALUES ($1, $2, 'TEAM_LEAD_RAW_ACCESS', $3)`,
          [user.userId, leadId, reason]
        );
      }

      const eventRows = await client.query<ConversationEventRow>(
        `SELECT id, channel, type, direction, mailbox_connection_id, phone_number_id, provider_event_id, raw_body, meta, created_at
         FROM "ConversationEvent"
         WHERE lead_id = $1
         ORDER BY created_at DESC
         LIMIT 250`,
        [leadId]
      );

      const attachments = await client.query(
        `SELECT a.id, a.conversation_event_id, a.filename, a.mime_type, a.storage_key, a.size_bytes, a.created_at
         FROM "Attachment" a
         JOIN "ConversationEvent" e ON e.id = a.conversation_event_id
         WHERE e.lead_id = $1
         ORDER BY a.created_at DESC`,
        [leadId]
      );

      return {
        events: eventRows.rows.map((event: ConversationEventRow) => ({
          ...event,
          raw_body: this.rawContentCryptoService.decrypt(event.raw_body)
        })),
        attachments: attachments.rows
      };
    });
  }

  async reassignLead(user: UserContext, leadId: string, newOwnerId: string): Promise<{ lead_id: string; owner_agent_id: string }> {
    if (user.role !== 'TEAM_LEAD') {
      throw new ForbiddenException('Only Team Leads can reassign leads');
    }

    return this.databaseService.withUserTransaction(user, async (client) => {
      const lead = await this.getLeadForAccess(client, leadId, user);
      if (lead.state !== 'Stale') {
        throw new ForbiddenException('Reassignment is only allowed for stale leads');
      }

      const updateResult = await client.query(
        `UPDATE "Lead"
         SET owner_agent_id = $2,
             updated_at = now()
         WHERE id = $1
         RETURNING id AS lead_id, owner_agent_id`,
        [leadId, newOwnerId]
      );

      if (updateResult.rowCount === 0) {
        throw new NotFoundException('Lead not found');
      }

      await client.query(
        `INSERT INTO "AuditLog" (actor_id, lead_id, action, reason)
         VALUES ($1, $2, 'LEAD_REASSIGN', $3)`,
        [user.userId, leadId, `Reassigned to ${newOwnerId}`]
      );

      return updateResult.rows[0];
    });
  }

  async findOrCreateLeadByEmail(
    client: PoolClient,
    args: {
      teamId: string;
      ownerAgentId: string;
      email: string;
      source: 'email' | 'manual';
      language?: string | undefined;
      provenance?: LeadProvenance | undefined;
    }
  ): Promise<LeadRow> {
    const normalizedEmail = args.email.toLowerCase();
    const created = await client.query<LeadRow>(
      `INSERT INTO "Lead" (team_id, owner_agent_id, state, source, primary_email, next_action_at)
       VALUES ($1, $2, 'New', $3, $4, now())
       ON CONFLICT (team_id, primary_email)
       WHERE primary_email IS NOT NULL
       DO NOTHING
       RETURNING id, team_id, owner_agent_id, state`,
      [args.teamId, args.ownerAgentId, args.source, normalizedEmail]
    );

    const lead =
      created.rows[0]
      ?? (
        await client.query<LeadRow>(
          `SELECT id, team_id, owner_agent_id, state
           FROM "Lead"
           WHERE team_id = $1
             AND primary_email = $2
           LIMIT 1`,
          [args.teamId, normalizedEmail]
        )
      ).rows[0];

    if (!lead) {
      throw new NotFoundException('Unable to resolve lead after email upsert');
    }

    if (created.rowCount) {
      await this.ensureContactNowTask(client, lead.id, args.ownerAgentId);
      await this.recordLeadCreatedEvent(client, lead.id, args.source, args.provenance);
    }

    await this.ensureDerivedProfile(client, lead.id, args.language ?? 'en', args.provenance);

    return lead;
  }

  async findOrCreateLeadByPhone(
    client: PoolClient,
    args: {
      teamId: string;
      ownerAgentId: string;
      phone: string;
      source: 'sms' | 'call' | 'manual';
      language?: string | undefined;
      provenance?: LeadProvenance | undefined;
    }
  ): Promise<LeadRow> {
    const created = await client.query<LeadRow>(
      `INSERT INTO "Lead" (team_id, owner_agent_id, state, source, primary_phone, next_action_at)
       VALUES ($1, $2, 'New', $3, $4, now())
       ON CONFLICT (team_id, primary_phone)
       WHERE primary_phone IS NOT NULL
       DO NOTHING
       RETURNING id, team_id, owner_agent_id, state`,
      [args.teamId, args.ownerAgentId, args.source, args.phone]
    );

    const lead =
      created.rows[0]
      ?? (
        await client.query<LeadRow>(
          `SELECT id, team_id, owner_agent_id, state
           FROM "Lead"
           WHERE team_id = $1
             AND primary_phone = $2
           LIMIT 1`,
          [args.teamId, args.phone]
        )
      ).rows[0];

    if (!lead) {
      throw new NotFoundException('Unable to resolve lead after phone upsert');
    }

    if (created.rowCount) {
      await this.ensureContactNowTask(client, lead.id, args.ownerAgentId);
      await this.recordLeadCreatedEvent(client, lead.id, args.source, args.provenance);
    }

    await this.ensureDerivedProfile(client, lead.id, args.language ?? 'en', args.provenance);

    return lead;
  }

  async applyTouch(client: PoolClient, leadId: string, ownerId: string): Promise<void> {
    await client.query(
      `UPDATE "Lead"
       SET state = CASE WHEN state = 'New' THEN 'Active' ELSE state END,
           last_touch_at = now(),
           next_action_at = now() + interval '24 hours',
           updated_at = now()
       WHERE id = $1`,
      [leadId]
    );

    await client.query(
      `INSERT INTO "Task" (lead_id, owner_id, due_at, status, type)
       VALUES ($1, $2, now() + interval '24 hours', 'open', 'follow_up')`,
      [leadId, ownerId]
    );
  }

  private async getLeadForAccess(client: PoolClient, leadId: string, user: UserContext): Promise<LeadRow> {
    const leadResult = await client.query<LeadRow>(
      `SELECT id, team_id, owner_agent_id, state
       FROM "Lead"
       WHERE id = $1
         AND team_id = $2
         AND ($3 = 'TEAM_LEAD' OR owner_agent_id = $4)`,
      [leadId, user.teamId, user.role, user.userId]
    );

    if (!leadResult.rowCount || !leadResult.rows[0]) {
      throw new NotFoundException('Lead not found');
    }

    return leadResult.rows[0];
  }

  private async ensureDerivedProfile(
    client: PoolClient,
    leadId: string,
    language: string,
    provenance?: LeadProvenance
  ): Promise<void> {
    const result = await client.query<DerivedProfileRow>(
      `SELECT fields_json
       FROM "DerivedLeadProfile"
       WHERE lead_id = $1`,
      [leadId]
    );

    const provenanceFields = provenance
      ? {
          intake_origin: provenance.intake_origin,
          intake_channel_ref: provenance.intake_channel_ref,
          broker_assigned: provenance.broker_assigned
        }
      : {};

    if (!result.rowCount || !result.rows[0]) {
      await client.query(
        `INSERT INTO "DerivedLeadProfile" (lead_id, summary, language, fields_json, metrics_json)
         VALUES ($1, 'New lead awaiting first contact.', $2, $3::jsonb, '{}'::jsonb)
         ON CONFLICT (lead_id) DO NOTHING`,
        [leadId, language, JSON.stringify(provenanceFields)]
      );
      return;
    }

    if (!provenance) {
      return;
    }

    const currentFields = result.rows[0].fields_json ?? {};
    const nextFields = {
      ...provenanceFields,
      ...currentFields
    };

    if (JSON.stringify(nextFields) === JSON.stringify(currentFields)) {
      return;
    }

    await client.query(
      `UPDATE "DerivedLeadProfile"
       SET fields_json = $2::jsonb,
           updated_at = now()
       WHERE lead_id = $1`,
      [leadId, JSON.stringify(nextFields)]
    );
  }

  private async ensureContactNowTask(client: PoolClient, leadId: string, ownerId: string): Promise<void> {
    const existingTask = await client.query(
      `SELECT id
       FROM "Task"
       WHERE lead_id = $1
         AND status = 'open'
         AND type = 'contact_now'
       LIMIT 1`,
      [leadId]
    );

    if (!existingTask.rowCount) {
      await client.query(
        `INSERT INTO "Task" (lead_id, owner_id, due_at, status, type)
         VALUES ($1, $2, now(), 'open', 'contact_now')`,
        [leadId, ownerId]
      );
    }
  }

  private async recordLeadCreatedEvent(
    client: PoolClient,
    leadId: string,
    source: 'email' | 'sms' | 'call' | 'manual',
    provenance?: LeadProvenance
  ): Promise<void> {
    const meta = {
      source,
      intake_origin: provenance?.intake_origin ?? null,
      intake_channel_ref: provenance?.intake_channel_ref ?? null,
      broker_assigned: provenance?.broker_assigned ?? false
    };

    await client.query(
      `INSERT INTO "ConversationEvent" (
         lead_id,
         channel,
         type,
         direction,
         raw_body,
         meta,
         created_at
       ) VALUES (
         $1,
         'system',
         'lead_created',
         'internal',
         NULL,
         $2::jsonb,
         now()
       )`,
      [leadId, JSON.stringify(meta)]
    );
  }
}
