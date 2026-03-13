import { Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';

import { RawContentCryptoService } from '../../common/crypto/raw-content-crypto.service';
import { DatabaseService } from '../../common/db/database.service';
import { UserContext } from '../../common/auth/user-context';
import { LeadsService } from '../leads/leads.service';
import { EmailReplyPayload, SmsSendPayload } from './messages.types';

@Injectable()
export class MessagesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly rawContentCryptoService: RawContentCryptoService,
    private readonly leadsService: LeadsService
  ) {}

  async replyEmail(user: UserContext, payload: EmailReplyPayload): Promise<{ sent: boolean; provider_event_id: string }> {
    const providerEventId = payload.provider_event_id ?? `local-email-${uuidv4()}`;

    await this.databaseService.withUserTransaction(user, async (client) => {
      const leadResult = await client.query(
        `SELECT id, owner_agent_id
         FROM "Lead"
         WHERE id = $1`,
        [payload.lead_id]
      );

      if (!leadResult.rowCount || !leadResult.rows[0]) {
        throw new NotFoundException('Lead not found');
      }

      const target = await this.resolveEmailReplyTarget(client, user, payload);

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
          'email_sent',
          'outbound',
          $2,
          $3,
          $4,
          $5::jsonb,
          now()
         )
         ON CONFLICT (mailbox_connection_id, provider_event_id)
         WHERE channel = 'email' AND provider_event_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          payload.lead_id,
          target.mailbox_connection_id,
          providerEventId,
          this.rawContentCryptoService.encrypt(payload.body),
          JSON.stringify({ thread_id: target.thread_id, subject: payload.subject })
        ]
      );

      if (insertResult.rowCount) {
        await this.leadsService.applyTouch(client, payload.lead_id, leadResult.rows[0].owner_agent_id as string);
      }
    });

    return { sent: true, provider_event_id: providerEventId };
  }

  async sendSms(user: UserContext, payload: SmsSendPayload): Promise<{ sent: boolean; provider_event_id: string }> {
    const providerEventId = payload.provider_event_id ?? `local-sms-${uuidv4()}`;

    await this.databaseService.withUserTransaction(user, async (client) => {
      const leadResult = await client.query(
        `SELECT id, owner_agent_id
         FROM "Lead"
         WHERE id = $1`,
        [payload.lead_id]
      );

      if (!leadResult.rowCount || !leadResult.rows[0]) {
        throw new NotFoundException('Lead not found');
      }

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
          'sms_sent',
          'outbound',
          $2,
          $3,
          $4,
          '{}'::jsonb,
          now()
         )
         ON CONFLICT (phone_number_id, provider_event_id)
         WHERE channel = 'sms' AND provider_event_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          payload.lead_id,
          payload.phone_number_id,
          providerEventId,
          this.rawContentCryptoService.encrypt(payload.body)
        ]
      );

      if (insertResult.rowCount) {
        await this.leadsService.applyTouch(client, payload.lead_id, leadResult.rows[0].owner_agent_id as string);
      }
    });

    return { sent: true, provider_event_id: providerEventId };
  }

  private async resolveEmailReplyTarget(
    client: PoolClient,
    user: UserContext,
    payload: EmailReplyPayload
  ): Promise<{ mailbox_connection_id: string; thread_id: string }> {
    if (payload.mailbox_connection_id) {
      const mailboxResult = await client.query(
        `SELECT id
         FROM "MailboxConnection"
         WHERE id = $1
         LIMIT 1`,
        [payload.mailbox_connection_id]
      );

      if (!mailboxResult.rowCount || !mailboxResult.rows[0]) {
        throw new NotFoundException('Mailbox connection not found');
      }

      return {
        mailbox_connection_id: payload.mailbox_connection_id,
        thread_id: payload.thread_id ?? `lead-${payload.lead_id}`
      };
    }

    const latestEmailEvent = await client.query(
      `SELECT mailbox_connection_id, meta
       FROM "ConversationEvent"
       WHERE lead_id = $1
         AND channel = 'email'
         AND mailbox_connection_id IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [payload.lead_id]
    );

    if (latestEmailEvent.rowCount && latestEmailEvent.rows[0]) {
      const mailboxConnectionId = latestEmailEvent.rows[0].mailbox_connection_id;
      if (typeof mailboxConnectionId === 'string') {
        const meta = latestEmailEvent.rows[0].meta;
        const metaThreadId =
          meta && typeof meta === 'object' && !Array.isArray(meta)
            ? (meta as { thread_id?: unknown }).thread_id
            : undefined;

        return {
          mailbox_connection_id: mailboxConnectionId,
          thread_id:
            payload.thread_id
            ?? (typeof metaThreadId === 'string' ? metaThreadId : undefined)
            ?? `lead-${payload.lead_id}`
        };
      }
    }

    const defaultMailbox = await client.query(
      `SELECT id
       FROM "MailboxConnection"
       WHERE user_id = $1
         AND status = 'active'
       ORDER BY created_at ASC
       LIMIT 1`,
      [user.userId]
    );

    if (!defaultMailbox.rowCount || !defaultMailbox.rows[0] || typeof defaultMailbox.rows[0].id !== 'string') {
      throw new NotFoundException('No active mailbox connection found. Connect Gmail or Outlook first.');
    }

    return {
      mailbox_connection_id: defaultMailbox.rows[0].id,
      thread_id: payload.thread_id ?? `lead-${payload.lead_id}`
    };
  }
}
