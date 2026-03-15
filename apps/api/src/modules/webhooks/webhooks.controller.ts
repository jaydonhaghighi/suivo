import { Body, Controller, ForbiddenException, Headers, Post, Req } from '@nestjs/common';
import { Request } from 'express';

import { Public } from '../../common/auth/public.decorator';
import { VoiceService } from '../voice/voice.service';
import { telnyxVoiceWebhookSchema } from '../voice/voice.schemas';
import { WebhooksService } from './webhooks.service';
import { callWebhookSchema, emailWebhookSchema, smsWebhookSchema } from './webhooks.schemas';

@Controller('webhooks')
@Public()
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly voiceService: VoiceService
  ) {}

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

  @Post('sms')
  async sms(
    @Body() body: unknown,
    @Headers('x-webhook-signature') signature?: string
  ): Promise<{ accepted: boolean; deduped: boolean; lead_id?: string }> {
    if (!this.webhooksService.isValidSignature(body, signature)) {
      throw new ForbiddenException('Invalid webhook signature');
    }

    const payload = smsWebhookSchema.parse(body);
    return this.webhooksService.ingestSms(payload);
  }

  @Post('call')
  async call(
    @Body() body: unknown,
    @Headers('x-webhook-signature') signature?: string
  ): Promise<{ accepted: boolean; deduped: boolean; lead_id?: string }> {
    if (!this.webhooksService.isValidSignature(body, signature)) {
      throw new ForbiddenException('Invalid webhook signature');
    }

    const payload = callWebhookSchema.parse(body);
    return this.webhooksService.ingestCall(payload);
  }

  @Post('telnyx/voice')
  async telnyxVoice(
    @Body() body: unknown,
    @Headers('telnyx-signature-ed25519') signature?: string,
    @Headers('telnyx-timestamp') timestamp?: string,
    @Req() request?: Request & { rawBody?: Buffer | string }
  ): Promise<{ accepted: boolean; ignored?: boolean; session_id?: string }> {
    const rawBodyBuffer = request?.rawBody;
    const rawBody = typeof rawBodyBuffer === 'string'
      ? rawBodyBuffer
      : rawBodyBuffer instanceof Buffer
        ? rawBodyBuffer.toString('utf8')
        : JSON.stringify(body ?? {});

    if (!this.voiceService.isTelnyxWebhookSignatureValid(rawBody, timestamp, signature)) {
      throw new ForbiddenException('Invalid Telnyx webhook signature');
    }

    const payload = telnyxVoiceWebhookSchema.parse(body ?? {});
    return this.voiceService.ingestTelnyxVoiceWebhook(payload);
  }

  @Post('openai/realtime')
  async openAiRealtime(
    @Body() body: unknown
  ): Promise<{ accepted: boolean; ignored?: boolean; call_id?: string }> {
    return this.voiceService.ingestOpenAiRealtimeWebhook(body);
  }
}
