import { Module } from '@nestjs/common';

import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { EmailClassifierService } from './email-classifier.service';

@Module({
  controllers: [AiController],
  providers: [AiService, EmailClassifierService],
  exports: [EmailClassifierService]
})
export class AiModule {}
