import { Body, Controller, Get, Inject, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  ReplaceSupervisorSitesRequestSchema,
  SupervisorSitesResponseSchema,
  SupervisorWithSitesSchema,
  type ReplaceSupervisorSitesRequest,
  type SupervisorSitesResponse,
  type SupervisorWithSites,
} from '@ftth/shared';
import { ProjectIdParam } from '../../../common/http/params.js';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import {
  ListSupervisorSitesUseCase,
  ReplaceSupervisorSitesUseCase,
} from '../application/supervisor-sites.use-cases.js';
import type { AuthenticatedRequest } from './auth-request.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { ProjectScopeGuard } from './project-scope.guard.js';

/** Supervisors work by site (ADR-054): the admin and the project's PM give them their sites. */
@ApiTags('supervisor-sites')
@ApiBearerAuth()
@Controller('projects/:projectId')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class SupervisorSitesController {
  constructor(
    @Inject(ListSupervisorSitesUseCase) private readonly list: ListSupervisorSitesUseCase,
    @Inject(ReplaceSupervisorSitesUseCase) private readonly replace: ReplaceSupervisorSitesUseCase,
  ) {}

  @Get('supervisor-sites')
  @RequirePermission('supervisor_sites:manage')
  @ApiOkResponse({ schema: openApiSchema(SupervisorSitesResponseSchema) })
  listAll(@ProjectIdParam() projectId: string): Promise<SupervisorSitesResponse> {
    return this.list.execute(projectId);
  }

  @Put('supervisors/:userId/sites')
  @RequirePermission('supervisor_sites:manage')
  @ApiOkResponse({ schema: openApiSchema(SupervisorWithSitesSchema) })
  replaceSites(
    @ProjectIdParam() projectId: string,
    @Param('userId', UuidParamPipe) userId: string,
    @Body(new ZodValidationPipe(ReplaceSupervisorSitesRequestSchema))
    body: ReplaceSupervisorSitesRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<SupervisorWithSites> {
    return this.replace.execute(
      {
        projectId,
        userId: userId.toLowerCase(),
        siteIds: body.siteIds.map((id) => id.toLowerCase()),
      },
      actorIdOf(request),
    );
  }
}
