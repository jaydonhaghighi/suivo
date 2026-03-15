import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';

@Injectable()
export class VoiceDispatchJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VoiceDispatchJob.name);
  private worker?: Worker;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.worker = new Worker(
      'voice-dispatch',
      async () => this.triggerApiVoiceDispatch(),
      {
        connection: {
          url: this.configService.getOrThrow<string>('REDIS_URL')
        }
      }
    );

    this.worker.on('failed', (_, error) => {
      this.logger.error(`voice-dispatch failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }

  private async triggerApiVoiceDispatch(): Promise<Record<string, unknown>> {
    const internalToken = this.configService.get<string>('INTERNAL_API_TOKEN');
    if (!internalToken) {
      return {
        status: 'skipped',
        reason: 'INTERNAL_API_TOKEN is missing'
      };
    }

    const apiBaseUrl = this.configService.get<string>('API_BASE_URL', 'http://localhost:3001').replace(/\/+$/, '');
    const endpoint = `${apiBaseUrl}/v1/internal/voice/dispatch-trigger`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-internal-token': internalToken,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ limit: 50, include_auto: true })
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`voice dispatch endpoint failed (${response.status}): ${body}`);
    }

    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { status: 'ok', result: parsed };
    } catch {
      return {
        status: 'ok',
        raw_response: body
      };
    }
  }
}
