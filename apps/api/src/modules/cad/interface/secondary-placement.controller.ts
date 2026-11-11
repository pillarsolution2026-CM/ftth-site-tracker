import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  SecondaryPlacementSuggestionSchema,
  type SecondaryPlacementSuggestion,
} from '@ftth/shared';
import { ProjectIdParam } from '../../../common/http/params.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import { GetSecondaryPlacementSuggestionUseCase } from '../application/secondary-placement.use-case.js';

/** ADR-042 part G: control points of a Secondary from the placed General's cabinets. */
@ApiTags('cad-mapping')
@ApiBearerAuth()
@Controller('projects/:projectId/cad-files/:cadFileId/placement')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class SecondaryPlacementController {
  constructor(
    @Inject(GetSecondaryPlacementSuggestionUseCase)
    private readonly suggestion: GetSecondaryPlacementSuggestionUseCase,
  ) {}

  @Get('general-cabinets')
  @RequirePermission('cad_files:read')
  @ApiOkResponse({ schema: openApiSchema(SecondaryPlacementSuggestionSchema) })
  suggest(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
  ): Promise<SecondaryPlacementSuggestion> {
    return this.suggestion.execute(projectId, cadFileId);
  }
}
