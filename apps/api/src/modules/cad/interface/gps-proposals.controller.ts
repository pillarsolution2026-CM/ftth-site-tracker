import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AcceptGpsProposalRequestSchema,
  GpsProposalListQuerySchema,
  GpsProposalListResponseSchema,
  GpsProposalSchema,
  RejectGpsProposalRequestSchema,
  type AcceptGpsProposalRequest,
  type GpsProposal,
  type GpsProposalListQuery,
  type GpsProposalListResponse,
  type RejectGpsProposalRequest,
} from '@ftth/shared';
import { sendRangedObject } from '../../../common/http/download.js';
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
  AcceptGpsProposalUseCase,
  GetGpsProposalPhotoUseCase,
  ListGpsProposalsUseCase,
  RejectGpsProposalUseCase,
} from '../application/gps-proposal.use-cases.js';
import { toGpsProposalDto } from './gps-proposal.presenter.js';

/** Supervisor GPS point proposals for the PM to decide (ADR-037). */
@ApiTags('gps-proposals')
@ApiBearerAuth()
@Controller('projects/:projectId/gps-proposals')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class GpsProposalsController {
  constructor(
    @Inject(ListGpsProposalsUseCase) private readonly list: ListGpsProposalsUseCase,
    @Inject(GetGpsProposalPhotoUseCase) private readonly photo: GetGpsProposalPhotoUseCase,
    @Inject(AcceptGpsProposalUseCase) private readonly accept: AcceptGpsProposalUseCase,
    @Inject(RejectGpsProposalUseCase) private readonly reject: RejectGpsProposalUseCase,
  ) {}

  @Get()
  @RequirePermission('cad_files:read')
  @ApiOkResponse({ schema: openApiSchema(GpsProposalListResponseSchema) })
  async listProposals(
    @ProjectIdParam() projectId: string,
    @Query(new ZodValidationPipe(GpsProposalListQuerySchema)) query: GpsProposalListQuery,
  ): Promise<GpsProposalListResponse> {
    const items = await this.list.execute(projectId, query);
    return { items: items.map(toGpsProposalDto) };
  }

  @Get(':id/photo')
  @RequirePermission('cad_files:read')
  async getPhoto(
    @ProjectIdParam() projectId: string,
    @Param('id', UuidParamPipe) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const { stream, sizeBytes } = await this.photo.execute(projectId, id);
    sendRangedObject(response, { kind: 'stream', stream, sizeBytes, range: null }, 'image/jpeg');
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequirePermission('cad_files:write')
  @ApiOkResponse({ schema: openApiSchema(GpsProposalSchema) })
  async acceptProposal(
    @ProjectIdParam() projectId: string,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(AcceptGpsProposalRequestSchema)) body: AcceptGpsProposalRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<GpsProposal> {
    const decided = await this.accept.execute({
      projectId,
      proposalId: id,
      actorId: actorIdOf(request),
      mappingVersion: body.mappingVersion,
    });
    return toGpsProposalDto(decided);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('cad_files:write')
  @ApiOkResponse({ schema: openApiSchema(GpsProposalSchema) })
  async rejectProposal(
    @ProjectIdParam() projectId: string,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(RejectGpsProposalRequestSchema)) body: RejectGpsProposalRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<GpsProposal> {
    const decided = await this.reject.execute({
      projectId,
      proposalId: id,
      actorId: actorIdOf(request),
      reason: body.reason,
    });
    return toGpsProposalDto(decided);
  }
}
