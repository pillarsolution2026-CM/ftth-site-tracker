import { z } from 'zod';

/** Default JWT secret shipped in infra/docker-compose.yml for local development only. */
export const DEV_DEFAULT_JWT_ACCESS_SECRET = 'dev-only-secret-change-me-dev-only-secret-change-me';

/** API process environment. Parsed once at startup; the process fails fast on invalid config. */
export const ApiEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    S3_ENDPOINT: z.url(),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    APP_VERSION: z.string().min(1).default('dev'),
    AUTH_LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(5),
    AUTH_REFRESH_RATE_LIMIT: z.coerce.number().int().positive().default(30),
    AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((value) => value.split(',').map((origin) => origin.trim())),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (
      env.JWT_ACCESS_SECRET.includes('change-me') ||
      env.JWT_ACCESS_SECRET === DEV_DEFAULT_JWT_ACCESS_SECRET
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_SECRET'],
        message: 'JWT_ACCESS_SECRET must be a real secret in production (dev placeholder rejected)',
      });
    }
  });
export type ApiEnv = z.infer<typeof ApiEnvSchema>;
