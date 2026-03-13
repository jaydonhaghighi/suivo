import { Body, Controller, Post } from '@nestjs/common';

import { CurrentUser } from '../../common/auth/current-user.decorator';
import { UserContext } from '../../common/auth/user-context';
import { emailReplySchema, smsSendSchema } from './messages.schemas';
import { MessagesService } from './messages.service';

@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post('email/reply')
  async replyEmail(
    @CurrentUser() user: UserContext,
    @Body() body: unknown
  ): Promise<{ sent: boolean; provider_event_id: string }> {
    const payload = emailReplySchema.parse(body);
    return this.messagesService.replyEmail(user, payload);
  }

  @Post('sms/send')
  async sendSms(
    @CurrentUser() user: UserContext,
    @Body() body: unknown
  ): Promise<{ sent: boolean; provider_event_id: string }> {
    const payload = smsSendSchema.parse(body);
    return this.messagesService.sendSms(user, payload);
  }
}
