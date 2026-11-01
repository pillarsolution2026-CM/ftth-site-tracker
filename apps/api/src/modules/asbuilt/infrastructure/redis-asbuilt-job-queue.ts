import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { CAD_QUEUE_KEYS, CadExportAsBuiltJobSchema } from '@ftth/shared';
import type { AsBuiltJobQueue } from '../application/ports.js';

const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Producer for the CAD worker (ADR-013), same list and protocol as the CAD module's queue:
 * the job JSON is validated with the shared schema, then LPUSHed to `cad:jobs`.
 */
export class RedisAsBuiltJobQueue implements AsBuiltJobQueue {
  private readonly logger = new Logger(RedisAsBuiltJobQueue.name);
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: COMMAND_TIMEOUT_MS,
    });
    this.redis.on('error', (error: Error) => this.logger.warn(`Redis: ${error.message}`));
  }

  async enqueueExport(job: {
    id: string;
    exportId: string;
    projectId: string;
    attempt: number;
    enqueuedAt: string;
  }): Promise<void> {
    // Never push a message the worker would reject.
    const message = JSON.stringify(
      CadExportAsBuiltJobSchema.parse({ ...job, type: 'cad.export_asbuilt' }),
    );
    await this.redis.lpush(CAD_QUEUE_KEYS.jobs, message);
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
