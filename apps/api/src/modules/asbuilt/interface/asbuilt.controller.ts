import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AsBuiltEditDetailSchema,
  AsBuiltEditListQuerySchema,
  AsBuiltEditListResponseSchema,
  AsBuiltEditSchema,
  AsBuiltExportListResponseSchema,
  AsBuiltExportSchema,
  AsBuiltLengthsResponseSchema,
  AsBuiltStateResponseSchema,
  RejectAsBuiltEditRequestSchema,
  type AsBuiltEdit,
  type AsBuiltEditDetail,
  type AsBuiltEditListQuery,
  type AsBuiltEditListResponse,
  type AsBuiltExport,
  type AsBuiltExportListResponse,
  type AsBuiltLengthsResponse,
  type AsBuiltStateResponse,
  type Permission,
  type RejectAsBuiltEditRequest,
} from '@ftth/shared';
import { z } from 'zod';
import { AppError } from '../../../common/app-error.js';
import { ProjectIdParam } from '../../../common/http/params.js';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { scopeForPermission } from '../../identity/domain/membership.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { AsBuiltRateLimitGuard } from './asbuilt-rate-limit.guard.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import {
  DownloadAsBuiltExportUseCase,
  GetAsBuiltExportUseCase,
  ListAsBuiltExportsUseCase,
  RequestAsBuiltExportUseCase,
} from '../application/export.use-cases.js';
import type { AsBuiltScope } from '../application/ports.js';
import {
  GetAsBuiltEditUseCase,
  GetAsBuiltLengthsUseCase,
  GetAsBuiltStateUseCase,
  ListAsBuiltEditsUseCase,
} from '../application/query.use-cases.js';
import {
  ApproveAsBuiltEditUseCase,
  RejectAsBuiltEditUseCase,
} from '../application/review.use-cases.js';

/** The caller's reach for `permission` (per assignment: a read-only role never widens a review). */
function scopeOf(request: AuthenticatedRequest, permission: Permission): AsBuiltScope {
  const access = request.projectAccess;
  if (!access) throw new AppError('FORBIDDEN', 'No access to this project');
  const scope = scopeForPermission(access, permission, request.auth?.isAdmin === true);
  if (!scope) throw new AppError('FORBIDDEN', 'Your role does not allow this action');
  return scope.kind === 'project' ? { kind: 'project' } : { kind: 'zones', zoneIds: scope.zoneIds };
}

/** UUIDs are compared as text in SQL results and keys: one canonical case. */
const canonical = (uuid: string): string => uuid.toLowerCase();

const EmptyBodySchema = z.object({}).strict().optional();

/** Web review of As-Built edits and the As-Built DXF export (ADR-030, phase-4 contracts). */
@ApiTags('asbuilt')
@ApiBearerAuth()
@Controller('projects/:projectId/asbuilt')
@UseGuards(JwtAuthGuard, AsBuiltRateLimitGuard, ProjectScopeGuard, PermissionGuard)
export class AsBuiltController {
  constructor(
    @Inject(ListAsBuiltEditsUseCase) private readonly listEdits: ListAsBuiltEditsUseCase,
    @Inject(GetAsBuiltEditUseCase) private readonly getEdit: GetAsBuiltEditUseCase,
    @Inject(ApproveAsBuiltEditUseCase) private readonly approve: ApproveAsBuiltEditUseCase,
    @Inject(RejectAsBuiltEditUseCase) private readonly reject: RejectAsBuiltEditUseCase,
    @Inject(GetAsBuiltStateUseCase) private readonly getState: GetAsBuiltStateUseCase,
    @Inject(GetAsBuiltLengthsUseCase) private readonly getLengths: GetAsBuiltLengthsUseCase,
    @Inject(RequestAsBuiltExportUseCase)
    private readonly requestExport: RequestAsBuiltExportUseCase,
    @Inject(ListAsBuiltExportsUseCase) private readonly listExports: ListAsBuiltExportsUseCase,
    @Inject(GetAsBuiltExportUseCase) private readonly getExport: GetAsBuiltExportUseCase,
    @Inject(DownloadAsBuiltExportUseCase) private readonly download: DownloadAsBuiltExportUseCase,
  ) {}

