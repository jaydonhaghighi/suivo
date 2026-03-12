import { z } from 'zod';

import { LEAD_STATES, TASK_STATUSES, TASK_TYPES } from './enums';

export const taskDeckQuerySchema = z.object({
  due_before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export const taskSnoozeSchema = z.object({
  mode: z.enum(['today', 'tomorrow', 'next_week'])
});

export const callOutcomeSchema = z.object({
  outcome: z.string().min(1),
  notes: z.string().optional(),
  completed_at: z.string().datetime().optional()
});

export const templateCreateSchema = z.object({
  language: z.string().min(2),
  channel: z.enum(['email', 'sms']),
  name: z.string().min(1),
  body: z.string().min(1)
});

export const aiDraftSchema = z.object({
  lead_id: z.string().uuid(),
  channel: z.enum(['email', 'sms']),
  instruction: z.string().optional(),
  human_action_required: z.literal(true)
});

export const aiSummaryRefreshSchema = z.object({
  lead_id: z.string().uuid(),
  human_action_required: z.literal(true)
});

export const roleHeaderSchema = z.object({
  user_id: z.string().uuid(),
  team_id: z.string().uuid(),
  role: z.enum(['AGENT', 'TEAM_LEAD'])
});

const onboardingBaseSchema = z.object({
  language: z.string().min(2).max(10).optional()
});

export const onboardingRegisterSchema = z.discriminatedUnion('role', [
  onboardingBaseSchema.extend({
    role: z.literal('TEAM_LEAD')
  }),
  onboardingBaseSchema.extend({
    role: z.literal('AGENT'),
    team_code: z.string().min(1)
  })
]);

export const leadStateSchema = z.enum(LEAD_STATES as [string, ...string[]]);
export const taskStatusSchema = z.enum(TASK_STATUSES as [string, ...string[]]);
export const taskTypeSchema = z.enum(TASK_TYPES as [string, ...string[]]);
