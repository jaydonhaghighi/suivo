import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { Public } from '../../common/auth/public.decorator';
import { InternalService, MailboxBackfillResult } from './internal.service';
import { mailboxBackfillTriggerSchema, mailSyncTriggerSchema } from './internal.schemas';
import { InternalTokenGuard } from './internal-token.guard';
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
