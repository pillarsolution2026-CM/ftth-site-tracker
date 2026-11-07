import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ProjectContractorsResponseSchema, type ProjectContractorsResponse } from '@ftth/shared';
import { ProjectIdParam } from '../../../common/http/params.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import { GetProjectContractorsUseCase } from '../application/contractor-queries.js';
import { toProjectContractorsDto } from './contractor.presenter.js';

/** The project's subcontractors, read-only; admin and pm only (`contractors:read`, ADR-036). */
@ApiTags('contractors')
@ApiBearerAuth()
@Controller('projects/:projectId/contractors')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class ProjectContractorsController {
  constructor(
    @Inject(GetProjectContractorsUseCase) private readonly get: GetProjectContractorsUseCase,
  ) {}

  @Get()
  @RequirePermission('contractors:read')
  @ApiOkResponse({ schema: openApiSchema(ProjectContractorsResponseSchema) })
  async getAll(@ProjectIdParam() projectId: string): Promise<ProjectContractorsResponse> {
    return toProjectContractorsDto(await this.get.execute(projectId));
  }
}
