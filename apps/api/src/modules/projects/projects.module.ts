import { Module } from '@nestjs/common';
import { DB, type Database } from '../../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { GetProjectUseCase } from './application/get-project.use-case.js';
import { DrizzleProjectRepository } from './infrastructure/drizzle-project.repository.js';
import { ProjectsController } from './interface/projects.controller.js';
import { GET_PROJECT_USE_CASE } from './projects.tokens.js';

@Module({
  imports: [IdentityModule],
  controllers: [ProjectsController],
  // Other modules (work-orders) read the project's currency through this application service.
  exports: [GET_PROJECT_USE_CASE],
  providers: [
    {
      provide: GET_PROJECT_USE_CASE,
      inject: [DB],
      useFactory: (db: Database) => new GetProjectUseCase(new DrizzleProjectRepository(db)),
    },
  ],
})
export class ProjectsModule {}
