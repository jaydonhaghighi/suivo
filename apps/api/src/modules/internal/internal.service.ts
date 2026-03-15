import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { UserContext } from '../../common/auth/user-context';
import { DatabaseService } from '../../common/db/database.service';
import { MailboxesService, PullGmailInboxResult, PullOutlookInboxResult } from '../mailboxes/mailboxes.service';
import { VoiceService } from '../voice/voice.service';

interface MailboxBackfillTargetRow {
  mailbox_id: string;
  provider: 'gmail' | 'outlook';
  status: string;
  user_id: string;
  team_id: string;
  role: 'AGENT' | 'TEAM_LEAD';
}

type MailboxBackfillSkipReason = 'mailbox_not_found' | 'mailbox_inactive';

interface MailboxBackfillSkippedResult {
  status: 'skipped';
  mailbox_connection_id: string;
  reason: MailboxBackfillSkipReason;
  provider?: 'gmail' | 'outlook' | undefined;
}

type MailboxBackfillPullResult = PullGmailInboxResult | PullOutlookInboxResult;

type MailboxBackfillCompletedResult = MailboxBackfillPullResult & {
  status: 'completed';
  provider: 'gmail' | 'outlook';
};

export type MailboxBackfillResult = MailboxBackfillSkippedResult | MailboxBackfillCompletedResult;

@Injectable()
export class InternalService implements OnModuleDestroy {
  private readonly staleQueue: Queue;

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly mailboxesService: MailboxesService,
    private readonly voiceService: VoiceService
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

  async triggerVoiceDispatch(options?: {
    limit?: number | undefined;
    include_auto?: boolean | undefined;
  }): Promise<{
    processed: number;
    dialed: number;
    rescheduled: number;
    failed: number;
    completed: number;
    auto_created: number;
  }> {
    return this.voiceService.dispatchDueSessions({
      limit: options?.limit ?? 50,
      include_auto: options?.include_auto ?? true
    });
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
    lead_created_count: number;
    needs_review_count: number;
    rejected_count: number;
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

  async triggerMailboxBackfill(options: {
    mailbox_id: string;
    newer_than_hours?: number | undefined;
    max_results?: number | undefined;
    await_classification?: boolean | undefined;
    preview_limit?: number | undefined;
  }): Promise<MailboxBackfillResult> {
    const newerThanHours = this.getBoundedInt(
      'MAIL_BACKFILL_NEWER_THAN_HOURS',
      24 * 365,
      1,
      24 * 365,
      options.newer_than_hours
    );
    const maxResults = this.getBoundedInt(
      'MAIL_BACKFILL_MAX_RESULTS',
      5000,
      1,
      5000,
      options.max_results
    );
    const previewLimit = this.getBoundedInt(
      'MAIL_BACKFILL_PREVIEW_LIMIT',
      10,
      1,
      50,
      options.preview_limit
    );
    const awaitClassification = this.getBoolean(
      'MAIL_BACKFILL_AWAIT_CLASSIFICATION',
      false,
      options.await_classification
    );

    const mailbox = await this.databaseService.withSystemTransaction<MailboxBackfillTargetRow | null>(
      async (client) => {
        const result = await client.query<MailboxBackfillTargetRow>(
          `SELECT
              m.id AS mailbox_id,
              m.provider,
              m.status,
              u.id AS user_id,
              u.team_id,
              u.role
           FROM "MailboxConnection" m
           JOIN "User" u ON u.id = m.user_id
           WHERE m.id = $1
           LIMIT 1`,
          [options.mailbox_id]
        );
        return result.rows[0] ?? null;
      }
    );

    if (!mailbox) {
      return {
        status: 'skipped',
        mailbox_connection_id: options.mailbox_id,
        reason: 'mailbox_not_found'
      };
    }

    if (mailbox.status !== 'active') {
      return {
        status: 'skipped',
        mailbox_connection_id: mailbox.mailbox_id,
        provider: mailbox.provider,
        reason: 'mailbox_inactive'
      };
    }

    const role = mailbox.role === 'TEAM_LEAD' ? 'TEAM_LEAD' : 'AGENT';
    const userContext: UserContext = {
      userId: mailbox.user_id,
      teamId: mailbox.team_id,
      role
    };
    const pullOptions = {
      newer_than_hours: newerThanHours,
      max_results: maxResults,
      await_classification: awaitClassification,
      preview_limit: previewLimit,
      ingest_source: 'backfill' as const
    };
    const result =
      mailbox.provider === 'gmail'
        ? await this.mailboxesService.pullGmailInbox(userContext, mailbox.mailbox_id, pullOptions)
        : await this.mailboxesService.pullOutlookInbox(userContext, mailbox.mailbox_id, pullOptions);

    return {
      ...result,
      status: 'completed',
      provider: mailbox.provider
    };
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

  private getBoolean(key: string, fallback: boolean, override?: boolean | undefined): boolean {
    if (override !== undefined) {
      return override;
    }

    const raw = this.configService.get<string>(key);
    if (!raw) {
      return fallback;
    }

    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }

    return fallback;
  }

  async onModuleDestroy(): Promise<void> {
    await this.staleQueue.close();
  }
}
