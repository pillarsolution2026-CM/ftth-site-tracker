import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { openApiSchema } from '../../../common/openapi.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import type { GetProjectUseCase } from '../application/get-project.use-case.js';
import { GET_PROJECT_USE_CASE } from '../projects.tokens.js';
import { ProjectResponseSchema, type ProjectResponse } from './project.schema.js';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class ProjectsController {
  constructor(@Inject(GET_PROJECT_USE_CASE) private readonly getProject: GetProjectUseCase) {}

  @Get(':projectId')
  @ApiOkResponse({ schema: openApiSchema(ProjectResponseSchema) })
  @ApiResponse({ status: 403, description: 'FORBIDDEN: not a member of the project' })
  get(@Param('projectId') projectId: string): Promise<ProjectResponse> {
    return this.getProject.execute(projectId);
  }
}
