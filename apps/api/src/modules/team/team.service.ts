import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  EscalationRules,
  brokerIntakeRuleSchema,
  escalationRuleSchema,
  slaRuleSchema,
  staleRuleSchema,
  templateCreateSchema
} from '@mvp/shared-types';
import { v4 as uuidv4 } from 'uuid';

import { TeamCodeService } from '../../common/auth/team-code.service';
import { DatabaseService } from '../../common/db/database.service';
import { UserContext } from '../../common/auth/user-context';
import {
  AdminLeadQueueRow,
  AgentLinkRow,
  assignBrokerTaskSchema,
  AssignableAgentRow,
  linkAgentClerkSchema,
  teamRuleUpdateSchema,
  TeamJoinCodeRow
} from './team.contracts';

@Injectable()
export class TeamService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly teamCodeService: TeamCodeService
  ) {}

  async getTemplates(user: UserContext): Promise<Record<string, unknown>[]> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query(
        'SELECT escalation_rules FROM "Team" WHERE id = $1',
        [user.teamId]
      );

      if (!result.rowCount || !result.rows[0]) {
        throw new NotFoundException('Team not found');
      }

      const rules = escalationRuleSchema.parse(result.rows[0].escalation_rules as EscalationRules);
      return rules.templates;
    });
  }

  async createTemplate(user: UserContext, payload: unknown): Promise<Record<string, unknown>> {
    const template = templateCreateSchema.parse(payload);

    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query('SELECT escalation_rules FROM "Team" WHERE id = $1', [user.teamId]);
      if (!result.rowCount || !result.rows[0]) {
        throw new NotFoundException('Team not found');
      }

      const rules = escalationRuleSchema.parse(result.rows[0].escalation_rules as EscalationRules);
      const nextTemplate = {
        id: uuidv4(),
        updated_at: new Date().toISOString(),
        ...template
      };
      const updatedRules = {
        ...rules,
        templates: [...rules.templates, nextTemplate]
      };

      await client.query('UPDATE "Team" SET escalation_rules = $2::jsonb WHERE id = $1', [
        user.teamId,
        JSON.stringify(updatedRules)
      ]);

      return nextTemplate;
    });
  }

  async updateTemplate(user: UserContext, templateId: string, payload: unknown): Promise<Record<string, unknown>> {
    const template = templateCreateSchema.parse(payload);

    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query('SELECT escalation_rules FROM "Team" WHERE id = $1', [user.teamId]);
      if (!result.rowCount || !result.rows[0]) {
        throw new NotFoundException('Team not found');
      }

      const rules = escalationRuleSchema.parse(result.rows[0].escalation_rules as EscalationRules);
      const templateExists = rules.templates.some((item) => item.id === templateId);
      if (!templateExists) {
        throw new NotFoundException('Template not found');
      }

      const updatedTemplate = {
        id: templateId,
        updated_at: new Date().toISOString(),
        ...template
      };

      const updatedRules = {
        ...rules,
        templates: rules.templates.map((item) => (item.id === templateId ? updatedTemplate : item))
      };

      await client.query('UPDATE "Team" SET escalation_rules = $2::jsonb WHERE id = $1', [
        user.teamId,
        JSON.stringify(updatedRules)
      ]);

      return updatedTemplate;
    });
  }

  async deleteTemplate(user: UserContext, templateId: string): Promise<{ id: string; deleted: true }> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query('SELECT escalation_rules FROM "Team" WHERE id = $1', [user.teamId]);
      if (!result.rowCount || !result.rows[0]) {
        throw new NotFoundException('Team not found');
      }

      const rules = escalationRuleSchema.parse(result.rows[0].escalation_rules as EscalationRules);
      const updatedRules = {
        ...rules,
        templates: rules.templates.filter((item) => item.id !== templateId)
      };

      await client.query('UPDATE "Team" SET escalation_rules = $2::jsonb WHERE id = $1', [
        user.teamId,
        JSON.stringify(updatedRules)
      ]);

      return { id: templateId, deleted: true };
    });
  }

  async getRescueSequences(user: UserContext): Promise<Record<string, unknown>[]> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query('SELECT escalation_rules FROM "Team" WHERE id = $1', [user.teamId]);
      if (!result.rowCount || !result.rows[0]) {
        throw new NotFoundException('Team not found');
      }

      const rules = escalationRuleSchema.parse(result.rows[0].escalation_rules as EscalationRules);
      return rules.rescue_sequences;
    });
  }

  async updateRescueSequences(user: UserContext, payload: unknown): Promise<Record<string, unknown>[]> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query('SELECT escalation_rules FROM "Team" WHERE id = $1', [user.teamId]);
      if (!result.rowCount || !result.rows[0]) {
        throw new NotFoundException('Team not found');
      }

      const existing = escalationRuleSchema.parse(result.rows[0].escalation_rules as EscalationRules);
      const sequenceUpdateSchema = escalationRuleSchema.pick({ rescue_sequences: true });
      const parsed = sequenceUpdateSchema.parse(payload);
      const updated = {
        ...existing,
        rescue_sequences: parsed.rescue_sequences
      };

      await client.query('UPDATE "Team" SET escalation_rules = $2::jsonb WHERE id = $1', [
        user.teamId,
        JSON.stringify(updated)
      ]);

      return updated.rescue_sequences;
    });
  }

  async getSlaDashboard(user: UserContext): Promise<Record<string, unknown>> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const [tasksDue, tasksDone, staleLeads, activeLeads] = await Promise.all([
        client.query(`SELECT COUNT(*)::int AS count FROM "Task" WHERE status = 'open' AND due_at <= now()`),
        client.query(
          `SELECT COUNT(*)::int AS count
           FROM "Task"
           WHERE status = 'done' AND created_at >= date_trunc('day', now())`
        ),
        client.query(`SELECT COUNT(*)::int AS count FROM "Lead" WHERE state = 'Stale'`),
        client.query(`SELECT COUNT(*)::int AS count FROM "Lead" WHERE state = 'Active'`)
      ]);

      return {
        tasks_due_today: tasksDue.rows[0].count,
        tasks_done_today: tasksDone.rows[0].count,
        stale_leads: staleLeads.rows[0].count,
        active_leads: activeLeads.rows[0].count
      };
    });
  }

  async getRules(user: UserContext): Promise<Record<string, unknown>> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query(
        `SELECT stale_rules, sla_rules, escalation_rules
         FROM "Team"
         WHERE id = $1`,
        [user.teamId]
      );

      if (!result.rowCount || !result.rows[0]) {
        throw new NotFoundException('Team not found');
      }

      const staleRules = staleRuleSchema.parse(result.rows[0].stale_rules);
      const slaRules = slaRuleSchema.parse(result.rows[0].sla_rules);
      const escalationRules = escalationRuleSchema.parse(result.rows[0].escalation_rules as EscalationRules);

      return {
        stale_rules: staleRules,
        sla_rules: slaRules,
        escalation_rules: escalationRules
      };
    });
  }

  async getTeamJoinCode(user: UserContext): Promise<{ team_code: string; generated_at: string }> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const teamResult = await client.query<TeamJoinCodeRow>(
        `SELECT join_code_hash, join_code_encrypted, join_code_generated_at
         FROM "Team"
         WHERE id = $1
         FOR UPDATE`,
        [user.teamId]
      );

      if (!teamResult.rowCount || !teamResult.rows[0]) {
        throw new NotFoundException('Team not found');
      }

      const existingCode = this.teamCodeService.decrypt(teamResult.rows[0].join_code_encrypted);
      if (existingCode && teamResult.rows[0].join_code_generated_at) {
        return {
          team_code: existingCode,
          generated_at: teamResult.rows[0].join_code_generated_at
        };
      }

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const generatedCode = this.teamCodeService.generate();
        try {
          const updated = await client.query<TeamJoinCodeRow>(
            `UPDATE "Team"
             SET join_code_hash = $2,
                 join_code_encrypted = $3,
                 join_code_generated_at = now()
             WHERE id = $1
               AND (join_code_hash IS NULL OR join_code_encrypted IS NULL OR join_code_generated_at IS NULL)
             RETURNING join_code_hash, join_code_encrypted, join_code_generated_at`,
            [user.teamId, generatedCode.hash, generatedCode.encrypted]
          );

          if (updated.rows[0]) {
            return {
              team_code: generatedCode.code,
              generated_at: updated.rows[0].join_code_generated_at as string
            };
          }
        } catch (error: unknown) {
          if (this.isUniqueViolation(error, 'ux_team_join_code_hash')) {
            continue;
          }
          throw error;
        }
      }

      throw new Error('Unable to generate unique team code');
    });
  }

  async getAssignableAgents(user: UserContext): Promise<AssignableAgentRow[]> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query<AssignableAgentRow>(
        `SELECT id, role, language
         FROM "User"
         WHERE team_id = $1
           AND role = 'AGENT'
         ORDER BY id`,
        [user.teamId]
      );

      return result.rows;
    });
  }

  async linkAgentClerkId(
    user: UserContext,
    agentUserId: string,
    payload: unknown
  ): Promise<{ user_id: string; team_id: string; role: 'AGENT'; clerk_id: string; linked: true }> {
    const parsed = linkAgentClerkSchema.parse(payload);

    return this.databaseService.withUserTransaction(user, async (client) => {
      const targetAgent = await client.query<AgentLinkRow>(
        `SELECT id, team_id, role, clerk_id
         FROM "User"
         WHERE id = $1
           AND team_id = $2
           AND role = 'AGENT'
         LIMIT 1`,
        [agentUserId, user.teamId]
      );

      const existingAgent = targetAgent.rows[0];
      if (!existingAgent) {
        throw new NotFoundException('Agent not found');
      }

      if (existingAgent.clerk_id) {
        if (existingAgent.clerk_id !== parsed.clerk_id) {
          throw new ConflictException('Agent is already linked to a different Clerk account');
        }

        return {
          user_id: existingAgent.id,
          team_id: existingAgent.team_id,
          role: 'AGENT',
          clerk_id: existingAgent.clerk_id,
          linked: true
        };
      }

      const existingForClerkId = await client.query<AgentLinkRow>(
        `SELECT id, team_id, role, clerk_id
         FROM "User"
         WHERE clerk_id = $1
         LIMIT 1`,
        [parsed.clerk_id]
      );
      const linkedUser = existingForClerkId.rows[0];
      if (linkedUser && linkedUser.id !== existingAgent.id) {
        throw new ConflictException('Clerk account is already linked to another user');
      }

      try {
        const updated = await client.query<AgentLinkRow>(
          `UPDATE "User"
           SET clerk_id = $2
           WHERE id = $1
           RETURNING id, team_id, role, clerk_id`,
          [existingAgent.id, parsed.clerk_id]
        );

        if (!updated.rows[0] || updated.rows[0].role !== 'AGENT' || !updated.rows[0].clerk_id) {
          throw new NotFoundException('Agent not found');
        }

        return {
          user_id: updated.rows[0].id,
          team_id: updated.rows[0].team_id,
          role: 'AGENT',
          clerk_id: updated.rows[0].clerk_id,
          linked: true
        };
      } catch (error: unknown) {
        if (this.isUserClerkIdUniqueViolation(error)) {
          throw new ConflictException('Clerk account is already linked to another user');
        }
        throw error;
      }
    });
  }

  async getAdminIntakeQueue(user: UserContext): Promise<Record<string, unknown>[]> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query<AdminLeadQueueRow>(
        `SELECT t.id AS task_id,
                l.id AS lead_id,
                t.type AS task_type,
                t.status AS task_status,
                t.due_at,
                l.state AS lead_state,
                l.owner_agent_id,
                l.primary_email,
                l.primary_phone,
                d.summary,
                d.language,
                d.fields_json,
                le.latest_event
         FROM "Task" t
         JOIN "Lead" l ON l.id = t.lead_id
         LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = l.id
         LEFT JOIN LATERAL (
           SELECT jsonb_build_object(
             'id', em.id,
             'channel', em.channel,
             'type', em.type,
             'direction', em.direction,
             'created_at', em.created_at
           ) AS latest_event
           FROM team_event_metadata(l.id) em
           ORDER BY em.created_at DESC
           LIMIT 1
         ) le ON true
         WHERE l.team_id = $1
           AND t.status = 'open'
           AND t.owner_id = $2
           AND l.state IN ('New', 'Active', 'At-Risk')
           AND COALESCE(d.fields_json->>'intake_origin', 'agent_direct') = 'broker_channel'
           AND COALESCE((d.fields_json->>'broker_assigned')::boolean, false) = false
         ORDER BY t.due_at ASC
         LIMIT 200`,
        [user.teamId, user.userId]
      );

      return result.rows.map((row) => ({
        ...row,
        intake_origin: 'broker_channel'
      }));
    });
  }

  async getAdminAssignedQueue(user: UserContext): Promise<Record<string, unknown>[]> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query<AdminLeadQueueRow>(
        `SELECT nt.task_id,
                l.id AS lead_id,
                nt.task_type,
                nt.task_status,
                nt.due_at,
                l.state AS lead_state,
                l.owner_agent_id,
                l.primary_email,
                l.primary_phone,
                d.summary,
                d.language,
                d.fields_json,
                le.latest_event
         FROM "Lead" l
         LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = l.id
         LEFT JOIN LATERAL (
           SELECT jsonb_build_object(
             'id', em.id,
             'channel', em.channel,
             'type', em.type,
             'direction', em.direction,
             'created_at', em.created_at
           ) AS latest_event
           FROM team_event_metadata(l.id) em
           ORDER BY em.created_at DESC
           LIMIT 1
         ) le ON true
         LEFT JOIN LATERAL (
           SELECT t.id AS task_id,
                  t.type AS task_type,
                  t.status AS task_status,
                  t.due_at
           FROM "Task" t
           WHERE t.lead_id = l.id
             AND t.status = 'open'
           ORDER BY t.due_at ASC
           LIMIT 1
         ) nt ON true
         WHERE l.team_id = $1
           AND l.state IN ('New', 'Active', 'At-Risk')
           AND COALESCE(d.fields_json->>'intake_origin', 'agent_direct') = 'broker_channel'
           AND COALESCE((d.fields_json->>'broker_assigned')::boolean, false) = true
         ORDER BY COALESCE(nt.due_at, l.updated_at) ASC
         LIMIT 200`,
        [user.teamId]
      );

      return result.rows.map((row) => ({
        ...row,
        intake_origin: 'broker_channel'
      }));
    });
  }

  async getAdminReassignQueue(user: UserContext): Promise<Record<string, unknown>[]> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query<AdminLeadQueueRow>(
        `SELECT nt.task_id,
                l.id AS lead_id,
                nt.task_type,
                nt.task_status,
                nt.due_at,
                l.state AS lead_state,
                l.owner_agent_id,
                l.primary_email,
                l.primary_phone,
                d.summary,
                d.language,
                d.fields_json,
                le.latest_event
         FROM "Lead" l
         LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = l.id
         LEFT JOIN LATERAL (
           SELECT jsonb_build_object(
             'id', em.id,
             'channel', em.channel,
             'type', em.type,
             'direction', em.direction,
             'created_at', em.created_at
           ) AS latest_event
           FROM team_event_metadata(l.id) em
           ORDER BY em.created_at DESC
           LIMIT 1
         ) le ON true
         LEFT JOIN LATERAL (
           SELECT t.id AS task_id,
                  t.type AS task_type,
                  t.status AS task_status,
                  t.due_at
           FROM "Task" t
           WHERE t.lead_id = l.id
             AND t.status = 'open'
             AND t.type = 'rescue'
           ORDER BY t.due_at ASC
           LIMIT 1
         ) nt ON true
         WHERE l.team_id = $1
           AND l.state = 'Stale'
           AND COALESCE(d.fields_json->>'intake_origin', 'agent_direct') = 'broker_channel'
           AND COALESCE((d.fields_json->>'broker_assigned')::boolean, false) = true
         ORDER BY COALESCE(nt.due_at, l.updated_at) ASC
         LIMIT 200`,
        [user.teamId]
      );

      return result.rows.map((row) => ({
        ...row,
        intake_origin: 'broker_channel'
      }));
    });
  }

  async assignBrokerTask(
    user: UserContext,
    taskId: string,
    payload: unknown
  ): Promise<{ task_id: string; lead_id: string; owner_agent_id: string }> {
    const parsed = assignBrokerTaskSchema.parse(payload);

    return this.databaseService.withUserTransaction(user, async (client) => {
      const task = await client.query<AdminLeadQueueRow>(
        `SELECT t.id AS task_id,
                l.id AS lead_id,
                t.type AS task_type,
                t.status AS task_status,
                t.due_at,
                l.state AS lead_state,
                l.owner_agent_id,
                l.primary_email,
                l.primary_phone,
                d.summary,
                d.language,
                d.fields_json
         FROM "Task" t
         JOIN "Lead" l ON l.id = t.lead_id
         LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = l.id
         WHERE t.id = $1
           AND l.team_id = $2
         LIMIT 1`,
        [taskId, user.teamId]
      );

      if (!task.rowCount || !task.rows[0]) {
        throw new NotFoundException('Task not found');
      }

      if (task.rows[0].task_status !== 'open') {
        throw new ForbiddenException('Only open tasks can be assigned');
      }

      const intakeOrigin = String(task.rows[0].fields_json?.intake_origin ?? 'agent_direct');
      if (intakeOrigin !== 'broker_channel') {
        throw new ForbiddenException('Only broker-channel leads can be assigned from admin queue');
      }

      const assignee = await client.query<AssignableAgentRow>(
        `SELECT id, role, language
         FROM "User"
         WHERE id = $1
           AND team_id = $2
           AND role = 'AGENT'
         LIMIT 1`,
        [parsed.assignee_user_id, user.teamId]
      );

      if (!assignee.rowCount || !assignee.rows[0]) {
        throw new NotFoundException('Assignee not found');
      }

      const assignedAt = new Date().toISOString();
      const currentFields = task.rows[0].fields_json ?? {};
      const nextFields = {
        ...currentFields,
        intake_origin: 'broker_channel',
        broker_assigned: true,
        assigned_by_team_lead_id: user.userId,
        assigned_owner_id: parsed.assignee_user_id,
        assigned_at: assignedAt
      };

      await client.query(
        `UPDATE "Lead"
         SET owner_agent_id = $2,
             updated_at = now()
         WHERE id = $1`,
        [task.rows[0].lead_id, parsed.assignee_user_id]
      );

      await client.query(
        `UPDATE "Task"
         SET owner_id = $2
         WHERE lead_id = $1
           AND status = 'open'`,
        [task.rows[0].lead_id, parsed.assignee_user_id]
      );

      await client.query(
        `INSERT INTO "DerivedLeadProfile" (lead_id, summary, language, fields_json, metrics_json, updated_at)
         VALUES ($1, 'New lead awaiting first contact.', 'en', $2::jsonb, '{}'::jsonb, now())
         ON CONFLICT (lead_id)
         DO UPDATE
         SET fields_json = $2::jsonb,
             updated_at = now()`,
        [task.rows[0].lead_id, JSON.stringify(nextFields)]
      );

      await client.query(
        `INSERT INTO "AuditLog" (actor_id, lead_id, action, reason)
         VALUES ($1, $2, 'BROKER_TASK_ASSIGN', $3)`,
        [user.userId, task.rows[0].lead_id, parsed.reason]
      );

      return {
        task_id: taskId,
        lead_id: task.rows[0].lead_id,
        owner_agent_id: parsed.assignee_user_id
      };
    });
  }

  async updateRules(user: UserContext, payload: unknown): Promise<Record<string, unknown>> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const teamResult = await client.query(
        'SELECT stale_rules, sla_rules, escalation_rules FROM "Team" WHERE id = $1',
        [user.teamId]
      );

      if (!teamResult.rowCount || !teamResult.rows[0]) {
        throw new NotFoundException('Team not found');
      }

      const current = teamResult.rows[0];
      const override = teamRuleUpdateSchema.parse(payload);
      const stalePatch = staleRuleSchema.partial().parse(override);
      const slaPatch = slaRuleSchema.partial().parse(override);

      const staleRules = staleRuleSchema.parse({ ...(current.stale_rules as object), ...stalePatch });
      const existingSla = slaRuleSchema.parse(current.sla_rules);
      const nextSlaRules = {
        ...existingSla,
        ...slaPatch
      };
      const existingEscalation = escalationRuleSchema.parse(current.escalation_rules as EscalationRules);
      const nextBrokerIntake = override.broker_intake
        ? brokerIntakeRuleSchema.parse({
            ...existingEscalation.broker_intake,
            ...override.broker_intake
          })
        : existingEscalation.broker_intake;
      const nextEscalationRules = {
        ...existingEscalation,
        broker_intake: nextBrokerIntake
      };

      await client.query(
        `UPDATE "Team"
         SET stale_rules = $2::jsonb,
             sla_rules = $3::jsonb,
             escalation_rules = $4::jsonb
         WHERE id = $1`,
        [user.teamId, JSON.stringify(staleRules), JSON.stringify(nextSlaRules), JSON.stringify(nextEscalationRules)]
      );

      return {
        stale_rules: staleRules,
        sla_rules: nextSlaRules,
        escalation_rules: nextEscalationRules
      };
    });
  }

  private isUniqueViolation(error: unknown, constraint: string): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const pgError = error as { code?: string; constraint?: string };
    return pgError.code === '23505' && pgError.constraint === constraint;
  }

  private isUserClerkIdUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const pgError = error as {
      code?: string;
      constraint?: string;
      table?: string;
      detail?: string;
    };

    if (pgError.code !== '23505') {
      return false;
    }

    const knownConstraints = new Set(['ux_user_clerk_id', 'User_clerk_id_key']);
    if (pgError.constraint && knownConstraints.has(pgError.constraint)) {
      return true;
    }

    return (
      (pgError.table === 'User' || pgError.table === '"User"')
      && typeof pgError.detail === 'string'
      && pgError.detail.includes('(clerk_id)')
    );
  }

}
