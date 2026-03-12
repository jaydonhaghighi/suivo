import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';

import { StaleEvaluatorService } from '../services/stale-evaluator.service';

@Injectable()
export class StaleDetectionJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaleDetectionJob.name);
  private worker?: Worker;

  constructor(
    private readonly configService: ConfigService,
    private readonly staleEvaluatorService: StaleEvaluatorService
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      'stale-detection',
      async () => this.staleEvaluatorService.evaluateAll(),
      {
        connection: {
          url: this.configService.getOrThrow<string>('REDIS_URL')
        }
      }
    );

    this.worker.on('completed', (_, result) => {
      this.logger.log(`stale-detection completed: ${JSON.stringify(result)}`);
    });

    this.worker.on('failed', (_, error) => {
      this.logger.error(`stale-detection failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
