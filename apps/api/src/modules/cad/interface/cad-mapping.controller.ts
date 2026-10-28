import { Body, Controller, Get, Inject, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  CadMappingInputSchema,
  CadMappingSchema,
  CadMappingViewSchema,
  type CadMapping,
  type CadMappingInput,
  type CadMappingView,
} from '@ftth/shared';
import { ProjectIdParam } from '../../../common/http/params.js';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import {
  GetCadMappingUseCase,
  SaveCadMappingUseCase,
} from '../application/cad-mapping.use-cases.js';
import { toMappingDto, toMappingViewDto } from './design-revision.presenter.js';

@ApiTags('cad-mapping')
@ApiBearerAuth()
@Controller('projects/:projectId/cad-files/:cadFileId/mapping')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class CadMappingController {
  constructor(
    @Inject(GetCadMappingUseCase) private readonly getMapping: GetCadMappingUseCase,
    @Inject(SaveCadMappingUseCase) private readonly saveMapping: SaveCadMappingUseCase,
  ) {}

  @Get()
  @RequirePermission('cad_files:read')
  @ApiOkResponse({ schema: openApiSchema(CadMappingViewSchema) })
  async get(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
  ): Promise<CadMappingView> {
    return toMappingViewDto(await this.getMapping.execute(projectId, cadFileId));
  }

  @Put()
  @RequirePermission('cad_files:write')
  @ApiOkResponse({ schema: openApiSchema(CadMappingSchema) })
  async save(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Body(new ZodValidationPipe(CadMappingInputSchema)) body: CadMappingInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<CadMapping> {
    const saved = await this.saveMapping.execute({
      projectId,
      cadFileId,
      actorId: actorIdOf(request),
      mapping: body,
    });
    return toMappingDto(saved);
  }
}
