import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { APP_ENV, loadEnv } from '../../src/config/config.module.js';
import { schema } from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';

export interface TestContext {
  app: INestApplication;
  pool: pg.Pool;
  /** Directory behind the `fs` storage adapter of this app instance. */
  storageRoot: string;
  close(): Promise<void>;
}

export interface ProviderOverride {
  token: string;
  value: unknown;
}

/** Boots the real application against the given PostGIS database and applies the dev seed. */
export async function createTestContext(
  databaseUrl: string,
  overrides: NodeJS.ProcessEnv = {},
  providerOverrides: ProviderOverride[] = [],
): Promise<TestContext> {
  const storageRoot = await mkdtemp(join(tmpdir(), 'ftth-int-storage-'));
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: 'redis://localhost:6379',
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_ROOT: storageRoot,
    JWT_ACCESS_SECRET: 'integration-test-secret-integration-test-secret',
    CORS_ORIGINS: 'http://localhost:3000',
    // Generous by default so suites that log in repeatedly never trip the limiter.
    AUTH_LOGIN_RATE_LIMIT: '10000',
    AUTH_REFRESH_RATE_LIMIT: '10000',
    SYNC_RATE_LIMIT: '100000',
    SYNC_UPLOAD_RATE_LIMIT: '100000',
    ...overrides,
  });

  const pool = new pg.Pool({ connectionString: databaseUrl });
  await seed(drizzle(pool, { schema }));

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_ENV)
    .useValue(env);
  for (const { token, value } of providerOverrides) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, env);
  await app.init();

  return {
    app,
    pool,
    storageRoot,
    close: async () => {
      await app.close();
      await pool.end();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}
