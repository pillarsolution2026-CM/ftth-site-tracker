import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  CadCurveListQuerySchema,
  CadCurvePageSchema,
  CadInsertListQuerySchema,
  CadInsertPageSchema,
  CadLayerListResponseSchema,
  CadTextListQuerySchema,
  CadTextPageSchema,
  type CadCurveListQuery,
  type CadCurvePage,
  type CadInsertListQuery,
  type CadInsertPage,
  type CadLayerListResponse,
  type CadTextListQuery,
  type CadTextPage,
} from '@ftth/shared';
import { ProjectIdParam } from '../../../common/http/params.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import { CadExtractionUseCases } from '../application/cad-queries.use-cases.js';

/** Review screens over the raw extraction (read-only; the worker writes these tables). */
@ApiTags('cad-files')
@ApiBearerAuth()
@Controller('projects/:projectId/cad-files/:cadFileId')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
@RequirePermission('cad_files:read')
export class CadExtractionController {
  constructor(@Inject(CadExtractionUseCases) private readonly extraction: CadExtractionUseCases) {}

  @Get('layers')
  @ApiOkResponse({ schema: openApiSchema(CadLayerListResponseSchema) })
  async layers(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
  ): Promise<CadLayerListResponse> {
    return { items: await this.extraction.layers(projectId, cadFileId) };
  }

  @Get('inserts')
  @ApiOkResponse({ schema: openApiSchema(CadInsertPageSchema) })
  inserts(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Query(new ZodValidationPipe(CadInsertListQuerySchema)) query: CadInsertListQuery,
  ): Promise<CadInsertPage> {
    return this.extraction.inserts(projectId, cadFileId, query);
  }

  @Get('texts')
  @ApiOkResponse({ schema: openApiSchema(CadTextPageSchema) })
  texts(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Query(new ZodValidationPipe(CadTextListQuerySchema)) query: CadTextListQuery,
  ): Promise<CadTextPage> {
    return this.extraction.texts(projectId, cadFileId, query);
  }

  @Get('curves')
  @ApiOkResponse({ schema: openApiSchema(CadCurvePageSchema) })
  curves(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Query(new ZodValidationPipe(CadCurveListQuerySchema)) query: CadCurveListQuery,
  ): Promise<CadCurvePage> {
    return this.extraction.curves(projectId, cadFileId, query);
  }
}
