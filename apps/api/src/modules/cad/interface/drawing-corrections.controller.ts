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
  CreateDrawingCorrectionRequestSchema,
  CreateDrawingCorrectionsRequestSchema,
  DrawingCorrectionListSchema,
  DrawingCorrectionSchema,
  DrawingCorrectionsSavedSchema,
  type CreateDrawingCorrectionRequest,
  type CreateDrawingCorrectionsRequest,
  type DrawingCorrection,
  type DrawingCorrectionList,
  type DrawingCorrectionsSaved,
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
  CreateDrawingCorrectionUseCase,
  ListDrawingCorrectionsUseCase,
  WithdrawDrawingCorrectionUseCase,
} from '../application/drawing-correction.use-cases.js';
import { toDrawingCorrectionDto } from './drawing-correction.presenter.js';

@ApiTags('drawing-corrections')
@ApiBearerAuth()
@Controller('projects/:projectId/cad-files/:cadFileId/corrections')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class DrawingCorrectionsController {
  constructor(
    @Inject(ListDrawingCorrectionsUseCase) private readonly list: ListDrawingCorrectionsUseCase,
    @Inject(CreateDrawingCorrectionUseCase) private readonly create: CreateDrawingCorrectionUseCase,
    @Inject(WithdrawDrawingCorrectionUseCase)
    private readonly withdraw: WithdrawDrawingCorrectionUseCase,
  ) {}

  @Get()
  @RequirePermission('cad_files:read')
  @ApiOkResponse({ schema: openApiSchema(DrawingCorrectionListSchema) })
  async listAll(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
  ): Promise<DrawingCorrectionList> {
    const { items, activeCount } = await this.list.execute(projectId, cadFileId);
    return { items: items.map(toDrawingCorrectionDto), activeCount };
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('design:write')
  @ApiOkResponse({ schema: openApiSchema(DrawingCorrectionSchema) })
  async add(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Body(new ZodValidationPipe(CreateDrawingCorrectionRequestSchema))
    body: CreateDrawingCorrectionRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<DrawingCorrection> {
    const created = await this.create.execute({
      projectId,
      cadFileId,
      actorId: actorIdOf(request),
      request: body,
    });
    return toDrawingCorrectionDto(created);
  }

  /** The edits of one «حفظ» in the drawing's edit mode (ADR-047): all or none. */
  @Post('batch')
  @HttpCode(201)
  @RequirePermission('design:write')
  @ApiOkResponse({ schema: openApiSchema(DrawingCorrectionsSavedSchema) })
  async addMany(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Body(new ZodValidationPipe(CreateDrawingCorrectionsRequestSchema))
    body: CreateDrawingCorrectionsRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<DrawingCorrectionsSaved> {
    const created = await this.create.executeMany({
      projectId,
      cadFileId,
      actorId: actorIdOf(request),
      requests: body.items,
    });
    return { items: created.map(toDrawingCorrectionDto) };
  }

  @Post(':correctionId/withdraw')
  @HttpCode(200)
  @RequirePermission('design:write')
  @ApiOkResponse({ schema: openApiSchema(DrawingCorrectionSchema) })
  async withdrawOne(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Param('correctionId', UuidParamPipe) correctionId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<DrawingCorrection> {
    const withdrawn = await this.withdraw.execute({
      projectId,
      cadFileId,
      correctionId,
      actorId: actorIdOf(request),
    });
    return toDrawingCorrectionDto(withdrawn);
  }
}
