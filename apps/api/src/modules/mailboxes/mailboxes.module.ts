import { Module } from '@nestjs/common';

import { WebhooksModule } from '../webhooks/webhooks.module';
import { MailboxesController } from './mailboxes.controller';
import { MailboxesService } from './mailboxes.service';
import { GmailProviderClient } from './providers/gmail.provider';
import { OutlookProviderClient } from './providers/outlook.provider';

@Module({
  imports: [WebhooksModule],
  controllers: [MailboxesController],
  providers: [MailboxesService, GmailProviderClient, OutlookProviderClient],
  exports: [MailboxesService]
})
export class MailboxesModule {}
