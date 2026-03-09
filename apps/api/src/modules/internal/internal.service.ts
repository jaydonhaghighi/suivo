import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { MailboxesService } from '../mailboxes/mailboxes.service';

@Injectable()
export class InternalService implements OnModuleDestroy {
  private readonly staleQueue: Queue;

  constructor(
    private readonly configService: ConfigService,
    private readonly mailboxesService: MailboxesService
  ) {
    this.staleQueue = new Queue('stale-detection', {
      connection: {
        url: this.configService.getOrThrow<string>('REDIS_URL')
      }
    });
  }

  async triggerStaleEvaluation(): Promise<{ queued: true }> {
    await this.staleQueue.add(
      'evaluate-stale',
      {
        triggeredAt: new Date().toISOString()
      },
      {
        removeOnComplete: 100,
        removeOnFail: 100
      }
    );

    return { queued: true };
  }

  async triggerMailSync(options?: {
    newer_than_hours?: number | undefined;
    max_results?: number | undefined;
    mailbox_limit?: number | undefined;
  }): Promise<{
    scanned_mailboxes: number;
    successful_mailboxes: number;
    failed_mailboxes: number;
    pulled: number;
    accepted: number;
    deduped: number;
    created_or_updated: number;
    lead_count: number;
  }> {
    const newerThanHours = this.getBoundedInt('MAIL_SYNC_NEWER_THAN_HOURS', 2, 1, 24 * 365, options?.newer_than_hours);
    const maxResultsPerBox = this.getBoundedInt('MAIL_SYNC_MAX_RESULTS_PER_BOX', 25, 1, 5000, options?.max_results);
    const mailboxLimit = this.getBoundedInt('MAIL_SYNC_MAILBOX_LIMIT', 50, 1, 500, options?.mailbox_limit);

    return this.mailboxesService.pullAllActiveGmailMailboxes({
      newer_than_hours: newerThanHours,
      max_results: maxResultsPerBox,
      mailbox_limit: mailboxLimit
    });
  }

  private getBoundedInt(
    key: string,
    fallback: number,
    min: number,
    max: number,
    override?: number | undefined
  ): number {
    if (override !== undefined) {
      return Math.max(min, Math.min(max, override));
    }

    const raw = this.configService.get<string>(key);
    const parsed = raw ? Number.parseInt(raw, 10) : fallback;
    if (Number.isNaN(parsed)) {
      return fallback;
    }

    return Math.max(min, Math.min(max, parsed));
  }

  async onModuleDestroy(): Promise<void> {
    await this.staleQueue.close();
  }
}
