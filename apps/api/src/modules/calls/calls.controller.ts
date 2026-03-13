import { Body, Controller, Param, Post } from '@nestjs/common';

import { CurrentUser } from '../../common/auth/current-user.decorator';
import { UserContext } from '../../common/auth/user-context';
import { callIntentSchema } from './calls.schemas';
import { CallsService } from './calls.service';

@Controller('calls')
export class CallsController {
  constructor(private readonly callsService: CallsService) {}

  @Post('intent')
  async intent(
    @CurrentUser() user: UserContext,
    @Body() body: unknown
  ): Promise<{ event_id: string; dialer_uri: string }> {
    const payload = callIntentSchema.parse(body);
    return this.callsService.logIntent(user, payload);
  }

  @Post(':eventId/outcome')
  async outcome(
    @CurrentUser() user: UserContext,
    @Param('eventId') eventId: string,
    @Body() body: unknown
  ): Promise<{ event_id: string; outcome: string; updated: true }> {
    return this.callsService.submitOutcome(user, eventId, body);
  }
}
