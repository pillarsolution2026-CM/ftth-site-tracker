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
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  CreateTrenchMarkRequestSchema,
  InstallationAnswerRecordSchema,
  InstallationReportSchema,
  InstallationStateSchema,
  SetInstallationAnswerRequestSchema,
  TrenchMarkSchema,
  type CreateTrenchMarkRequest,
  type InstallationAnswerRecord,
  type InstallationReport,
  type InstallationState,
  type SetInstallationAnswerRequest,
  type TrenchMark,
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
  AddTrenchMarkUseCase,
  GetInstallationUseCase,
  GetRevisionInstallationUseCase,
  SetInstallationAnswerUseCase,
  WithdrawTrenchMarkUseCase,
} from '../application/installation.use-cases.js';
import { toAnswerDto, toInstallationStateDto, toTrenchMarkDto } from './installation.presenter.js';

/** The General's installation question and trench marks (ADR-042 part D). */
@ApiTags('installation')
@ApiBearerAuth()
@Controller('projects/:projectId')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class InstallationController {
  constructor(
    @Inject(GetInstallationUseCase) private readonly getState: GetInstallationUseCase,
    @Inject(SetInstallationAnswerUseCase) private readonly setAnswer: SetInstallationAnswerUseCase,
    @Inject(AddTrenchMarkUseCase) private readonly addMark: AddTrenchMarkUseCase,
    @Inject(WithdrawTrenchMarkUseCase) private readonly withdrawMark: WithdrawTrenchMarkUseCase,
    @Inject(GetRevisionInstallationUseCase)
    private readonly revisionReport: GetRevisionInstallationUseCase,
  ) {}

  @Get('cad-files/:cadFileId/installation')
  @RequirePermission('cad_files:read')
  @ApiOkResponse({ schema: openApiSchema(InstallationStateSchema) })
  async state(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
  ): Promise<InstallationState> {
    return toInstallationStateDto(await this.getState.execute(projectId, cadFileId));
  }

  @Put('cad-files/:cadFileId/installation/answer')
  @RequirePermission('design:write')
  @ApiOkResponse({ schema: openApiSchema(InstallationAnswerRecordSchema) })
  async answer(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Body(new ZodValidationPipe(SetInstallationAnswerRequestSchema))
    body: SetInstallationAnswerRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<InstallationAnswerRecord> {
    const saved = await this.setAnswer.execute({
      projectId,
      cadFileId,
      actorId: actorIdOf(request),
      request: body,
    });
    return toAnswerDto(saved);
  }

  @Post('cad-files/:cadFileId/installation/trench-marks')
  @HttpCode(201)
  @RequirePermission('design:write')
  @ApiOkResponse({ schema: openApiSchema(TrenchMarkSchema) })
  async add(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Body(new ZodValidationPipe(CreateTrenchMarkRequestSchema)) body: CreateTrenchMarkRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<TrenchMark> {
    const created = await this.addMark.execute({
      projectId,
      cadFileId,
      actorId: actorIdOf(request),
      request: body,
    });
    return toTrenchMarkDto(created);
  }

  @Post('cad-files/:cadFileId/installation/trench-marks/:markId/withdraw')
  @HttpCode(200)
  @RequirePermission('design:write')
  @ApiOkResponse({ schema: openApiSchema(TrenchMarkSchema) })
  async withdraw(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Param('markId', UuidParamPipe) markId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<TrenchMark> {
    const withdrawn = await this.withdrawMark.execute({
      projectId,
      cadFileId,
      markId,
      actorId: actorIdOf(request),
    });
    return toTrenchMarkDto(withdrawn);
  }

  @Get('design-revisions/:revisionId/installation')
  @RequirePermission('cad_files:read')
  @ApiOkResponse({ schema: openApiSchema(InstallationReportSchema) })
  report(
    @ProjectIdParam() projectId: string,
    @Param('revisionId', UuidParamPipe) revisionId: string,
  ): Promise<InstallationReport> {
    return this.revisionReport.execute(projectId, revisionId);
  }
}
