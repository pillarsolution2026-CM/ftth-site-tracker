import { Global, Module } from '@nestjs/common';
import { ApiEnvSchema, type ApiEnv } from '@ftth/shared';

export const APP_ENV = 'APP_ENV';

/** Parses the process environment once; throws (process exits) on invalid config. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const result = ApiEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

@Global()
@Module({
  providers: [{ provide: APP_ENV, useFactory: () => loadEnv() }],
  exports: [APP_ENV],
})
export class ConfigModule {}
