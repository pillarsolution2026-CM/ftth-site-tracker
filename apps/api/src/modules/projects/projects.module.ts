import { Module, type Provider } from '@nestjs/common';
import { DB, type Database } from '../../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import {
  CreateProjectUseCase,
  CreateZoneUseCase,
  ListProjectsUseCase,
  ListZonesUseCase,
  UpdateProjectUseCase,
} from './application/admin-projects.use-cases.js';
import { GetProjectUseCase } from './application/get-project.use-case.js';
import type { ProjectAdminUnitOfWork } from './domain/project.js';
import {
  DrizzleProjectAdminUnitOfWork,
  DrizzleProjectRepository,
} from './infrastructure/drizzle-project.repository.js';
import { ProjectsController } from './interface/projects.controller.js';
import { GET_PROJECT_USE_CASE, PROJECT_ADMIN_UNIT_OF_WORK } from './projects.tokens.js';

/** Admin setup (ADR-025): used by the admin module's controllers. */
const adminProviders: Provider[] = [
  {
    provide: PROJECT_ADMIN_UNIT_OF_WORK,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleProjectAdminUnitOfWork(db),
  },
  {
    provide: ListProjectsUseCase,
    inject: [DB],
    useFactory: (db: Database) => new ListProjectsUseCase(new DrizzleProjectRepository(db)),
  },
  ...[CreateProjectUseCase, UpdateProjectUseCase, ListZonesUseCase, CreateZoneUseCase].map(
    (useCase): Provider => ({
      provide: useCase,
      inject: [PROJECT_ADMIN_UNIT_OF_WORK],
      useFactory: (uow: ProjectAdminUnitOfWork) => new useCase(uow),
    }),
  ),
];

@Module({
  imports: [IdentityModule],
  controllers: [ProjectsController],
  // Other modules (work-orders) read the project's currency through this application service.
  exports: [
    GET_PROJECT_USE_CASE,
    ListProjectsUseCase,
    CreateProjectUseCase,
    UpdateProjectUseCase,
    ListZonesUseCase,
    CreateZoneUseCase,
  ],
  providers: [
    ...adminProviders,
    {
      provide: GET_PROJECT_USE_CASE,
      inject: [DB],
      useFactory: (db: Database) => new GetProjectUseCase(new DrizzleProjectRepository(db)),
    },
  ],
})
export class ProjectsModule {}
