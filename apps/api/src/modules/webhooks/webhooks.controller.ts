import { Body, Controller, ForbiddenException, Headers, Post } from '@nestjs/common';

import { Public } from '../../common/auth/public.decorator';
import { WebhooksService } from './webhooks.service';
import { callWebhookSchema, emailWebhookSchema, smsWebhookSchema } from './webhooks.schemas';

@Controller('webhooks')
@Public()
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('email/gmail')
  async gmailEmail(
    @Body() body: unknown,
    @Headers('x-webhook-signature') signature?: string
  ): Promise<{ accepted: boolean; deduped: boolean; lead_id?: string }> {
    if (!this.webhooksService.isValidSignature(body, signature)) {
      throw new ForbiddenException('Invalid webhook signature');
    }

    const payload = emailWebhookSchema.parse(body);
    return this.webhooksService.ingestEmail('gmail', payload);
  }

  @Post('email/outlook')
  async outlookEmail(
    @Body() body: unknown,
    @Headers('x-webhook-signature') signature?: string
  ): Promise<{ accepted: boolean; deduped: boolean; lead_id?: string }> {
    if (!this.webhooksService.isValidSignature(body, signature)) {
      throw new ForbiddenException('Invalid webhook signature');
    }

    const payload = emailWebhookSchema.parse(body);
    return this.webhooksService.ingestEmail('outlook', payload);
  }

  @Post('twilio/sms')
  async twilioSms(
    @Body() body: unknown,
    @Headers('x-webhook-signature') signature?: string,
    @Headers('x-twilio-signature') twilioSignature?: string
  ): Promise<{ accepted: boolean; deduped: boolean; lead_id?: string }> {
    const providedSignature = twilioSignature ?? signature;
    if (!this.webhooksService.isValidSignature(body, providedSignature)) {
      throw new ForbiddenException('Invalid webhook signature');
    }

    const payload = smsWebhookSchema.parse(body);
    return this.webhooksService.ingestSms(payload);
  }

  @Post('twilio/call')
  async twilioCall(
    @Body() body: unknown,
    @Headers('x-webhook-signature') signature?: string,
    @Headers('x-twilio-signature') twilioSignature?: string
  ): Promise<{ accepted: boolean; deduped: boolean; lead_id?: string }> {
    const providedSignature = twilioSignature ?? signature;
    if (!this.webhooksService.isValidSignature(body, providedSignature)) {
      throw new ForbiddenException('Invalid webhook signature');
    }

    const payload = callWebhookSchema.parse(body);
    return this.webhooksService.ingestCall(payload);
  }
}
