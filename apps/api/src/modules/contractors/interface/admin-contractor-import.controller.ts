import { Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  ContractorImportCommitPayloadSchema,
  ContractorImportPreviewOptionsSchema,
  ContractorImportPreviewResponseSchema,
  ProjectContractorsResponseSchema,
  type ApiEnv,
  type ContractorImportPreviewResponse,
  type ProjectContractorsResponse,
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
  CommitContractorImportUseCase,
  PreviewContractorImportUseCase,
} from '../application/import.use-cases.js';
import { toProjectContractorsDto } from './contractor.presenter.js';

/**
 * Platform admins only (ADR-036). Multipart: field `file` (.xlsx) and field `payload` (JSON text).
 * The contractor's lines exist only through this upload.
 */
@ApiTags('admin')
@ApiBearerAuth()
@ApiConsumes('multipart/form-data')
@Controller('admin/projects/:projectId/contractors/import')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminContractorImportController {
  constructor(
    @Inject(PreviewContractorImportUseCase)
    private readonly preview: PreviewContractorImportUseCase,
    @Inject(CommitContractorImportUseCase) private readonly commit: CommitContractorImportUseCase,
    @Inject(APP_ENV) private readonly env: ApiEnv,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(ContractorImportPreviewResponseSchema) })
  async previewImport(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ContractorImportPreviewResponse> {
    const upload = await receiveBufferedFile(request, maxUploadBytes(this.env.MAX_UPLOAD_MB));
    const options = parsePayloadField(upload.fields, ContractorImportPreviewOptionsSchema);
    return this.preview.execute({ projectId, file: upload.file, options });
  }

  @Post()
  @ApiCreatedResponse({ schema: openApiSchema(ProjectContractorsResponseSchema) })
  async commitImport(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectContractorsResponse> {
    const upload = await receiveBufferedFile(request, maxUploadBytes(this.env.MAX_UPLOAD_MB));
    const payload = parsePayloadField(upload.fields, ContractorImportCommitPayloadSchema);
    return toProjectContractorsDto(
      await this.commit.execute({
        projectId,
        actorId: actorIdOf(request),
        file: upload.file,
        payload,
      }),
    );
  }
}
