import { voiceQualificationRuleSchema } from '@mvp/shared-types';
import { z } from 'zod';

const maybeBool = z
  .union([z.boolean(), z.literal('true'), z.literal('false')])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true'));

export const voiceLabConfigUpdateSchema = voiceQualificationRuleSchema.partial();

export const createVoiceLabSessionSchema = z.object({
  lead_id: z.string().uuid(),
  destination_number: z.string().min(7).max(24).optional()
});

export const listVoiceLabSessionsSchema = z.object({
  lead_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

export const voiceLabTranscriptQuerySchema = z.object({
  reason: z.string().trim().min(1).max(500).optional()
});

export const internalVoiceDispatchSchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(50),
  include_auto: maybeBool.default(true)
});

export const telnyxVoiceWebhookSchema = z.object({
  data: z
    .object({
      id: z.string().optional(),
      event_type: z.string().optional(),
      occurred_at: z.string().optional(),
      payload: z.record(z.unknown()).optional()
    })
    .passthrough()
    .optional(),
  event_type: z.string().optional(),
  payload: z.record(z.unknown()).optional()
}).passthrough();
