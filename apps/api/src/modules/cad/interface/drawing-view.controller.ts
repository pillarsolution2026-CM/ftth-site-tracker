import { Controller, Get, HttpCode, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DrawingViewStateSchema, type DrawingViewState } from '@ftth/shared';
import { ProjectIdParam } from '../../../common/http/params.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import { DrawingViewRateLimitGuard } from './drawing-view-rate-limit.guard.js';
import {
  GetDrawingViewContentUseCase,
  GetDrawingViewStateUseCase,
  RequestDrawingViewUseCase,
} from '../application/drawing-view.use-cases.js';

/** «عارض الرسومات» (ADR-039): the flattened drawing the canvas draws. */
@ApiTags('drawing-view')
@ApiBearerAuth()
@Controller('projects/:projectId/cad-files/:cadFileId/view')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class DrawingViewController {
  constructor(
    @Inject(GetDrawingViewStateUseCase) private readonly state: GetDrawingViewStateUseCase,
    @Inject(RequestDrawingViewUseCase) private readonly request: RequestDrawingViewUseCase,
    @Inject(GetDrawingViewContentUseCase) private readonly content: GetDrawingViewContentUseCase,
  ) {}

  @Get('status')
  @RequirePermission('cad_files:read')
  @ApiOkResponse({ schema: openApiSchema(DrawingViewStateSchema) })
  getState(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
  ): Promise<DrawingViewState> {
    return this.state.execute(projectId, cadFileId);
  }

  @Post()
  @UseGuards(DrawingViewRateLimitGuard)
  @HttpCode(202)
  @RequirePermission('design:write')
  @ApiOkResponse({ schema: openApiSchema(DrawingViewStateSchema) })
  requestView(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
  ): Promise<DrawingViewState> {
    return this.request.execute(projectId, cadFileId);
  }

  /** The stored gzip JSON (`DrawingView`), streamed as is; the client decodes `content-encoding`. */
  @Get()
  @RequirePermission('cad_files:read')
  async download(
    @ProjectIdParam() projectId: string,
    @Param('cadFileId', UuidParamPipe) cadFileId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { stream, sizeBytes } = await this.content.execute(projectId, cadFileId);
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Content-Encoding', 'gzip');
    response.setHeader('Content-Length', String(sizeBytes));
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    stream.on('error', (error) => response.destroy(error));
    stream.pipe(response);
  }
}
