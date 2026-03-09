import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Public } from '../../common/auth/public.decorator';
import { InternalService } from './internal.service';
import { InternalTokenGuard } from './internal-token.guard';

const mailSyncTriggerSchema = z.object({
  newer_than_hours: z.coerce.number().int().min(1).max(24 * 365).optional(),
  max_results: z.coerce.number().int().min(1).max(5000).optional(),
  mailbox_limit: z.coerce.number().int().min(1).max(500).optional()
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
  }> {
    const payload = mailSyncTriggerSchema.parse(body ?? {});
    return this.internalService.triggerMailSync(payload);
  }
}
