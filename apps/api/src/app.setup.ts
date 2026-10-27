import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { ApiEnv } from '@ftth/shared';

/** HTTP-level setup shared by main.ts and the integration tests. */
export function configureApp(app: INestApplication, env: ApiEnv): void {
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: false });
  // API docs are a development aid only.
  if (env.NODE_ENV === 'production') return;
  const config = new DocumentBuilder()
    .setTitle('FTTH Site Tracker API')
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}
