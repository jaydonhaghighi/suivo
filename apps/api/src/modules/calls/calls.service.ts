import { Injectable, NotFoundException } from '@nestjs/common';
import { callOutcomeSchema } from '@mvp/shared-types';
import { v4 as uuidv4 } from 'uuid';

import { DatabaseService } from '../../common/db/database.service';
import { UserContext } from '../../common/auth/user-context';
import { LeadsService } from '../leads/leads.service';

interface CallIntentPayload {
  lead_id: string;
  phone_number_id: string;
  destination: string;
}

@Injectable()
export class CallsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly leadsService: LeadsService
  ) {}

  async logIntent(user: UserContext, payload: CallIntentPayload): Promise<{ event_id: string; dialer_uri: string }> {
    const eventId = uuidv4();

    await this.databaseService.withUserTransaction(user, async (client) => {
      const leadResult = await client.query(
        `SELECT id
         FROM "Lead"
         WHERE id = $1`,
        [payload.lead_id]
      );

      if (!leadResult.rowCount) {
        throw new NotFoundException('Lead not found');
      }

      await client.query(
        `INSERT INTO "ConversationEvent" (
          id,
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
          $2,
          'call',
          'call_intent',
          'outbound',
          $3,
          $4,
          NULL,
          $5::jsonb,
          now()
        )`,
        [
          eventId,
          payload.lead_id,
          payload.phone_number_id,
          `local-call-intent-${eventId}`,
          JSON.stringify({
            destination: payload.destination,
            twilio_route: true
          })
        ]
      );
    });

    const dialerUri = `tel:${payload.destination}`;
    return { event_id: eventId, dialer_uri: dialerUri };
  }

  async submitOutcome(
    user: UserContext,
    eventId: string,
    payload: unknown
  ): Promise<{ event_id: string; outcome: string; updated: true }> {
    const parsed = callOutcomeSchema.parse(payload);

    await this.databaseService.withUserTransaction(user, async (client) => {
      const eventResult = await client.query(
        `SELECT id, lead_id
         FROM "ConversationEvent"
         WHERE id = $1
           AND channel = 'call'
         LIMIT 1`,
        [eventId]
      );

      if (!eventResult.rowCount || !eventResult.rows[0]) {
        throw new NotFoundException('Call event not found');
      }

      await client.query(
        `UPDATE "ConversationEvent"
         SET type = 'call_completed',
             meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
         WHERE id = $1`,
        [
          eventId,
          JSON.stringify({
            outcome: parsed.outcome,
            notes: parsed.notes ?? null,
            completed_at: parsed.completed_at ?? new Date().toISOString()
          })
        ]
      );

      const leadId = eventResult.rows[0].lead_id as string;
      await this.leadsService.applyTouch(client, leadId, user.userId);
    });

    return { event_id: eventId, outcome: parsed.outcome, updated: true };
  }
}
