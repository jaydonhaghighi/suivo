import { Module } from '@nestjs/common';

import { NotificationsController } from '../notifications/notifications.controller';
import { NotificationsService } from '../notifications/notifications.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  controllers: [TasksController, NotificationsController],
  providers: [TasksService, NotificationsService],
  exports: [TasksService]
})
export class TasksModule {}
