import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { DatabaseService } from './database.service';

@Injectable()
export class QueueBootstrapService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueBootstrapService.name);
  private readonly schedulerRefreshMs = 60_000;
  private schedulerRefreshTimer: NodeJS.Timeout | undefined;
  private refreshingMailSyncScheduler = false;
  private mailSyncSchedulerRegistered: boolean | null = null;

  private readonly staleQueue: Queue;
  private readonly mailSyncQueue: Queue;
  private readonly voiceDispatchQueue: Queue;

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService
  ) {
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
    this.voiceDispatchQueue = new Queue('voice-dispatch', {
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

    this.logger.log('Recurring stale detection job registered (every 5 minutes)');
    await this.refreshMailSyncScheduler(safeMailSyncEveryMinutes);
    await this.voiceDispatchQueue.upsertJobScheduler('voice-dispatch-recurring', {
      every: 60 * 1000
    }, {
      name: 'dispatch-due',
      data: {
        triggeredBy: 'scheduler'
      }
    });
    this.logger.log('Recurring voice dispatch job registered (every 1 minute)');

    this.schedulerRefreshTimer = setInterval(() => {
      void this.refreshMailSyncScheduler(safeMailSyncEveryMinutes);
    }, this.schedulerRefreshMs);
    this.schedulerRefreshTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.schedulerRefreshTimer) {
      clearInterval(this.schedulerRefreshTimer);
      this.schedulerRefreshTimer = undefined;
    }

    await this.staleQueue.close();
    await this.mailSyncQueue.close();
    await this.voiceDispatchQueue.close();
  }

  private async refreshMailSyncScheduler(mailSyncEveryMinutes: number): Promise<void> {
    if (this.refreshingMailSyncScheduler) {
      return;
    }
    this.refreshingMailSyncScheduler = true;

    try {
      const hasAnyActiveMailbox = await this.hasAnyActiveMailboxConnection();
      if (!hasAnyActiveMailbox) {
        await this.disableMailSyncScheduler();
        return;
      }

      await this.enableMailSyncScheduler(mailSyncEveryMinutes);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Unable to refresh mail sync scheduler: ${message}`);
    } finally {
      this.refreshingMailSyncScheduler = false;
    }
  }

  private async hasAnyActiveMailboxConnection(): Promise<boolean> {
    const result = await this.databaseService.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM "MailboxConnection"
       WHERE status = 'active'`
    );

    const rowCount = result.rows[0]?.count ?? 0;
    return Number(rowCount) > 0;
  }

  private async enableMailSyncScheduler(mailSyncEveryMinutes: number): Promise<void> {
    if (this.mailSyncSchedulerRegistered === true) {
      return;
    }

    await this.mailSyncQueue.upsertJobScheduler('mail-sync-recurring', {
      every: mailSyncEveryMinutes * 60 * 1000
    }, {
      name: 'poll-gmail-inbox',
      data: {
        triggeredBy: 'scheduler'
      }
    });

    this.mailSyncSchedulerRegistered = true;
    this.logger.log(`Recurring mail sync job registered (every ${mailSyncEveryMinutes} minutes)`);
  }

  private async disableMailSyncScheduler(): Promise<void> {
    if (this.mailSyncSchedulerRegistered === false) {
      return;
    }

    try {
      await this.mailSyncQueue.removeJobScheduler('mail-sync-recurring');
    } catch (error) {
      if (!this.isMissingSchedulerError(error)) {
        throw error;
      }
    }

    this.mailSyncSchedulerRegistered = false;
    this.logger.log('Recurring mail sync job disabled (no active mailbox connections)');
  }

  private isMissingSchedulerError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('does not exist') || message.includes('not found');
  }
}
