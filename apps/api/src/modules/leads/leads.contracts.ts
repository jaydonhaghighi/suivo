import { z } from 'zod';

export interface LeadRow {
  id: string;
  team_id: string;
  owner_agent_id: string;
  state: 'New' | 'Active' | 'At-Risk' | 'Stale';
}

export interface DerivedProfileRow {
  fields_json: Record<string, unknown> | null;
}

export interface ConversationEventRow {
  id: string;
  channel: string;
  type: string;
  direction: string;
  mailbox_connection_id: string | null;
  phone_number_id: string | null;
  provider_event_id: string | null;
  raw_body: Buffer | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface LeadProvenance {
  intake_origin: 'broker_channel' | 'agent_direct';
  intake_channel_ref: {
    mailbox_connection_id?: string | undefined;
    phone_number_id?: string | undefined;
  };
  broker_assigned: boolean;
}

export const reassignSchema = z.object({
  owner_agent_id: z.string().uuid()
});
