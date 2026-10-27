import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { loadEnv } from './config/config.module.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv(); // fail fast before anything else starts
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  configureApp(app, env);
  await app.listen(env.PORT, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
