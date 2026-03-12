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
          const mailboxId = this.extractMailboxId(job.data);
          return this.triggerApiMailboxBackfill(mailboxId);
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
    return this.postInternalEndpoint('/v1/internal/mail-sync-trigger');
  }

  private async triggerApiMailboxBackfill(mailboxId: string): Promise<Record<string, unknown>> {
    return this.postInternalEndpoint('/v1/internal/mailbox-backfill-trigger', {
      mailbox_id: mailboxId
    });
  }

  private extractMailboxId(payload: unknown): string {
    if (!payload || typeof payload !== 'object') {
      throw new Error('mailbox-backfill job payload is missing mailboxId');
    }

    const mailboxId = (payload as { mailboxId?: unknown }).mailboxId;
    if (typeof mailboxId !== 'string' || mailboxId.trim().length === 0) {
      throw new Error('mailbox-backfill job payload mailboxId must be a non-empty string');
    }

    return mailboxId;
  }

  private async postInternalEndpoint(
    path: string,
    payload?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const internalToken = this.configService.get<string>('INTERNAL_API_TOKEN');
    if (!internalToken) {
      return {
        status: 'skipped',
        reason: 'INTERNAL_API_TOKEN is missing'
      };
    }

    const apiBaseUrl = this.configService.get<string>('API_BASE_URL', 'http://localhost:3001');
    const normalizedApiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
    const endpoint = `${normalizedApiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      'x-internal-token': internalToken
    };
    let requestBody: string | undefined;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      requestBody = JSON.stringify(payload);
    }

    let response: Response;
    try {
      const requestInit: RequestInit = {
        method: 'POST',
        headers
      };
      if (requestBody !== undefined) {
        requestInit.body = requestBody;
      }
      response = await fetch(endpoint, requestInit);
    } catch (error) {
      const err = error as { message?: string; cause?: unknown };
      const causeMessage =
        typeof err.cause === 'object' && err.cause && 'message' in err.cause
          ? String((err.cause as { message?: unknown }).message ?? '')
          : '';
      throw new Error(
        `internal endpoint fetch failed for ${endpoint}: ${err.message ?? 'unknown error'}${causeMessage ? ` | cause=${causeMessage}` : ''}`
      );
    }

    const responseBody = await this.safeReadBody(response);
    if (!response.ok) {
      throw new Error(`internal endpoint call failed (${response.status}) for ${endpoint}: ${responseBody}`);
    }

    try {
      const parsed = JSON.parse(responseBody) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { status: 'ok', result: parsed };
    } catch {
      return {
        status: 'ok',
        raw_response: responseBody
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
