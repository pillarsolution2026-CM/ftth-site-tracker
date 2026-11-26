import { Controller, Get, Inject, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  UpdateListQuerySchema,
  UpdateListResponseSchema,
  type UpdateListQuery,
  type UpdateListResponse,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import { sendRangedObject } from '../../../common/http/download.js';
import { ProjectIdParam } from '../../../common/http/params.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { scopeForPermission } from '../../identity/domain/membership.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import type { ExecutionScope } from '../application/ports.js';
import { GetUpdatePhotoUseCase, ListUpdatesUseCase } from '../application/update-list.use-cases.js';
import { SyncRateLimit, SyncRateLimitGuard } from './sync-rate-limit.guard.js';

/** The caller's reach for `execution:read` (a supervisor: his sites only, ADR-054). */
function readScope(request: AuthenticatedRequest): ExecutionScope {
  const access = request.projectAccess;
  if (!access) throw new AppError('FORBIDDEN', 'No access to this project');
  const scope = scopeForPermission(access, 'execution:read', request.auth?.isAdmin === true);
  if (!scope) throw new AppError('FORBIDDEN', 'Your role does not allow this action');
  return scope.kind === 'project' ? { kind: 'project' } : { kind: 'sites', siteIds: scope.siteIds };
}

/** UUIDs are compared as text in SQL results: one canonical case. */
const canonical = (uuid: string): string => uuid.toLowerCase();

/** ADR-059: read-only web list of the updates recorded on the phones, and their photos. */
@ApiTags('execution-updates')
@ApiBearerAuth()
@Controller('projects/:projectId/execution-updates')
@UseGuards(JwtAuthGuard, SyncRateLimitGuard, ProjectScopeGuard, PermissionGuard)
export class ExecutionUpdatesController {
  constructor(
    @Inject(ListUpdatesUseCase) private readonly listUpdates: ListUpdatesUseCase,
    @Inject(GetUpdatePhotoUseCase) private readonly photo: GetUpdatePhotoUseCase,
  ) {}

  @Get()
  @SyncRateLimit('sync')
  @RequirePermission('execution:read')
  @ApiOkResponse({ schema: openApiSchema(UpdateListResponseSchema) })
  list(
    @ProjectIdParam() projectId: string,
    @Query(new ZodValidationPipe(UpdateListQuerySchema)) query: UpdateListQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<UpdateListResponse> {
    return this.listUpdates.execute({
      projectId: canonical(projectId),
      scope: readScope(request),
      query: { ...query, ...(query.siteId ? { siteId: canonical(query.siteId) } : {}) },
    });
  }

  @Get('photos/:photoId')
  @SyncRateLimit('upload')
  @RequirePermission('execution:read')
  async getPhoto(
    @ProjectIdParam() projectId: string,
    @Param('photoId', UuidParamPipe) photoId: string,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const { stream, sizeBytes } = await this.photo.execute({
      projectId: canonical(projectId),
      scope: readScope(request),
      photoId: canonical(photoId),
    });
    response.setHeader('Cache-Control', 'private, no-store');
    sendRangedObject(response, { kind: 'stream', stream, sizeBytes, range: null }, 'image/jpeg');
  }
}
