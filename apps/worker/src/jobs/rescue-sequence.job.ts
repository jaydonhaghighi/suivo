import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';

@Injectable()
export class RescueSequenceJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RescueSequenceJob.name);
  private worker?: Worker;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.worker = new Worker(
      'rescue-sequence',
      async (job) => {
        this.logger.log(`Rescue-sequence job ${job.id} processed for lead ${job.data.leadId}`);
        return {
          status: 'task_only_automation',
          human_send_required: true
        };
      },
      {
        connection: {
          url: this.configService.getOrThrow<string>('REDIS_URL')
        }
      }
    );

    this.worker.on('failed', (_, error) => {
      this.logger.error(`rescue-sequence failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
