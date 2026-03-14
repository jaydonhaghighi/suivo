import { Injectable } from '@nestjs/common';

import { UserContext } from '../../common/auth/user-context';
import { DatabaseService } from '../../common/db/database.service';
import {
  NotificationCategory,
  NotificationFeedItem,
  NotificationSourceRow,
  SourceEntity
} from './notifications.types';

@Injectable()
export class NotificationsService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getFeed(user: UserContext, limit = 80): Promise<NotificationFeedItem[]> {
    return this.databaseService.withSystemTransaction(async (client) => {
      const result = await client.query<NotificationSourceRow>(
        `WITH scoped_leads AS (
           SELECT
             l.id,
             l.state,
             l.source,
             l.primary_email::text AS primary_email,
             l.primary_phone,
             l.created_at,
             d.summary,
             d.fields_json
           FROM "Lead" l
           LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = l.id
           WHERE l.team_id = $1
             AND (
               l.owner_agent_id = $3
               OR ($2 = 'TEAM_LEAD' AND l.state = 'Stale')
             )
         ),
         event_rows AS (
           SELECT
             e.id,
             e.lead_id,
             e.channel,
             e.type,
             e.direction,
             e.meta,
             e.created_at,
             sl.state,
             sl.source,
             sl.primary_email,
             sl.primary_phone,
             sl.summary,
             sl.fields_json
           FROM "ConversationEvent" e
           JOIN scoped_leads sl ON sl.id = e.lead_id
           ORDER BY e.created_at DESC
           LIMIT $4
         ),
         event_source AS (
           SELECT
             CONCAT('event:', er.id::text) AS id,
             'conversation_event'::text AS source_entity,
             er.lead_id,
             er.channel,
             er.type AS source_type,
             er.direction,
             er.created_at,
             NULL::timestamptz AS due_at,
             er.state AS lead_state,
             er.source AS lead_source,
             er.primary_email,
             er.primary_phone,
             er.summary,
             COALESCE(er.meta, '{}'::jsonb) || jsonb_build_object(
               'lead_source', er.source,
               'lead_fields', COALESCE(er.fields_json, '{}'::jsonb)
             ) AS meta
           FROM event_rows er
         ),
         lead_source AS (
           SELECT
             CONCAT('lead:', sl.id::text) AS id,
             'lead'::text AS source_entity,
             sl.id AS lead_id,
             NULL::text AS channel,
             'lead_created'::text AS source_type,
             'internal'::text AS direction,
             sl.created_at,
             NULL::timestamptz AS due_at,
             sl.state AS lead_state,
             sl.source AS lead_source,
             sl.primary_email,
             sl.primary_phone,
             sl.summary,
             jsonb_build_object(
               'lead_source', sl.source,
               'lead_fields', COALESCE(sl.fields_json, '{}'::jsonb)
             ) AS meta
           FROM scoped_leads sl
           WHERE NOT EXISTS (
             SELECT 1
             FROM "ConversationEvent" e
             WHERE e.lead_id = sl.id
               AND e.type = 'lead_created'
           )
           ORDER BY sl.created_at DESC
           LIMIT $4
         ),
         task_rows AS (
           SELECT
             t.id,
             t.lead_id,
             t.type,
             t.status,
             t.due_at,
             sl.state,
             sl.source,
             sl.primary_email,
             sl.primary_phone,
             sl.summary,
             sl.fields_json
           FROM "Task" t
           JOIN scoped_leads sl ON sl.id = t.lead_id
           WHERE t.owner_id = $3
             AND t.status IN ('open', 'snoozed')
           ORDER BY t.due_at ASC
           LIMIT $4
         ),
         task_source AS (
           SELECT
             CONCAT('task:', tr.id::text) AS id,
             'task'::text AS source_entity,
             tr.lead_id,
             'task'::text AS channel,
             tr.type AS source_type,
             'internal'::text AS direction,
             tr.due_at AS created_at,
             tr.due_at,
             tr.state AS lead_state,
             tr.source AS lead_source,
             tr.primary_email,
             tr.primary_phone,
             tr.summary,
             jsonb_build_object(
               'task_status', tr.status,
               'task_due_state', CASE WHEN tr.due_at < now() THEN 'overdue' ELSE 'due' END,
               'lead_source', tr.source,
               'lead_fields', COALESCE(tr.fields_json, '{}'::jsonb)
             ) AS meta
           FROM task_rows tr
         )
         SELECT
           feed.id,
           feed.source_entity,
           feed.lead_id,
           feed.channel,
           feed.source_type,
           feed.direction,
           feed.created_at::text AS created_at,
           feed.due_at::text AS due_at,
           feed.lead_state,
           feed.lead_source,
           feed.primary_email,
           feed.primary_phone,
           feed.summary,
           feed.meta,
           nrs.read_at::text AS read_at
         FROM (
           SELECT * FROM event_source
           UNION ALL
           SELECT * FROM lead_source
           UNION ALL
           SELECT * FROM task_source
         ) feed
         LEFT JOIN "NotificationReadState" nrs
           ON nrs.user_id = $3
          AND nrs.notification_id = feed.id
         ORDER BY feed.created_at DESC
         LIMIT $4`,
        [user.teamId, user.role, user.userId, limit]
      );

      return result.rows.map((row) => this.toFeedItem(row));
    });
  }

  private toFeedItem(row: NotificationSourceRow): NotificationFeedItem {
    const primaryContact = this.primaryContact(row.primary_email, row.primary_phone);
    const notificationType = this.normalizeType(row);
    const presentation = this.presentation(notificationType, row, primaryContact);
    const attributes = this.buildAttributes(row, notificationType, presentation.category, primaryContact);
    const uiLabel = primaryContact === 'Lead' ? presentation.title : `${primaryContact} - ${presentation.title}`;

    return {
      id: row.id,
      lead_id: row.lead_id,
      source_entity: row.source_entity,
      source_type: row.source_type,
      notification_type: notificationType,
      category: presentation.category,
      title: presentation.title,
      body: presentation.body,
      ui_label: uiLabel,
      route_path: presentation.routePath,
      channel: row.channel,
      direction: row.direction,
      created_at: row.created_at,
      due_at: row.due_at,
      lead_state: row.lead_state,
      lead_source: row.lead_source,
      primary_contact: primaryContact,
      primary_email: row.primary_email,
      primary_phone: row.primary_phone,
      summary: this.summaryOrNull(row.summary),
      read_at: row.read_at,
      is_read: Boolean(row.read_at),
      attributes
    };
  }

  async markRead(
    user: UserContext,
    notificationId: string
  ): Promise<{ id: string; read_at: string; is_read: true }> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query<{ id: string; read_at: string }>(
        `INSERT INTO "NotificationReadState" (
           user_id,
           team_id,
           notification_id,
           read_at,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, now(), now(), now())
         ON CONFLICT (user_id, notification_id)
         DO UPDATE
           SET read_at = EXCLUDED.read_at,
               team_id = EXCLUDED.team_id,
               updated_at = now()
         RETURNING notification_id AS id, read_at::text AS read_at`,
        [user.userId, user.teamId, notificationId]
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error('Unable to mark notification as read');
      }

      return {
        id: row.id,
        read_at: row.read_at,
        is_read: true
      };
    });
  }

  async markManyRead(
    user: UserContext,
    notificationIds: string[]
  ): Promise<{ updated: number; read_at: string }> {
    const cleaned = Array.from(new Set(notificationIds.map((value) => value.trim()).filter((value) => value.length > 0)));
    const readAt = new Date().toISOString();
    if (cleaned.length === 0) {
      return { updated: 0, read_at: readAt };
    }

    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query(
        `WITH target_ids AS (
           SELECT DISTINCT unnest($3::text[]) AS notification_id
         )
         INSERT INTO "NotificationReadState" (
           user_id,
           team_id,
           notification_id,
           read_at,
           created_at,
           updated_at
         )
         SELECT
           $1,
           $2,
           target_ids.notification_id,
           now(),
           now(),
           now()
         FROM target_ids
         ON CONFLICT (user_id, notification_id)
         DO UPDATE
           SET read_at = EXCLUDED.read_at,
               team_id = EXCLUDED.team_id,
               updated_at = now()`,
        [user.userId, user.teamId, cleaned]
      );

      return {
        updated: result.rowCount ?? 0,
        read_at: readAt
      };
    });
  }

  private normalizeType(row: NotificationSourceRow): string {
    if (row.source_entity === 'task') {
      return row.source_type;
    }

    const sourceType = row.source_type.toLowerCase();
    if (sourceType === 'email_received' || sourceType === 'sms_received' || sourceType === 'inbound_message') {
      return 'inbound_message';
    }

    if (sourceType === 'email_sent' || sourceType === 'sms_sent' || sourceType === 'outbound_message') {
      return 'outbound_message';
    }

    if (sourceType === 'call_status') {
      const status = this.metaString(row.meta, 'status')?.toLowerCase();
      if (status?.includes('missed') || status?.includes('no') || status?.includes('busy') || status?.includes('failed')) {
        return 'missed_call';
      }
      return 'call_logged';
    }

    if (sourceType === 'call_no_answer') {
      return 'missed_call';
    }

    if (sourceType === 'call_completed') {
      return 'call_logged';
    }

    if (sourceType === 'agent_note') {
      return 'note_added';
    }

    if (sourceType === 'at_risk_warning' || sourceType === 'sla_breach') {
      return 'lead_at_risk';
    }

    if (sourceType === 'stale_transition' || sourceType === 'lead_marked_stale') {
      return 'lead_stale';
    }

    if (sourceType === 'auto_assigned') {
      return 'lead_assigned';
    }

    if (sourceType === 'rescue_sequence_started') {
      return 'ai_suggestion';
    }

    return sourceType;
  }

  private presentation(
    notificationType: string,
    row: NotificationSourceRow,
    primaryContact: string
  ): { category: NotificationCategory; title: string; body: string; routePath: '/lead/[id]' | '/task-deck' } {
    if (row.source_entity === 'task') {
      const taskDueState = this.metaString(row.meta, 'task_due_state');
      const taskLabel = this.humanizeToken(row.source_type);

      return {
        category: 'task',
        title: taskDueState === 'overdue' ? `${taskLabel} overdue` : `${taskLabel} reminder`,
        body: taskDueState === 'overdue' ? `${primaryContact} needs follow-up` : `Reach out to ${primaryContact} today`,
        routePath: '/task-deck'
      };
    }

    switch (notificationType) {
      case 'lead_created': {
        const leadHighlights = this.leadHighlights(row.meta);
        return {
          category: 'lead',
          title: 'New lead alert',
          body:
            leadHighlights
            ?? this.summaryOrNull(row.summary)
            ?? this.summaryOrFallback(this.metaString(row.meta, 'subject'), `${primaryContact} entered your pipeline`),
          routePath: '/lead/[id]'
        };
      }
      case 'lead_assigned':
        return {
          category: 'lead',
          title: 'New lead assigned',
          body: `${primaryContact} has been assigned to you`,
          routePath: '/lead/[id]'
        };
      case 'lead_stale':
        return {
          category: 'lead',
          title: 'Stale lead alert',
          body: `${primaryContact} has not engaged recently`,
          routePath: '/lead/[id]'
        };
      case 'lead_at_risk':
        return {
          category: 'lead',
          title: 'Lead at risk',
          body: `${primaryContact} needs follow-up attention`,
          routePath: '/lead/[id]'
        };
      case 'inbound_message':
        return {
          category: 'message',
          title: 'Client message',
          body: this.summaryOrFallback(
            this.metaString(row.meta, 'subject'),
            this.summaryOrFallback(row.summary, `${primaryContact} sent a new message`)
          ),
          routePath: '/lead/[id]'
        };
      case 'outbound_message':
        return {
          category: 'system',
          title: 'Auto message sent',
          body: this.summaryOrFallback(this.metaString(row.meta, 'subject'), `Message sent to ${primaryContact}`),
          routePath: '/lead/[id]'
        };
      case 'missed_call':
        return {
          category: 'call',
          title: 'Missed call',
          body: primaryContact,
          routePath: '/lead/[id]'
        };
      case 'call_logged':
        return {
          category: 'call',
          title: 'Call summary saved',
          body: `Conversation logged for ${primaryContact}`,
          routePath: '/lead/[id]'
        };
      case 'note_added':
        return {
          category: 'note',
          title: 'Note added',
          body: `New note saved for ${primaryContact}`,
          routePath: '/lead/[id]'
        };
      case 'ai_suggestion':
        return {
          category: 'system',
          title: 'AI suggestion',
          body: this.summaryOrFallback(row.summary, `Suggested follow-up for ${primaryContact}`),
          routePath: '/lead/[id]'
        };
      default:
        return {
          category: row.channel === 'call' ? 'call' : row.channel === 'note' ? 'note' : 'system',
          title: this.humanizeToken(notificationType),
          body: this.summaryOrFallback(row.summary, primaryContact),
          routePath: '/lead/[id]'
        };
    }
  }

  private buildAttributes(
    row: NotificationSourceRow,
    notificationType: string,
    category: NotificationCategory,
    primaryContact: string
  ): Record<string, unknown> {
    const attributes: Record<string, unknown> = {
      lead_id: row.lead_id,
      lead_state: row.lead_state,
      lead_source: row.lead_source,
      primary_contact: primaryContact,
      primary_email: row.primary_email,
      primary_phone: row.primary_phone,
      source_entity: row.source_entity,
      source_type: row.source_type,
      notification_type: notificationType,
      category,
      channel: row.channel,
      direction: row.direction,
      created_at: row.created_at,
      due_at: row.due_at,
      read_at: row.read_at,
      is_read: Boolean(row.read_at)
    };

    const summary = this.summaryOrNull(row.summary);
    if (summary) {
      attributes.summary = summary;
    }

    if (row.meta && typeof row.meta === 'object') {
      attributes.meta = row.meta;
    }

    return attributes;
  }

  private primaryContact(primaryEmail: string | null, primaryPhone: string | null): string {
    if (primaryEmail && primaryEmail.includes('@')) {
      const local = primaryEmail.split('@')[0] ?? primaryEmail;
      return local
        .replace(/[._+]/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((part) => part.length > 0)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
    }

    if (primaryPhone) {
      return primaryPhone;
    }

    return 'Lead';
  }

  private summaryOrNull(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    if (!normalized) {
      return null;
    }

    if (normalized.toLowerCase() === 'new lead awaiting first contact.') {
      return null;
    }

    return normalized;
  }

  private summaryOrFallback(value: string | null | undefined, fallback: string): string {
    const normalized = value?.trim();
    return normalized && normalized.length > 0 ? normalized : fallback;
  }

  private humanizeToken(value: string): string {
    return value
      .replace(/[_-]/g, ' ')
      .split(' ')
      .filter((token) => token.length > 0)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' ');
  }

  private metaString(meta: Record<string, unknown> | null, key: string): string | null {
    if (!meta || typeof meta !== 'object') {
      return null;
    }

    const value = meta[key];
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private metaRecord(meta: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
    if (!meta || typeof meta !== 'object') {
      return null;
    }

    const value = meta[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private leadHighlights(meta: Record<string, unknown> | null): string | null {
    const leadFields = this.metaRecord(meta, 'lead_fields');
    if (!leadFields) {
      return null;
    }

    const location = this.firstFieldString(leadFields, ['location', 'area', 'neighborhood']);
    const budget = this.firstFieldString(leadFields, ['budget', 'price', 'price_range']);
    const bedrooms = this.firstFieldString(leadFields, ['bedrooms', 'beds', 'rooms']);
    const timeline = this.firstFieldString(leadFields, ['timeline', 'timeframe', 'move_date', 'move_in']);

    const parts = [location, budget, bedrooms, timeline].filter((part): part is string => Boolean(part));
    if (!parts.length) {
      return null;
    }

    return parts.join(' - ');
  }

  private firstFieldString(fields: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === 'string') {
        const normalized = value.trim();
        if (normalized.length > 0) {
          return normalized;
        }
      }

      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
    }

    return null;
  }
}
