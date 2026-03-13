import { z } from 'zod';

export const emailWebhookSchema = z.object({
  provider_event_id: z.string().min(1),
  mailbox_connection_id: z.string().uuid().optional(),
  mailbox_email: z.string().email().optional(),
  from_email: z.string().email(),
  direction: z.enum(['inbound', 'outbound']),
  subject: z.string().optional(),
  body: z.string().optional(),
  thread_id: z.string().optional(),
  timestamp: z.string().datetime().optional()
});

export const smsWebhookSchema = z.object({
  provider_event_id: z.string().min(1),
  phone_number_id: z.string().uuid().optional(),
  to_number: z.string().optional(),
  from_number: z.string().min(4),
  direction: z.enum(['inbound', 'outbound']),
  body: z.string().optional(),
  timestamp: z.string().datetime().optional()
});

export const callWebhookSchema = z.object({
  provider_event_id: z.string().min(1),
  phone_number_id: z.string().uuid().optional(),
  to_number: z.string().optional(),
  from_number: z.string().min(4),
  direction: z.enum(['inbound', 'outbound']),
  status: z.string().min(1),
  duration_seconds: z.number().int().nonnegative().optional(),
  timestamp: z.string().datetime().optional()
});
