import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { LeadsModule } from '../leads/leads.module';
import { VoiceModule } from '../voice/voice.module';
import { EmailIntakeQualificationService } from './email-intake-qualification.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [LeadsModule, AiModule, VoiceModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, EmailIntakeQualificationService],
  exports: [WebhooksService]
})
export class WebhooksModule {}
