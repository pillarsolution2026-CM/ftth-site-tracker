import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { CadModule } from './modules/cad/cad.module.js';
import { ExecutionModule } from './modules/execution/execution.module.js';
import { WorkOrdersModule } from './modules/work-orders/work-orders.module.js';
import { StorageModule } from './common/storage/storage.module.js';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    StorageModule,
    AdminModule,
    IdentityModule,
    ProjectsModule,
    WorkOrdersModule,
    CadModule,
    ExecutionModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
