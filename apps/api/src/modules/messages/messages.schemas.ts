import { z } from 'zod';

export const emailReplySchema = z.object({
  lead_id: z.string().uuid(),
  mailbox_connection_id: z.string().uuid().optional(),
  provider_event_id: z.string().optional(),
  thread_id: z.string().min(1).optional(),
  subject: z.string().min(1),
  body: z.string().min(1)
});

export const smsSendSchema = z.object({
  lead_id: z.string().uuid(),
  phone_number_id: z.string().uuid(),
  provider_event_id: z.string().optional(),
  body: z.string().min(1)
});
