import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res
} from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';

import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Public } from '../../common/auth/public.decorator';
import { UserContext } from '../../common/auth/user-context';
import { MailboxEmailRecord, MailboxesService, PullGmailInboxResult } from './mailboxes.service';

const oauthStartSchema = z.object({
  app_redirect_uri: z.string().url().optional(),
  login_hint: z.string().email().optional()
});
const providerParamSchema = z.enum(['gmail', 'outlook']);

const oauthCallbackSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  email_address: z.string().email().optional(),
  mailbox_type: z.enum(['primary', 'shared', 'delegated']).optional(),
  delegated_from: z.string().email().optional()
});

const booleanFromQuery = z
  .union([z.boolean(), z.literal('true'), z.literal('false')])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true'));

const gmailPullInboxSchema = z.object({
  newer_than_hours: z.coerce.number().int().min(1).max(24 * 365).default(24),
  max_results: z.coerce.number().int().min(1).max(5000).default(100),
  await_classification: booleanFromQuery.default(false),
  preview_limit: z.coerce.number().int().min(1).max(50).default(10)
});

const mailboxEmailsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  include_body: booleanFromQuery.default(false)
});

@Controller('mailboxes')
export class MailboxesController {
  constructor(private readonly mailboxesService: MailboxesService) {}

  private parseProvider(provider: string): 'gmail' | 'outlook' {
    const parsed = providerParamSchema.safeParse(provider);
    if (!parsed.success) {
      throw new BadRequestException('Invalid provider. Use gmail or outlook.');
    }
    return parsed.data;
  }

  @Get()
  async list(@CurrentUser() user: UserContext): Promise<Record<string, unknown>[]> {
    return this.mailboxesService.list(user);
  }

  @Post('oauth/:provider/start')
  async oauthStart(
    @CurrentUser() user: UserContext,
    @Param('provider') provider: string,
    @Body() body: unknown
  ): Promise<{ url: string; state: string }> {
    const payload = oauthStartSchema.parse(body ?? {});
    return this.mailboxesService.createOauthStartUrl(this.parseProvider(provider), user, payload);
  }

  @Public()
  @Get('oauth/:provider/callback')
  async oauthCallback(
    @Param('provider') provider: string,
    @Res() response: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('email_address') email_address?: string,
    @Query('mailbox_type') mailbox_type?: string,
    @Query('delegated_from') delegated_from?: string
  ): Promise<void> {
    const payload = oauthCallbackSchema.parse({
      code,
      state,
      email_address,
      mailbox_type,
      delegated_from
    });

    const result = await this.mailboxesService.oauthCallback(this.parseProvider(provider), payload);
    if (result.redirect_url) {
      response.redirect(302, result.redirect_url);
      return;
    }

    response.status(200).json({
      connected: result.connected,
      mailbox_connection_id: result.mailbox_connection_id
    });
  }

  @Post(':id/backfill')
  async backfill(@CurrentUser() user: UserContext, @Param('id') mailboxId: string): Promise<{ queued: true; mailbox_id: string }> {
    return this.mailboxesService.enqueueBackfill(user, mailboxId);
  }

  @Post(':id/gmail/test-last-hour')
  async testGmailLastHour(
    @CurrentUser() user: UserContext,
    @Param('id') mailboxId: string
  ): Promise<Record<string, unknown>> {
    return this.mailboxesService.testGmailLastHour(user, mailboxId);
  }

  @Get(':id/emails')
  async listMailboxEmails(
    @CurrentUser() user: UserContext,
    @Param('id') mailboxId: string,
    @Query() query: Record<string, unknown>
  ): Promise<{
    mailbox_connection_id: string;
    emails: MailboxEmailRecord[];
  }> {
    const payload = mailboxEmailsQuerySchema.parse(query ?? {});
    return this.mailboxesService.listMailboxEmails(user, mailboxId, payload);
  }

  @Post(':id/gmail/pull-inbox')
  async pullGmailInbox(
    @CurrentUser() user: UserContext,
    @Param('id') mailboxId: string,
    @Body() body: unknown
  ): Promise<PullGmailInboxResult> {
    const payload = gmailPullInboxSchema.parse(body ?? {});
    return this.mailboxesService.pullGmailInbox(user, mailboxId, payload);
  }
}
