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

  it('accepts a real secret in production (S3 settings present)', () => {
    const result = ApiEnvSchema.safeParse({
      ...base,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: REAL_SECRET,
    });
    expect(result.success).toBe(true);
  });
});

describe('ApiEnvSchema storage and uploads', () => {
  const minimal = {
    DATABASE_URL: base.DATABASE_URL,
    REDIS_URL: base.REDIS_URL,
    JWT_ACCESS_SECRET: REAL_SECRET,
  };

  it('defaults to the fs driver, a fixed root and 100 MB uploads; S3 is optional', () => {
    const env = ApiEnvSchema.parse(minimal);
    expect(env.STORAGE_DRIVER).toBe('fs');
    expect(env.STORAGE_FS_ROOT).toBe('/var/lib/ftth/storage');
    expect(env.MAX_UPLOAD_MB).toBe(100);
    expect(env.S3_ENDPOINT).toBeUndefined();
  });

  it('requires an absolute STORAGE_FS_ROOT', () => {
    expect(ApiEnvSchema.safeParse({ ...minimal, STORAGE_FS_ROOT: 'data' }).success).toBe(false);
  });

  it('coerces MAX_UPLOAD_MB and rejects nonsense', () => {
    expect(ApiEnvSchema.parse({ ...minimal, MAX_UPLOAD_MB: '250' }).MAX_UPLOAD_MB).toBe(250);
    expect(ApiEnvSchema.safeParse({ ...minimal, MAX_UPLOAD_MB: '0' }).success).toBe(false);
  });

  it('requires every S3 setting when STORAGE_DRIVER=s3', () => {
    const missing = ApiEnvSchema.safeParse({ ...minimal, STORAGE_DRIVER: 's3' });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      const paths = missing.error.issues.map((issue) => issue.path.join('.')).sort();
      expect(paths).toEqual(['S3_ACCESS_KEY', 'S3_BUCKET', 'S3_ENDPOINT', 'S3_SECRET_KEY']);
    }
    expect(ApiEnvSchema.safeParse({ ...base, ...minimal, STORAGE_DRIVER: 's3' }).success).toBe(
      true,
    );
  });
});

describe('ApiEnvSchema tile URL settings (security review L1)', () => {
  const prod = { ...base, NODE_ENV: 'production', JWT_ACCESS_SECRET: REAL_SECRET } as const;

  it('rejects a change-me tile secret in production', () => {
    const result = ApiEnvSchema.safeParse({
      ...prod,
      TILE_URL_SECRET: 'dev-only-tile-secret-change-me-dev-only-tile-secret',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a real tile secret in production', () => {
    const result = ApiEnvSchema.safeParse({ ...prod, TILE_URL_SECRET: REAL_SECRET });
    expect(result.success).toBe(true);
  });

  it('treats empty tile settings as unset (as left in ftth.env.example)', () => {
    const result = ApiEnvSchema.safeParse({ ...prod, TILE_URL_SECRET: '', TILES_PUBLIC_URL: '' });
    expect(result.success).toBe(true);
    expect(result.data?.TILE_URL_SECRET).toBeUndefined();
    expect(result.data?.TILES_PUBLIC_URL).toBeUndefined();
  });
});
