import { Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  ContractDetailSchema,
  ContractImportCommitPayloadSchema,
  ContractImportPreviewOptionsSchema,
  ContractImportPreviewResponseSchema,
  type ApiEnv,
  type ContractDetail,
  type ContractImportPreviewResponse,
} from '@ftth/shared';
import { receiveBufferedFile } from '../../../common/http/multipart.js';
import { maxUploadBytes, parsePayloadField } from '../../../common/http/multipart-payload.js';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { APP_ENV } from '../../../config/config.module.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { PlatformAdminGuard } from '../../identity/interface/platform-admin.guard.js';
import {
  CommitContractImportUseCase,
  PreviewContractImportUseCase,
} from '../application/import.use-cases.js';
import { toDetailDto } from './contract.presenter.js';

/** Multipart: field `file` (.xlsx) and field `payload` (JSON text). The xlsx is parsed in memory. */
@ApiTags('admin')
@ApiBearerAuth()
@ApiConsumes('multipart/form-data')
@Controller('admin/contracts/:contractId/import')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminContractImportController {
  constructor(
    @Inject(PreviewContractImportUseCase) private readonly preview: PreviewContractImportUseCase,
    @Inject(CommitContractImportUseCase) private readonly commit: CommitContractImportUseCase,
    @Inject(APP_ENV) private readonly env: ApiEnv,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(ContractImportPreviewResponseSchema) })
  async previewImport(
    @Param('contractId', UuidParamPipe) contractId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ContractImportPreviewResponse> {
    const upload = await receiveBufferedFile(request, maxUploadBytes(this.env.MAX_UPLOAD_MB));
    const options = parsePayloadField(upload.fields, ContractImportPreviewOptionsSchema, {});
    return this.preview.execute({ contractId, file: upload.file, options });
  }

  @Post()
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(ContractDetailSchema) })
  async commitImport(
    @Param('contractId', UuidParamPipe) contractId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ContractDetail> {
    const upload = await receiveBufferedFile(request, maxUploadBytes(this.env.MAX_UPLOAD_MB));
    const payload = parsePayloadField(upload.fields, ContractImportCommitPayloadSchema);
    return toDetailDto(
      await this.commit.execute({
        contractId,
        actorId: actorIdOf(request),
        file: upload.file,
        payload,
      }),
    );
  }
}
