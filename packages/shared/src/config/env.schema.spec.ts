import { describe, expect, it } from 'vitest';
import { ApiEnvSchema, DEV_DEFAULT_JWT_ACCESS_SECRET } from './env.schema.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'ftth',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
};
const REAL_SECRET = 'q8Zr3vLw0xT5nBdYc7HkP2mGfUa9JeSo4iXyV1';

describe('ApiEnvSchema JWT secret policy', () => {
  it('allows the dev default outside production', () => {
    const result = ApiEnvSchema.safeParse({
      ...base,
      NODE_ENV: 'development',
      JWT_ACCESS_SECRET: DEV_DEFAULT_JWT_ACCESS_SECRET,
    });
    expect(result.success).toBe(true);
  });

  it('rejects the dev default in production', () => {
    const result = ApiEnvSchema.safeParse({
      ...base,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: DEV_DEFAULT_JWT_ACCESS_SECRET,
    });
    expect(result.success).toBe(false);
  });

  it('rejects any secret containing change-me in production', () => {
    const result = ApiEnvSchema.safeParse({
      ...base,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: `${REAL_SECRET}-change-me`,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a real secret in production', () => {
    const result = ApiEnvSchema.safeParse({
      ...base,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: REAL_SECRET,
    });
    expect(result.success).toBe(true);
  });
});
