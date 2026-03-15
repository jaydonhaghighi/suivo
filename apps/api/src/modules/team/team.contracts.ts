import { brokerIntakeRuleSchema, slaRuleSchema, staleRuleSchema, voiceQualificationRuleSchema } from '@mvp/shared-types';
import { z } from 'zod';

export interface AdminLeadQueueRow {
  task_id: string | null;
  lead_id: string;
  task_type: string | null;
  task_status: string | null;
  due_at: string | null;
  lead_state: string;
  owner_agent_id: string;
  primary_email: string | null;
  primary_phone: string | null;
  summary: string | null;
  language: string | null;
  fields_json: Record<string, unknown> | null;
  latest_event: Record<string, unknown> | null;
}

export interface AssignableAgentRow {
  id: string;
  role: 'AGENT';
  language: string;
}

export interface AgentLinkRow {
  id: string;
  team_id: string;
  role: 'AGENT' | 'TEAM_LEAD';
  clerk_id: string | null;
}

export interface TeamJoinCodeRow {
  join_code_hash: string | null;
  join_code_encrypted: Buffer | null;
  join_code_generated_at: string | null;
}

export const assignBrokerTaskSchema = z.object({
  assignee_user_id: z.string().uuid(),
  reason: z.string().min(1).max(500)
});

export const linkAgentClerkSchema = z.object({
  clerk_id: z.string().min(1).max(255)
});

export const teamRuleUpdateSchema = staleRuleSchema
  .partial()
  .merge(slaRuleSchema.partial())
  .merge(
    z.object({
      broker_intake: brokerIntakeRuleSchema.partial().optional(),
      voice_qualification: voiceQualificationRuleSchema.partial().optional()
    })
  );
