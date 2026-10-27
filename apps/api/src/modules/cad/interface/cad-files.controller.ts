import {
  Controller,
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
  CadFileDetailSchema,
  CadFileListResponseSchema,
  CadFileLogResponseSchema,
  CadFileSummarySchema,
  type ApiEnv,
  type CadFileDetail,
  type CadFileListResponse,
  type CadFileLogResponse,
  type CadFileSummary,
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
  GetCadFileContentUseCase,
  GetCadFileLogUseCase,
  GetCadFileUseCase,
  ListCadFilesUseCase,
} from '../application/cad-queries.use-cases.js';
import { ReprocessCadFileUseCase } from '../application/reprocess-cad-file.use-case.js';
import { UploadCadFileUseCase } from '../application/upload-cad-file.use-case.js';
import { toDetailDto, toSummaryDto } from './cad-file.presenter.js';

@ApiTags('cad-files')
@ApiBearerAuth()
@Controller('projects/:projectId/cad-files')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class CadFilesController {
  constructor(
    @Inject(UploadCadFileUseCase) private readonly upload: UploadCadFileUseCase,
    @Inject(ListCadFilesUseCase) private readonly list: ListCadFilesUseCase,
    @Inject(GetCadFileUseCase) private readonly get: GetCadFileUseCase,
    @Inject(GetCadFileContentUseCase) private readonly content: GetCadFileContentUseCase,
    @Inject(GetCadFileLogUseCase) private readonly log: GetCadFileLogUseCase,
    @Inject(ReprocessCadFileUseCase) private readonly reprocess: ReprocessCadFileUseCase,
    @Inject(APP_ENV) private readonly env: ApiEnv,
  ) {}

  @Post()
  @RequirePermission('cad_files:write')
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({ schema: openApiSchema(CadFileSummarySchema) })
  async uploadOne(
    @ProjectIdParam() projectId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CadFileSummary> {
    const { file } = await receiveStreamedFile(request, maxUploadBytes(this.env.MAX_UPLOAD_MB));
    try {
      const created = await this.upload.execute({ projectId, actorId: actorIdOf(request), file });
      return toSummaryDto(created);
    } finally {
      file.stream.resume(); // drain whatever the use case did not read (e.g. a rejected file)
    }
  }

  @Get()
  @RequirePermission('cad_files:read')
  @ApiOkResponse({ schema: openApiSchema(CadFileListResponseSchema) })
  async listAll(@ProjectIdParam() projectId: string): Promise<CadFileListResponse> {
    return { items: (await this.list.execute(projectId)).map(toSummaryDto) };
  }

  @Get(':cadFileId')
  @RequirePermission('cad_files:read')
  @ApiOkResponse({ schema: openApiSchema(CadFileDetailSchema) })
  async getOne(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
  ): Promise<CadFileDetail> {
    return toDetailDto(await this.get.execute(projectId, cadFileId));
  }

  @Get(':cadFileId/content')
  @RequirePermission('cad_files:read')
  async download(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { file, stream } = await this.content.execute(projectId, cadFileId);
    sendDownload(response, {
      stream,
      contentType: 'application/octet-stream',
      fileName: file.originalName,
      sizeBytes: file.sizeBytes,
    });
  }

  @Get(':cadFileId/log')
  @RequirePermission('cad_files:read')
  @ApiOkResponse({ schema: openApiSchema(CadFileLogResponseSchema) })
  async getLog(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
  ): Promise<CadFileLogResponse> {
    return { log: await this.log.execute(projectId, cadFileId) };
  }

  @Post(':cadFileId/reprocess')
  @HttpCode(202)
  @RequirePermission('cad_files:write')
  @ApiOkResponse({ schema: openApiSchema(CadFileSummarySchema) })
  async reprocessOne(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CadFileSummary> {
    const file = await this.reprocess.execute({
      projectId,
      cadFileId,
      actorId: actorIdOf(request),
    });
    return toSummaryDto(file);
  }
}
