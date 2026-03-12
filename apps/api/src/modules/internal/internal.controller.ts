import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Public } from '../../common/auth/public.decorator';
import { InternalService, MailboxBackfillResult } from './internal.service';
import { InternalTokenGuard } from './internal-token.guard';

const booleanFromBody = z
  .union([z.boolean(), z.literal('true'), z.literal('false')])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true'));

const mailSyncTriggerSchema = z.object({
  newer_than_hours: z.coerce.number().int().min(1).max(24 * 365).optional(),
  max_results: z.coerce.number().int().min(1).max(5000).optional(),
  mailbox_limit: z.coerce.number().int().min(1).max(500).optional()
});

const mailboxBackfillTriggerSchema = z.object({
  mailbox_id: z.string().uuid(),
  newer_than_hours: z.coerce.number().int().min(1).max(24 * 365).optional(),
  max_results: z.coerce.number().int().min(1).max(5000).optional(),
  await_classification: booleanFromBody.optional(),
  preview_limit: z.coerce.number().int().min(1).max(50).optional()
});

@Controller('internal')
export class InternalController {
  constructor(private readonly internalService: InternalService) {}

  @Public()
  @UseGuards(InternalTokenGuard)
  @Post('stale-trigger')
  async staleTrigger(): Promise<{ queued: true }> {
    return this.internalService.triggerStaleEvaluation();
  }

  @Public()
  @UseGuards(InternalTokenGuard)
  @Post('mail-sync-trigger')
  async mailSyncTrigger(@Body() body: unknown): Promise<{
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
    const payload = mailSyncTriggerSchema.parse(body ?? {});
    return this.internalService.triggerMailSync(payload);
  }

  @Public()
  @UseGuards(InternalTokenGuard)
  @Post('mailbox-backfill-trigger')
  async mailboxBackfillTrigger(@Body() body: unknown): Promise<MailboxBackfillResult> {
    const payload = mailboxBackfillTriggerSchema.parse(body ?? {});
    return this.internalService.triggerMailboxBackfill(payload);
  }
}
