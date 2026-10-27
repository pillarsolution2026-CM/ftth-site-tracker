import { describe, expect, it } from 'vitest';
import { loadEnv } from './config.module.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'ftth',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 'b',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv({ ...valid, CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(env.PORT).toBe(3001);
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('fails fast and names every problem', () => {
    expect(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: 'short', DATABASE_URL: '' })).toThrow(
      /JWT_ACCESS_SECRET[\s\S]*DATABASE_URL|DATABASE_URL[\s\S]*JWT_ACCESS_SECRET/,
    );
  });
});
