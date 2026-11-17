import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  BoxTypeStateSchema,
  BoxTypesReportSchema,
  SetBoxTypesRequestSchema,
  type BoxTypesReport,
  type BoxTypeState,
  type SetBoxTypesRequest,
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
  GetBoxTypeStateUseCase,
  GetRevisionBoxTypesUseCase,
  SetBoxTypesUseCase,
} from '../application/box-types.use-cases.js';
import { toBoxTypeStateDto } from './box-types.presenter.js';

/** Box type by the drawn shape: the PM's choices and the revision's report (ADR-043). */
@ApiTags('box-types')
@ApiBearerAuth()
@Controller('projects/:projectId')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class BoxTypesController {
  constructor(
    @Inject(GetBoxTypeStateUseCase) private readonly getState: GetBoxTypeStateUseCase,
    @Inject(SetBoxTypesUseCase) private readonly setTypes: SetBoxTypesUseCase,
    @Inject(GetRevisionBoxTypesUseCase) private readonly revisionReport: GetRevisionBoxTypesUseCase,
  ) {}

  @Get('cad-files/:cadFileId/box-types')
  @RequirePermission('cad_files:read')
  @ApiOkResponse({ schema: openApiSchema(BoxTypeStateSchema) })
  async state(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
  ): Promise<BoxTypeState> {
    return toBoxTypeStateDto(await this.getState.execute(projectId, cadFileId));
  }

  @Post('cad-files/:cadFileId/box-types')
  @HttpCode(200)
  @RequirePermission('design:write')
  @ApiOkResponse({ schema: openApiSchema(BoxTypeStateSchema) })
  async set(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Body(new ZodValidationPipe(SetBoxTypesRequestSchema)) body: SetBoxTypesRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<BoxTypeState> {
    const model = await this.setTypes.execute({
      projectId,
      cadFileId,
      actorId: actorIdOf(request),
      request: body,
    });
    return toBoxTypeStateDto(model);
  }

  @Get('design-revisions/:revisionId/box-types')
  @RequirePermission('design:read')
  @ApiOkResponse({ schema: openApiSchema(BoxTypesReportSchema) })
  report(
    @ProjectIdParam() projectId: string,
    @Param('revisionId', UuidParamPipe) revisionId: string,
  ): Promise<BoxTypesReport> {
    return this.revisionReport.execute(projectId, revisionId);
  }
}
