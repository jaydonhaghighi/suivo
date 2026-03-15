import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, verify } from 'crypto';

interface TelnyxCreateCallArgs {
  to: string;
  from: string;
  connectionId?: string | null;
  clientState?: Record<string, unknown> | null;
}

interface TelnyxCreateCallResult {
  call_control_id: string | null;
  call_leg_id: string | null;
  payload: Record<string, unknown>;
}

interface TelnyxAiGatherArgs {
  callControlId: string;
  model: string;
  voice: string;
  prompt: string;
  initialMessage: string;
  maxDurationSeconds: number;
}

interface TelnyxTransferCallArgs {
  callControlId: string;
  sipAddress: string;
  customHeaders?: Record<string, string>;
}

interface TelnyxApiResponse {
  data?: Record<string, unknown>;
}

@Injectable()
export class TelnyxClient {
  private readonly logger = new Logger(TelnyxClient.name);
  private readonly apiBaseUrl: string;
  private readonly apiKey: string | null;

  constructor(private readonly configService: ConfigService) {
    this.apiBaseUrl = this.configService.get<string>('TELNYX_API_BASE_URL', 'https://api.telnyx.com/v2').replace(/\/+$/, '');
    this.apiKey = this.configService.get<string>('TELNYX_API_KEY') ?? null;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async createOutboundCall(args: TelnyxCreateCallArgs): Promise<TelnyxCreateCallResult> {
    const response = await this.request<TelnyxApiResponse>('/calls', {
      method: 'POST',
      body: {
        to: args.to,
        from: args.from,
        connection_id: args.connectionId ?? undefined,
        timeout_secs: 30,
        client_state: args.clientState ? Buffer.from(JSON.stringify(args.clientState)).toString('base64') : undefined
      }
    });

    const data = response.data ?? {};
    return {
      call_control_id: this.pickString(data, ['call_control_id', 'call_session_id']),
      call_leg_id: this.pickString(data, ['call_leg_id']),
      payload: data
    };
  }

  async startAiGather(args: TelnyxAiGatherArgs): Promise<Record<string, unknown>> {
    const response = await this.request<TelnyxApiResponse>(`/calls/${encodeURIComponent(args.callControlId)}/actions/gather_using_ai`, {
      method: 'POST',
      body: {
        greeting: args.initialMessage,
        voice: args.voice,
        model: args.model,
        language: 'en-US',
        max_duration_secs: args.maxDurationSeconds,
        prompt: args.prompt,
        parameters: {
          response_format: 'json'
        }
      }
    });

    return response.data ?? {};
  }

  async referCallToSip(args: TelnyxTransferCallArgs): Promise<Record<string, unknown>> {
    const customHeaders = args.customHeaders && Object.keys(args.customHeaders).length
      ? Object.entries(args.customHeaders).map(([name, value]) => ({ name, value }))
      : undefined;
    const transferTarget = this.normalizeSipTransferTarget(args.sipAddress);

    // NOTE:
    // For PSTN-originated legs, Telnyx transfer is the correct primitive to hand
    // the live call to a SIP destination. Using REFER can acknowledge the command
    // but fail to bridge media for standard mobile endpoints.
    const response = await this.request<TelnyxApiResponse>(`/calls/${encodeURIComponent(args.callControlId)}/actions/transfer`, {
      method: 'POST',
      body: {
        to: transferTarget.to,
        sip_transport_protocol: transferTarget.transport,
        custom_headers: customHeaders
      }
    });

    return response.data ?? {};
  }

  private normalizeSipTransferTarget(sipAddress: string): { to: string; transport?: 'TLS' | 'TCP' | 'UDP' } {
    const trimmed = sipAddress.trim();
    if (!trimmed) {
      return { to: trimmed };
    }

    const match = trimmed.match(/;transport=(tls|tcp|udp)$/i);
    if (!match) {
      if (/^sips:/i.test(trimmed)) {
        return { to: trimmed, transport: 'TLS' };
      }
      return { to: trimmed };
    }

    const base = trimmed.slice(0, match.index);
    const transport = match[1]?.toUpperCase() as 'TLS' | 'TCP' | 'UDP';
    return {
      to: base,
      transport
    };
  }

  verifyWebhookSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined): boolean {
    const publicKey = this.configService.get<string>('TELNYX_WEBHOOK_PUBLIC_KEY');
    if (!publicKey || !timestamp || !signature) {
      return false;
    }

    const normalizedSignature = signature.trim();
    if (!normalizedSignature) {
      return false;
    }

    const message = `${timestamp}|${rawBody}`;
    const signatureBuffer = this.decodeSignature(normalizedSignature);
    if (!signatureBuffer) {
      return false;
    }

    try {
      const key = this.parsePublicKey(publicKey);
      return verify(null, Buffer.from(message), key, signatureBuffer);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Failed to verify Telnyx webhook signature: ${messageText}`);
      return false;
    }
  }

  private async request<TResponse>(
    path: string,
    options: { method: 'POST' | 'GET'; body?: Record<string, unknown> | undefined }
  ): Promise<TResponse> {
    if (!this.apiKey) {
      throw new Error('TELNYX_API_KEY is not configured');
    }

    const requestInit: RequestInit = {
      method: options.method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json'
      }
    };

    if (options.body) {
      requestInit.body = JSON.stringify(options.body);
    }

    const response = await fetch(`${this.apiBaseUrl}${path}`, requestInit);

    const rawBody = await response.text();
    let parsedBody: unknown;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      parsedBody = { raw_body: rawBody };
    }

    if (!response.ok) {
      throw new Error(`Telnyx API request failed (${response.status}): ${JSON.stringify(parsedBody)}`);
    }

    return parsedBody as TResponse;
  }

  private pickString(object: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = object[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }

    return null;
  }

  private decodeSignature(signature: string): Buffer | null {
    try {
      if (/^[a-fA-F0-9]+$/.test(signature)) {
        return Buffer.from(signature, 'hex');
      }

      return Buffer.from(signature, 'base64');
    } catch {
      return null;
    }
  }

  private parsePublicKey(value: string): ReturnType<typeof createPublicKey> {
    const trimmed = value.trim();
    if (trimmed.startsWith('-----BEGIN')) {
      return createPublicKey(trimmed);
    }

    if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
      return createPublicKey({
        key: Buffer.concat([
          Buffer.from('302a300506032b6570032100', 'hex'),
          Buffer.from(trimmed, 'hex')
        ]),
        format: 'der',
        type: 'spki'
      });
    }

    if (/^[A-Za-z0-9+/=]+$/.test(trimmed)) {
      const raw = Buffer.from(trimmed, 'base64');
      if (raw.length === 32) {
        return createPublicKey({
          key: Buffer.concat([
            Buffer.from('302a300506032b6570032100', 'hex'),
            raw
          ]),
          format: 'der',
          type: 'spki'
        });
      }
    }

    return createPublicKey(trimmed);
  }
}
