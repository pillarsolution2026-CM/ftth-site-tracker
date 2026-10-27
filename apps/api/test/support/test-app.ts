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
  close(): Promise<void>;
}

/** Boots the real application against the given PostGIS database and applies the dev seed. */
export async function createTestContext(
  databaseUrl: string,
  overrides: NodeJS.ProcessEnv = {},
): Promise<TestContext> {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'ftth',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test-secret',
    JWT_ACCESS_SECRET: 'integration-test-secret-integration-test-secret',
    CORS_ORIGINS: 'http://localhost:3000',
    // Generous by default so suites that log in repeatedly never trip the limiter.
    AUTH_LOGIN_RATE_LIMIT: '10000',
    AUTH_REFRESH_RATE_LIMIT: '10000',
    ...overrides,
  });

  const pool = new pg.Pool({ connectionString: databaseUrl });
  await seed(drizzle(pool, { schema }));

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_ENV)
    .useValue(env)
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, env);
  await app.init();

  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}
