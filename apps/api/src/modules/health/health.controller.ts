import { Controller, Get } from '@nestjs/common';

import { Public } from '../../common/auth/public.decorator';
import { DatabaseService } from '../../common/db/database.service';
import { Roles } from '../../common/rbac/roles.decorator';

@Controller('health')
export class HealthController {
  constructor(private readonly databaseService: DatabaseService) {}

  @Public()
  @Get()
  check(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Roles('TEAM_LEAD')
  @Get('/metrics')
  async metrics(): Promise<Record<string, number>> {
    const [events, tasks, stale] = await Promise.all([
      this.databaseService.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM \"ConversationEvent\"'),
      this.databaseService.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM \"Task\" WHERE status = \'open\''),
      this.databaseService.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM \"Lead\" WHERE state = \'Stale\'')
    ]);

    return {
      conversation_events_total: events.rows[0]?.count ?? 0,
      open_tasks_total: tasks.rows[0]?.count ?? 0,
      stale_leads_total: stale.rows[0]?.count ?? 0
    };
  }
}
