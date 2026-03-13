import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../common/auth/current-user.decorator';
import { UserContext } from '../../common/auth/user-context';
import { notificationFeedQuerySchema, readManySchema } from './notifications.schemas';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async getFeed(
    @CurrentUser() user: UserContext,
    @Query('limit') limit?: string
  ): ReturnType<NotificationsService['getFeed']> {
    const parsed = notificationFeedQuerySchema.parse({ limit });
    return this.notificationsService.getFeed(user, parsed.limit);
  }

  @Post(':id/read')
  async markRead(
    @CurrentUser() user: UserContext,
    @Param('id') notificationId: string
  ): ReturnType<NotificationsService['markRead']> {
    return this.notificationsService.markRead(user, notificationId);
  }

  @Post('read-all')
  async markAllRead(
    @CurrentUser() user: UserContext,
    @Body() body: unknown
  ): ReturnType<NotificationsService['markManyRead']> {
    const parsed = readManySchema.parse(body ?? {});
    return this.notificationsService.markManyRead(user, parsed.ids);
  }
}
