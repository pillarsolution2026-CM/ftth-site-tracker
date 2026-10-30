import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { AdminProjectsController } from './interface/admin-projects.controller.js';
import { AdminUsersController } from './interface/admin-users.controller.js';

/**
 * Admin setup (owner request, ADR-025). Interface only: it owns no tables and composes the
 * application services that identity (users, assignments) and projects (projects, zones) export.
 */
@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [AdminProjectsController, AdminUsersController],
})
export class AdminModule {}