  @Get('edits')
  @RequirePermission('asbuilt:read')
  @ApiOkResponse({ schema: openApiSchema(AsBuiltEditListResponseSchema) })
  list(
    @ProjectIdParam() projectId: string,
    @Query(new ZodValidationPipe(AsBuiltEditListQuerySchema)) query: AsBuiltEditListQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<AsBuiltEditListResponse> {
    return this.listEdits.execute({
      projectId: canonical(projectId),
      scope: scopeOf(request, 'asbuilt:read'),
      query,
    });
  }

  @Get('edits/:editId')
  @RequirePermission('asbuilt:read')
  @ApiOkResponse({ schema: openApiSchema(AsBuiltEditDetailSchema) })
  detail(
    @ProjectIdParam() projectId: string,
    @Param('editId', UuidParamPipe) editId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<AsBuiltEditDetail> {
    return this.getEdit.execute({
      projectId: canonical(projectId),
      scope: scopeOf(request, 'asbuilt:read'),
      editId: canonical(editId),
    });
  }

  @Post('edits/:editId/approve')
  @HttpCode(200)
  @RequirePermission('asbuilt:review')
  @ApiOkResponse({ schema: openApiSchema(AsBuiltEditSchema) })
  approveEdit(
    @ProjectIdParam() projectId: string,
    @Param('editId', UuidParamPipe) editId: string,
    @Body(new ZodValidationPipe(EmptyBodySchema)) _body: Record<string, never> | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<AsBuiltEdit> {
    return this.approve.execute({
      projectId: canonical(projectId),
      editId: canonical(editId),
      reviewerId: actorIdOf(request),
      scope: scopeOf(request, 'asbuilt:review'),
    });
  }

  @Post('edits/:editId/reject')
  @HttpCode(200)
  @RequirePermission('asbuilt:review')
  @ApiOkResponse({ schema: openApiSchema(AsBuiltEditSchema) })
  rejectEdit(
    @ProjectIdParam() projectId: string,
    @Param('editId', UuidParamPipe) editId: string,
    @Body(new ZodValidationPipe(RejectAsBuiltEditRequestSchema)) body: RejectAsBuiltEditRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<AsBuiltEdit> {
    return this.reject.execute({
      projectId: canonical(projectId),
      editId: canonical(editId),
      reviewerId: actorIdOf(request),
      scope: scopeOf(request, 'asbuilt:review'),
      reason: body.reason,
    });
  }

  @Get('state')
  @RequirePermission('asbuilt:read')
  @ApiOkResponse({ schema: openApiSchema(AsBuiltStateResponseSchema) })
  state(
    @ProjectIdParam() projectId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<AsBuiltStateResponse> {
    return this.getState.execute({
      projectId: canonical(projectId),
      scope: scopeOf(request, 'asbuilt:read'),
    });
  }

  @Get('lengths')
  @RequirePermission('asbuilt:read')
  @ApiOkResponse({ schema: openApiSchema(AsBuiltLengthsResponseSchema) })
  lengths(
    @ProjectIdParam() projectId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<AsBuiltLengthsResponse> {
    return this.getLengths.execute({
      projectId: canonical(projectId),
      scope: scopeOf(request, 'asbuilt:read'),
    });
  }

  // ---- DXF export (pm / admin) --------------------------------------------------------------

  @Post('exports')
  @HttpCode(202)
  @RequirePermission('asbuilt:export')
  @ApiOkResponse({ schema: openApiSchema(AsBuiltExportSchema) })
  createExport(
    @ProjectIdParam() projectId: string,
    @Body(new ZodValidationPipe(EmptyBodySchema)) _body: Record<string, never> | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<AsBuiltExport> {
    return this.requestExport.execute({
      projectId: canonical(projectId),
      actorId: actorIdOf(request),
    });
  }

  @Get('exports')
  @RequirePermission('asbuilt:export')
  @ApiOkResponse({ schema: openApiSchema(AsBuiltExportListResponseSchema) })
  async exports(@ProjectIdParam() projectId: string): Promise<AsBuiltExportListResponse> {
    return { items: await this.listExports.execute(canonical(projectId)) };
  }

  @Get('exports/:exportId')
  @RequirePermission('asbuilt:export')
  @ApiOkResponse({ schema: openApiSchema(AsBuiltExportSchema) })
  oneExport(
    @ProjectIdParam() projectId: string,
    @Param('exportId', UuidParamPipe) exportId: string,
  ): Promise<AsBuiltExport> {
    return this.getExport.execute(canonical(projectId), canonical(exportId));
  }

  @Get('exports/:exportId/file')
  @RequirePermission('asbuilt:export')
  async file(
    @ProjectIdParam() projectId: string,
    @Param('exportId', UuidParamPipe) exportId: string,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.download.execute(canonical(projectId), canonical(exportId));
    response.setHeader('Content-Type', 'application/dxf');
    // ASCII only (revision number and hex): no filename* needed.
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Length', String(file.sizeBytes));
    file.stream.on('error', (error) => response.destroy(error));
    file.stream.pipe(response);
  }
}
