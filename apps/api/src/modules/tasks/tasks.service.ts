import { Injectable, NotFoundException } from '@nestjs/common';

import { DatabaseService } from '../../common/db/database.service';
import { UserContext } from '../../common/auth/user-context';

@Injectable()
export class TasksService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getTaskDeck(user: UserContext, limit = 25): Promise<Record<string, unknown>[]> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query(
        `SELECT t.id,
                t.lead_id,
                t.owner_id,
                t.due_at,
                t.status,
                t.type,
                t.created_at,
                l.state AS lead_state,
                l.primary_email,
                l.primary_phone,
                d.summary,
                d.language
         FROM "Task" t
         JOIN "Lead" l ON l.id = t.lead_id
         LEFT JOIN "DerivedLeadProfile" d ON d.lead_id = t.lead_id
         WHERE t.status IN ('open', 'snoozed')
           AND t.owner_id = $1
           AND t.due_at <= now() + interval '24 hours'
         ORDER BY t.due_at ASC
         LIMIT $2`,
        [user.userId, limit]
      );

      return result.rows;
    });
  }

  async markDone(user: UserContext, taskId: string): Promise<{ id: string; status: string }> {
    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query(
        `UPDATE "Task"
         SET status = 'done'
         WHERE id = $1
         RETURNING id, status`,
        [taskId]
      );

      if (!result.rowCount || !result.rows[0]) {
        throw new NotFoundException('Task not found');
      }

      return result.rows[0];
    });
  }

  async snooze(user: UserContext, taskId: string, mode: 'today' | 'tomorrow' | 'next_week'): Promise<{ id: string; status: string; due_at: string }> {
    const intervalExpression =
      mode === 'today' ? "interval '2 hours'" : mode === 'tomorrow' ? "interval '1 day'" : "interval '7 days'";

    return this.databaseService.withUserTransaction(user, async (client) => {
      const result = await client.query(
        `UPDATE "Task"
         SET status = 'snoozed',
             due_at = now() + ${intervalExpression}
         WHERE id = $1
         RETURNING id, status, due_at`,
        [taskId]
      );

      if (!result.rowCount || !result.rows[0]) {
        throw new NotFoundException('Task not found');
      }

      return result.rows[0];
    });
  }
}
