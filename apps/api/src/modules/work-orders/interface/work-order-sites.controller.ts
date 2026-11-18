import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  ReplaceWorkOrderSitesRequestSchema,
  WorkOrderSiteListResponseSchema,
  WorkOrderSitesPreviewResponseSchema,
  type ApiEnv,
  type ReplaceWorkOrderSitesRequest,
  type WorkOrderSiteListResponse,
  type WorkOrderSitesPreviewResponse,
} from '@ftth/shared';
import { receiveBufferedFile } from '../../../common/http/multipart.js';
import { maxUploadBytes } from '../../../common/http/multipart-payload.js';
import { ProjectIdParam } from '../../../common/http/params.js';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { APP_ENV } from '../../../config/config.module.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import {
  ListWorkOrderSitesUseCase,
  PreviewSitesTableUseCase,
  ReplaceWorkOrderSitesUseCase,
  type WorkOrderSitesView,
} from '../application/work-order-sites.use-cases.js';

const toListDto = (view: WorkOrderSitesView): WorkOrderSiteListResponse => ({
  version: view.version,
  items: view.sites.map((site) => ({
    id: site.id,
    workOrderId: site.workOrderId,
    name: site.name,
    position: site.position,
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
  })),
});

/** Central and sites: the sites list of a work order (ADR-049). */
@ApiTags('work-orders')
@ApiBearerAuth()
@Controller('projects/:projectId/work-orders/:workOrderId/sites')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class WorkOrderSitesController {
  constructor(
    @Inject(ListWorkOrderSitesUseCase) private readonly list: ListWorkOrderSitesUseCase,
    @Inject(ReplaceWorkOrderSitesUseCase) private readonly replace: ReplaceWorkOrderSitesUseCase,
    @Inject(PreviewSitesTableUseCase) private readonly preview: PreviewSitesTableUseCase,
    @Inject(APP_ENV) private readonly env: ApiEnv,
  ) {}

  @Get()
  @RequirePermission('work_orders:read')
  @ApiOkResponse({ schema: openApiSchema(WorkOrderSiteListResponseSchema) })
  async listAll(
    @ProjectIdParam() projectId: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
  ): Promise<WorkOrderSiteListResponse> {
    return toListDto(await this.list.execute(projectId, workOrderId));
  }

  @Put()
  @RequirePermission('work_orders:write')
  @ApiOkResponse({ schema: openApiSchema(WorkOrderSiteListResponseSchema) })
  async replaceAll(
    @ProjectIdParam() projectId: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
    @Body(new ZodValidationPipe(ReplaceWorkOrderSitesRequestSchema))
    body: ReplaceWorkOrderSitesRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkOrderSiteListResponse> {
    return toListDto(
      await this.replace.execute({
        projectId,
        workOrderId,
        actorId: actorIdOf(request),
        request: body,
      }),
    );
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('work_orders:write')
  @ApiConsumes('multipart/form-data')
  @ApiOkResponse({ schema: openApiSchema(WorkOrderSitesPreviewResponseSchema) })
  async previewTable(
    @ProjectIdParam() projectId: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkOrderSitesPreviewResponse> {
    const upload = await receiveBufferedFile(request, maxUploadBytes(this.env.MAX_UPLOAD_MB));
    return this.preview.execute({ projectId, workOrderId, file: upload.file });
  }
}
