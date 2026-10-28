import { CAD_QUEUE_KEYS } from '@ftth/shared';
import { Redis } from 'ioredis';
import { GenericContainer } from 'testcontainers';

const REDIS_IMAGE = 'redis:7.4-alpine';

export interface TestRedis {
  url: string;
  stop(): Promise<void>;
}

/**
 * Redis for the job queue tests. Uses TEST_REDIS_URL when CI or a developer provides one (a
 * dedicated database number such as redis://localhost:6379/5 keeps a real worker's queue out of the
 * tests); otherwise starts a throw-away Testcontainers instance.
 */
export async function startRedis(): Promise<TestRedis> {
  const provided = process.env.TEST_REDIS_URL;
  if (provided) {
    // Start every spec file with an empty queue: they assert on what they pushed themselves.
    const redis = new Redis(provided);
    await redis.del(CAD_QUEUE_KEYS.jobs);
    redis.disconnect();
    return { url: provided, stop: async () => undefined };
  }

  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  const container = await new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start();
  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    stop: async () => {
      await container.stop();
    },
  };
}
