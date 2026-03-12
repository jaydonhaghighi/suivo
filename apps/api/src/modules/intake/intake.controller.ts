import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/rbac/roles.decorator';
import { UserContext } from '../../common/auth/user-context';
import { WebhooksService } from '../webhooks/webhooks.service';

const booleanFromQuery = z
  .union([z.boolean(), z.literal('true'), z.literal('false')])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true'));

const reviewQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  include_body: booleanFromQuery.default(true)
});

const calibrationQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14)
});

const reviewDecisionSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional()
});

@Controller('intake/emails')
@Roles('AGENT', 'TEAM_LEAD')
export class IntakeController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Get('review-queue')
  async reviewQueue(
    @CurrentUser() user: UserContext,
    @Query() query: Record<string, unknown>
  ): Promise<{ items: Record<string, unknown>[] }> {
    const payload = reviewQueueQuerySchema.parse(query ?? {});
    const items = await this.webhooksService.listEmailReviewQueue(user, payload);
    return { items };
  }

  @Get('calibration/daily')
  @Roles('TEAM_LEAD')
  async calibrationDaily(
    @CurrentUser() user: UserContext,
    @Query() query: Record<string, unknown>
  ): Promise<{
    window_days: number;
    daily: Array<Record<string, unknown>>;
    review_backlog: { pending_count: number; oldest_age_minutes: number };
  }> {
    const payload = calibrationQuerySchema.parse(query ?? {});
    return this.webhooksService.getEmailIntakeDailyCalibration(user, payload.days);
  }

  @Post(':id/approve')
  async approve(
    @CurrentUser() user: UserContext,
    @Param('id') intakeId: string,
    @Body() body: unknown
  ): Promise<{ intake_id: string; status: 'lead_created'; lead_id: string; conversation_event_id?: string | undefined }> {
    const payload = reviewDecisionSchema.parse(body ?? {});
    return this.webhooksService.approveEmailIntake(user, intakeId, payload);
  }

  @Post(':id/reject')
  async reject(
    @CurrentUser() user: UserContext,
    @Param('id') intakeId: string,
    @Body() body: unknown
  ): Promise<{ intake_id: string; status: 'rejected' }> {
    const payload = reviewDecisionSchema.parse(body ?? {});
    return this.webhooksService.rejectEmailIntake(user, intakeId, payload);
  }
}
