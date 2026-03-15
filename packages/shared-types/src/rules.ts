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

export const voiceQualificationRuleSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['manual', 'auto', 'both']).default('both'),
  assistant_provider: z.enum(['telnyx_ai', 'openai_sip']).default('openai_sip'),
  assistant_model: z.string().min(1).default('gpt-4o-mini'),
  assistant_voice: z.string().min(1).default('AWS.Polly.Joanna-Neural'),
  call_window_start: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
  call_window_end: z.string().regex(/^\d{2}:\d{2}$/).default('20:00'),
  quiet_window_start: z.string().regex(/^\d{2}:\d{2}$/).default('12:00'),
  quiet_window_end: z.string().regex(/^\d{2}:\d{2}$/).default('13:30'),
  max_attempts: z.number().int().min(1).max(10).default(4),
  retry_schedule_minutes: z.array(z.number().int().nonnegative()).min(1).max(10).default([0, 120, 1440, 4320])
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
  }),
  voice_qualification: voiceQualificationRuleSchema.default({
    enabled: true,
    mode: 'both',
    assistant_provider: 'openai_sip',
    assistant_model: 'gpt-4o-mini',
    assistant_voice: 'AWS.Polly.Joanna-Neural',
    call_window_start: '09:00',
    call_window_end: '20:00',
    quiet_window_start: '12:00',
    quiet_window_end: '13:30',
    max_attempts: 4,
    retry_schedule_minutes: [0, 120, 1440, 4320]
  })
});

export type StaleRules = z.infer<typeof staleRuleSchema>;
export type SlaRules = z.infer<typeof slaRuleSchema>;
export type EscalationRules = z.infer<typeof escalationRuleSchema>;
