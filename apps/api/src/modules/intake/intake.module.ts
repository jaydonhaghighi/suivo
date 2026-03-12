import { Module } from '@nestjs/common';

import { WebhooksModule } from '../webhooks/webhooks.module';
import { IntakeController } from './intake.controller';

@Module({
  imports: [WebhooksModule],
  controllers: [IntakeController]
})
export class IntakeModule {}
