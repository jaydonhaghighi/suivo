import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

@Injectable()
export class QueueBootstrapService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueBootstrapService.name);

  private readonly staleQueue: Queue;
  private readonly mailSyncQueue: Queue;

  constructor(private readonly configService: ConfigService) {
    this.staleQueue = new Queue('stale-detection', {
      connection: {
        url: this.configService.getOrThrow<string>('REDIS_URL')
      }
    });
    this.mailSyncQueue = new Queue('mail-sync', {
      connection: {
        url: this.configService.getOrThrow<string>('REDIS_URL')
      }
    });
  }

  async registerRecurringJobs(): Promise<void> {
    const mailSyncEveryMinutes = Number.parseInt(
      this.configService.get<string>('MAIL_SYNC_EVERY_MINUTES') ?? '5',
      10
    );
    const safeMailSyncEveryMinutes = Number.isNaN(mailSyncEveryMinutes)
      ? 5
      : Math.max(1, Math.min(60, mailSyncEveryMinutes));

    await this.staleQueue.upsertJobScheduler('stale-detection-recurring', {
      every: 5 * 60 * 1000
    }, {
      name: 'evaluate-stale'
    });

    await this.mailSyncQueue.upsertJobScheduler('mail-sync-recurring', {
      every: safeMailSyncEveryMinutes * 60 * 1000
    }, {
      name: 'poll-gmail-inbox',
      data: {
        triggeredBy: 'scheduler'
      }
    });

    this.logger.log('Recurring stale detection job registered (every 5 minutes)');
    this.logger.log(`Recurring mail sync job registered (every ${safeMailSyncEveryMinutes} minutes)`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.staleQueue.close();
    await this.mailSyncQueue.close();
  }
}
