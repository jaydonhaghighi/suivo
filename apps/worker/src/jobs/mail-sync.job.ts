import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';

@Injectable()
export class MailSyncJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailSyncJob.name);
  private worker?: Worker;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.worker = new Worker(
      'mail-sync',
      async (job) => {
        this.logger.log(`Processing mail sync job: ${job.name} ${JSON.stringify(job.data)}`);

        if (job.name === 'poll-gmail-inbox') {
          return this.triggerApiMailSync();
        }

        if (job.name === 'mailbox-backfill') {
          return {
            mailbox_id: job.data.mailboxId,
            status: 'queued_for_provider_sync',
            note: 'Provider sync connector should fetch historical data and enqueue webhook-like events.'
          };
        }

        return { status: 'ignored' };
      },
      {
        connection: {
          url: this.configService.getOrThrow<string>('REDIS_URL')
        }
      }
    );

    this.worker.on('failed', (_, error) => {
      this.logger.error(`mail-sync failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }

  private async triggerApiMailSync(): Promise<Record<string, unknown>> {
    const internalToken = this.configService.get<string>('INTERNAL_API_TOKEN');
    if (!internalToken) {
      return {
        status: 'skipped',
        reason: 'INTERNAL_API_TOKEN is missing'
      };
    }

    const apiBaseUrl = this.configService.get<string>('API_BASE_URL', 'http://localhost:3001');
    const normalizedApiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
    const endpoint = `${normalizedApiBaseUrl}/v1/internal/mail-sync-trigger`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'x-internal-token': internalToken
        }
      });
    } catch (error) {
      const err = error as { message?: string; cause?: unknown };
      const causeMessage =
        typeof err.cause === 'object' && err.cause && 'message' in err.cause
          ? String((err.cause as { message?: unknown }).message ?? '')
          : '';
      throw new Error(
        `mail-sync trigger fetch failed for ${endpoint}: ${err.message ?? 'unknown error'}${causeMessage ? ` | cause=${causeMessage}` : ''}`
      );
    }

    const body = await this.safeReadBody(response);
    if (!response.ok) {
      throw new Error(`mail-sync trigger failed (${response.status}): ${body}`);
    }

    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return {
        status: 'ok',
        raw_response: body
      };
    }
  }

  private async safeReadBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }
}
