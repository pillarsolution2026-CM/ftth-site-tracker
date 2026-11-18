import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AssignDrawingSiteRequestSchema,
  PublishReadinessSchema,
  SiteDrawingsResponseSchema,
  type AssignDrawingSiteRequest,
  type PublishReadiness,
  type SiteDrawingsResponse,
} from '@ftth/shared';
import { ProjectIdParam } from '../../../common/http/params.js';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import { GetSitePublishReadinessUseCase } from '../application/publish-design-revision.use-case.js';
import {
  AssignDrawingSiteUseCase,
  ListSiteDrawingsUseCase,
  WithdrawSiteDrawingUseCase,
} from '../application/site-drawings.use-cases.js';

/** ADR-049 part B: drawings per site of the work order. */
@ApiTags('site-drawings')
@ApiBearerAuth()
@Controller('projects/:projectId')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class SiteDrawingsController {
  constructor(
    @Inject(ListSiteDrawingsUseCase) private readonly list: ListSiteDrawingsUseCase,
    @Inject(AssignDrawingSiteUseCase) private readonly assign: AssignDrawingSiteUseCase,
    @Inject(WithdrawSiteDrawingUseCase) private readonly withdraw: WithdrawSiteDrawingUseCase,
    @Inject(GetSitePublishReadinessUseCase)
    private readonly readiness: GetSitePublishReadinessUseCase,
  ) {}

  @Get('site-drawings')
  @RequirePermission('cad_files:read')
  @ApiOkResponse({ schema: openApiSchema(SiteDrawingsResponseSchema) })
  listAll(@ProjectIdParam() projectId: string): Promise<SiteDrawingsResponse> {
    return this.list.execute(projectId);
  }

  @Post('site-drawings/:drawingId/assign-site')
  @HttpCode(204)
  @RequirePermission('design:write')
  async assignSite(
    @ProjectIdParam() projectId: string,
    @Param('drawingId', UuidParamPipe) drawingId: string,
    @Body(new ZodValidationPipe(AssignDrawingSiteRequestSchema)) body: AssignDrawingSiteRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.assign.execute({
      projectId,
      drawingId,
      actorId: actorIdOf(request),
      request: body,
    });
  }

  @Post('site-drawings/:drawingId/withdraw')
  @HttpCode(204)
  @RequirePermission('design:write')
  async withdrawDrawing(
    @ProjectIdParam() projectId: string,
    @Param('drawingId', UuidParamPipe) drawingId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.withdraw.execute({ projectId, drawingId, actorId: actorIdOf(request) });
  }

  /** The checklist of a site's publication, whichever draft is looked at. */
  @Get('sites/:siteId/publish-readiness')
  @RequirePermission('design:read')
  @ApiOkResponse({ schema: openApiSchema(PublishReadinessSchema) })
  publishReadiness(
    @ProjectIdParam() projectId: string,
    @Param('siteId', UuidParamPipe) siteId: string,
  ): Promise<PublishReadiness> {
    return this.readiness.execute(projectId, siteId);
  }
}
