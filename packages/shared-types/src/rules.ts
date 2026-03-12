import { z } from 'zod';

export const staleRuleSchema = z.object({
  new_lead_sla_minutes: z.number().int().positive().default(60),
  active_stale_hours: z.number().int().positive().default(48),
  at_risk_threshold_percent: z.number().int().min(1).max(99).default(80),
  timezone: z.string().default('UTC')
});

export const slaRuleSchema = z.object({
  escalation_enabled: z.boolean().default(true),
  response_target_minutes: z.number().int().positive().default(60)
});

export const templateSchema = z.object({
  id: z.string().uuid(),
  language: z.string().min(2),
  channel: z.enum(['email', 'sms']),
  name: z.string().min(1),
  body: z.string().min(1),
  updated_at: z.string().datetime()
});

export const rescueStepSchema = z.object({
  id: z.string().uuid(),
  offset_minutes: z.number().int().nonnegative(),
  channel: z.enum(['email', 'sms', 'call', 'task']),
  template_id: z.string().uuid().optional(),
  requires_human_send: z.boolean().default(true),
  enabled: z.boolean().default(true)
});

export const brokerIntakeRuleSchema = z.object({
  mailbox_connection_ids: z.array(z.string().uuid()).default([]),
  phone_number_ids: z.array(z.string().uuid()).default([]),
  stale_hours_for_assigned: z.number().int().positive().default(168)
});

export const escalationRuleSchema = z.object({
  templates: z.array(templateSchema).default([]),
  rescue_sequences: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string().min(1),
      language: z.string().min(2),
      steps: z.array(rescueStepSchema).min(1),
      updated_at: z.string().datetime()
    })
  ).default([]),
  broker_intake: brokerIntakeRuleSchema.default({
    mailbox_connection_ids: [],
    phone_number_ids: [],
    stale_hours_for_assigned: 168
  })
});

export type StaleRules = z.infer<typeof staleRuleSchema>;
export type SlaRules = z.infer<typeof slaRuleSchema>;
export type EscalationRules = z.infer<typeof escalationRuleSchema>;
