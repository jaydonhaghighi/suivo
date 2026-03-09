import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { LeadsModule } from '../leads/leads.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [LeadsModule, AiModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService]
})
export class WebhooksModule {}
