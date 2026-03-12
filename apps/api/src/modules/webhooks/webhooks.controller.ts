import { Body, Controller, ForbiddenException, Headers, Post } from '@nestjs/common';
import { z } from 'zod';

import { Public } from '../../common/auth/public.decorator';
import { WebhooksService } from './webhooks.service';

const emailWebhookSchema = z.object({
  provider_event_id: z.string().min(1),
  mailbox_connection_id: z.string().uuid().optional(),
  mailbox_email: z.string().email().optional(),
  from_email: z.string().email(),
  direction: z.enum(['inbound', 'outbound']),
  subject: z.string().optional(),
  body: z.string().optional(),
  thread_id: z.string().optional(),
  timestamp: z.string().datetime().optional()
});

const smsWebhookSchema = z.object({
  provider_event_id: z.string().min(1),
  phone_number_id: z.string().uuid().optional(),
  to_number: z.string().optional(),
  from_number: z.string().min(4),
  direction: z.enum(['inbound', 'outbound']),
  body: z.string().optional(),
  timestamp: z.string().datetime().optional()
});

const callWebhookSchema = z.object({
  provider_event_id: z.string().min(1),
  phone_number_id: z.string().uuid().optional(),
  to_number: z.string().optional(),
  from_number: z.string().min(4),
  direction: z.enum(['inbound', 'outbound']),
  status: z.string().min(1),
  duration_seconds: z.number().int().nonnegative().optional(),
  timestamp: z.string().datetime().optional()
});

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
