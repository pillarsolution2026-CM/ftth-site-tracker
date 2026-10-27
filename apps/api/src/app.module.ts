import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';

@Module({
  imports: [ConfigModule, DbModule, IdentityModule, ProjectsModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
