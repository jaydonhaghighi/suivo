import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { MailSyncJob } from './jobs/mail-sync.job';
import { RescueSequenceJob } from './jobs/rescue-sequence.job';
import { StaleDetectionJob } from './jobs/stale-detection.job';
import { DatabaseService } from './services/database.service';
import { QueueBootstrapService } from './services/queue-bootstrap.service';
import { StaleEvaluatorService } from './services/stale-evaluator.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env', '../../.env.local', '../../.env']
    })
  ],
  providers: [
    DatabaseService,
    StaleEvaluatorService,
    QueueBootstrapService,
    StaleDetectionJob,
    MailSyncJob,
    RescueSequenceJob
  ]
})
export class WorkerModule {}
