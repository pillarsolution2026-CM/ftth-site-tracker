import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { CAD_QUEUE_KEYS, CadImportJobSchema, type CadImportJob } from '@ftth/shared';
import type { JobQueue } from '../application/ports.js';

const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Producer for the CAD worker (ADR-013): the job JSON is pushed to the list `cad:jobs` with LPUSH;
 * the worker pops from the other end (FIFO). Delivery tracking is the worker's business.
 */
export class RedisJobQueue implements JobQueue {
  private readonly logger = new Logger(RedisJobQueue.name);
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true, // connect on first use; nothing happens until a CAD file is queued
      // Fail fast so an unavailable Redis surfaces as ENQUEUE_FAILED, not as a hanging upload.
      maxRetriesPerRequest: 1,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: COMMAND_TIMEOUT_MS,
    });
    this.redis.on('error', (error: Error) => this.logger.warn(`Redis: ${error.message}`));
  }

  async enqueueCadImport(job: CadImportJob): Promise<void> {
    // Never push a message the worker would reject.
    const message = JSON.stringify(CadImportJobSchema.parse(job));
    await this.redis.lpush(CAD_QUEUE_KEYS.jobs, message);
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
