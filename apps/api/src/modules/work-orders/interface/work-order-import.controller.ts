import { Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  WorkOrderDetailSchema,
  WorkOrderImportCommitPayloadSchema,
  WorkOrderImportPreviewOptionsSchema,
  WorkOrderImportPreviewResponseSchema,
  type ApiEnv,
  type WorkOrderDetail,
  type WorkOrderImportPreviewResponse,
} from '@ftth/shared';
import { receiveBufferedFile } from '../../../common/http/multipart.js';
import { maxUploadBytes, parsePayloadField } from '../../../common/http/multipart-payload.js';
import { ProjectIdParam } from '../../../common/http/params.js';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { APP_ENV } from '../../../config/config.module.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import { CommitImportUseCase, PreviewImportUseCase } from '../application/import.use-cases.js';
import { toDetailDto } from './work-order.presenter.js';

/** Multipart: field `file` (.xlsx) and field `payload` (JSON text). The xlsx is parsed in memory. */
@ApiTags('work-orders')
@ApiBearerAuth()
@ApiConsumes('multipart/form-data')
@Controller('projects/:projectId/work-orders/import')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class WorkOrderImportController {
  constructor(
    @Inject(PreviewImportUseCase) private readonly preview: PreviewImportUseCase,
    @Inject(CommitImportUseCase) private readonly commit: CommitImportUseCase,
    @Inject(APP_ENV) private readonly env: ApiEnv,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('work_orders:write')
  @ApiOkResponse({ schema: openApiSchema(WorkOrderImportPreviewResponseSchema) })
  async previewImport(
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkOrderImportPreviewResponse> {
    const upload = await receiveBufferedFile(request, maxUploadBytes(this.env.MAX_UPLOAD_MB));
    const options = parsePayloadField(upload.fields, WorkOrderImportPreviewOptionsSchema, {});
    return this.preview.execute({ file: upload.file, options });
  }

  @Post()
  @RequirePermission('work_orders:write')
  @ApiCreatedResponse({ schema: openApiSchema(WorkOrderDetailSchema) })
  async commitImport(
    @ProjectIdParam() projectId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkOrderDetail> {
    const upload = await receiveBufferedFile(request, maxUploadBytes(this.env.MAX_UPLOAD_MB));
    const payload = parsePayloadField(upload.fields, WorkOrderImportCommitPayloadSchema);
    const view = await this.commit.execute({
      projectId,
      actorId: actorIdOf(request),
      file: upload.file,
      payload,
    });
    return toDetailDto(view);
  }
}
