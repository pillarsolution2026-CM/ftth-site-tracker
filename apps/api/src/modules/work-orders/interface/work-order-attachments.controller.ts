import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  WorkOrderAttachmentListResponseSchema,
  WorkOrderAttachmentSchema,
  type ApiEnv,
  type WorkOrderAttachment,
  type WorkOrderAttachmentListResponse,
} from '@ftth/shared';
import { sendDownload } from '../../../common/http/download.js';
import { receiveStreamedFile } from '../../../common/http/multipart.js';
import { maxUploadBytes } from '../../../common/http/multipart-payload.js';
import { ProjectIdParam } from '../../../common/http/params.js';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { APP_ENV } from '../../../config/config.module.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import {
  AddAttachmentUseCase,
  DeleteAttachmentUseCase,
  GetAttachmentContentUseCase,
  ListAttachmentsUseCase,
} from '../application/attachment.use-cases.js';
import { toAttachmentDto } from './work-order.presenter.js';

@ApiTags('work-orders')
@ApiBearerAuth()
@Controller('projects/:projectId/work-orders/:workOrderId/attachments')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class WorkOrderAttachmentsController {
  constructor(
    @Inject(ListAttachmentsUseCase) private readonly list: ListAttachmentsUseCase,
    @Inject(AddAttachmentUseCase) private readonly add: AddAttachmentUseCase,
    @Inject(GetAttachmentContentUseCase) private readonly content: GetAttachmentContentUseCase,
    @Inject(DeleteAttachmentUseCase) private readonly remove: DeleteAttachmentUseCase,
    @Inject(APP_ENV) private readonly env: ApiEnv,
  ) {}

  @Get()
  @RequirePermission('work_orders:read')
  @ApiOkResponse({ schema: openApiSchema(WorkOrderAttachmentListResponseSchema) })
  async listAll(
    @ProjectIdParam() projectId: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
  ): Promise<WorkOrderAttachmentListResponse> {
    const attachments = await this.list.execute(projectId, workOrderId);
    return { items: attachments.map(toAttachmentDto) };
  }

  @Post()
  @RequirePermission('work_orders:write')
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({ schema: openApiSchema(WorkOrderAttachmentSchema) })
  async upload(
    @ProjectIdParam() projectId: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkOrderAttachment> {
    const { file } = await receiveStreamedFile(request, maxUploadBytes(this.env.MAX_UPLOAD_MB));
    try {
      const attachment = await this.add.execute({
        projectId,
        workOrderId,
        actorId: actorIdOf(request),
        file,
      });
      return toAttachmentDto(attachment);
    } finally {
      file.stream.resume(); // drain whatever the use case did not read (e.g. a rejected file)
    }
  }

  @Get(':attachmentId/content')
  @RequirePermission('work_orders:read')
  async download(
    @ProjectIdParam() projectId: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
    @Param('attachmentId', UuidParamPipe) attachmentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { attachment, stream } = await this.content.execute(projectId, workOrderId, attachmentId);
    sendDownload(response, {
      stream,
      contentType: attachment.contentType,
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
    });
  }

  @Delete(':attachmentId')
  @HttpCode(204)
  @RequirePermission('work_orders:write')
  async deleteOne(
    @ProjectIdParam() projectId: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
    @Param('attachmentId', UuidParamPipe) attachmentId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.remove.execute({
      projectId,
      workOrderId,
      attachmentId,
      actorId: actorIdOf(request),
    });
  }
}
