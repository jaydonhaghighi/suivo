import { Module } from '@nestjs/common';

import { MailboxesModule } from '../mailboxes/mailboxes.module';
import { InternalController } from './internal.controller';
import { InternalService } from './internal.service';
import { InternalTokenGuard } from './internal-token.guard';

@Module({
  imports: [MailboxesModule],
  controllers: [InternalController],
  providers: [InternalService, InternalTokenGuard]
})
export class InternalModule {}
