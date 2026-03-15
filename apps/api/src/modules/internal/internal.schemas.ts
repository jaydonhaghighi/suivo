import { z } from 'zod';

export const mailSyncTriggerSchema = z.object({
  newer_than_hours: z.coerce.number().int().min(1).max(24 * 365).optional(),
  max_results: z.coerce.number().int().min(1).max(5000).optional(),
  mailbox_limit: z.coerce.number().int().min(1).max(500).optional()
});

const booleanFromBody = z
  .union([z.boolean(), z.literal('true'), z.literal('false')])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true'));

export const mailboxBackfillTriggerSchema = z.object({
  mailbox_id: z.string().uuid(),
  newer_than_hours: z.coerce.number().int().min(1).max(24 * 365).optional(),
  max_results: z.coerce.number().int().min(1).max(5000).optional(),
  await_classification: booleanFromBody.optional(),
  preview_limit: z.coerce.number().int().min(1).max(50).optional()
});

export const voiceDispatchTriggerSchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).optional(),
  include_auto: booleanFromBody.optional()
});
