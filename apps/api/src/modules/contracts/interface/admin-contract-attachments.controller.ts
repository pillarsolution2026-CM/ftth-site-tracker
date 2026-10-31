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
import { ApiBearerAuth, ApiConsumes, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ContractAttachmentSchema, type ApiEnv, type ContractAttachment } from '@ftth/shared';
import { sendDownload } from '../../../common/http/download.js';
import { receiveStreamedFile } from '../../../common/http/multipart.js';
import { maxUploadBytes } from '../../../common/http/multipart-payload.js';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { APP_ENV } from '../../../config/config.module.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { PlatformAdminGuard } from '../../identity/interface/platform-admin.guard.js';
import {
  AddContractAttachmentUseCase,
  DeleteContractAttachmentUseCase,
  GetContractAttachmentContentUseCase,
} from '../application/attachment.use-cases.js';
import { toAttachmentDto } from './contract.presenter.js';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/contracts/:contractId/attachments')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminContractAttachmentsController {
  constructor(
    @Inject(AddContractAttachmentUseCase) private readonly add: AddContractAttachmentUseCase,
    @Inject(GetContractAttachmentContentUseCase)
    private readonly content: GetContractAttachmentContentUseCase,
    @Inject(DeleteContractAttachmentUseCase)
    private readonly remove: DeleteContractAttachmentUseCase,
    @Inject(APP_ENV) private readonly env: ApiEnv,
  ) {}

  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({ schema: openApiSchema(ContractAttachmentSchema) })
  async upload(
    @Param('contractId', UuidParamPipe) contractId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ContractAttachment> {
    const { file } = await receiveStreamedFile(request, maxUploadBytes(this.env.MAX_UPLOAD_MB));
    try {
      const attachment = await this.add.execute({
        contractId,
        actorId: actorIdOf(request),
        file,
      });
      return toAttachmentDto(attachment);
    } finally {
      file.stream.resume(); // drain whatever the use case did not read (e.g. a rejected file)
    }
  }

  @Get(':attachmentId')
  async download(
    @Param('contractId', UuidParamPipe) contractId: string,
    @Param('attachmentId', UuidParamPipe) attachmentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { attachment, stream } = await this.content.execute(contractId, attachmentId);
    sendDownload(response, {
      stream,
      contentType: attachment.contentType,
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
    });
  }

  @Delete(':attachmentId')
  @HttpCode(204)
  async deleteOne(
    @Param('contractId', UuidParamPipe) contractId: string,
    @Param('attachmentId', UuidParamPipe) attachmentId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.remove.execute({ contractId, attachmentId, actorId: actorIdOf(request) });
  }
}
