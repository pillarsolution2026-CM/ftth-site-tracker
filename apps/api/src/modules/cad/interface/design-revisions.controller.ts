import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CreateDesignRevisionRequestSchema,
  DesignFeatureListQuerySchema,
  DesignFeaturePageSchema,
  DesignRevisionDetailSchema,
  DesignRevisionListResponseSchema,
  DesignRevisionSummarySchema,
  DiffListQuerySchema,
  DiffPageSchema,
  PublishDesignRevisionRequestSchema,
  ReviewTextLinkRequestSchema,
  TextLinkListQuerySchema,
  TextLinkPageSchema,
  TextLinkSchema,
  TileUrlResponseSchema,
  type CreateDesignRevisionRequest,
  type DesignFeatureListQuery,
  type DesignFeaturePage,
  type DesignRevisionDetail,
  type DesignRevisionListResponse,
  type DesignRevisionSummary,
  type DiffListQuery,
  type DiffPage,
  type PublishDesignRevisionRequest,
  type ReviewTextLinkRequest,
  type TextLink,
  type TextLinkListQuery,
  type TextLinkPage,
  type TileUrlResponse,
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
import { CreateDesignRevisionUseCase } from '../application/create-design-revision.use-case.js';
import {
  GetDesignRevisionUseCase,
  ListDesignFeaturesUseCase,
  ListDesignRevisionsUseCase,
  ListRevisionDiffUseCase,
  ListTextLinksUseCase,
} from '../application/design-revision-queries.use-cases.js';
import { DiscardDesignRevisionUseCase } from '../application/discard-design-revision.use-case.js';
import { PublishDesignRevisionUseCase } from '../application/publish-design-revision.use-case.js';
import { ReviewTextLinkUseCase } from '../application/review-text-link.use-case.js';
import { CreateTileUrlUseCase, GetRevisionTilesUseCase } from '../application/tiles.use-cases.js';
import { toRevisionDetailDto, toRevisionSummaryDto } from './design-revision.presenter.js';

const PMTILES_CONTENT_TYPE = 'application/vnd.pmtiles';

@ApiTags('design-revisions')
@ApiBearerAuth()
@Controller('projects/:projectId/design-revisions')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class DesignRevisionsController {
  constructor(
    @Inject(ListDesignRevisionsUseCase) private readonly list: ListDesignRevisionsUseCase,
    @Inject(GetDesignRevisionUseCase) private readonly get: GetDesignRevisionUseCase,
    @Inject(CreateDesignRevisionUseCase) private readonly create: CreateDesignRevisionUseCase,
    @Inject(ListDesignFeaturesUseCase) private readonly features: ListDesignFeaturesUseCase,
    @Inject(ListTextLinksUseCase) private readonly textLinks: ListTextLinksUseCase,
    @Inject(ReviewTextLinkUseCase) private readonly review: ReviewTextLinkUseCase,
    @Inject(ListRevisionDiffUseCase) private readonly diff: ListRevisionDiffUseCase,
    @Inject(PublishDesignRevisionUseCase) private readonly publish: PublishDesignRevisionUseCase,
    @Inject(DiscardDesignRevisionUseCase) private readonly discard: DiscardDesignRevisionUseCase,
    @Inject(GetRevisionTilesUseCase) private readonly tiles: GetRevisionTilesUseCase,
    @Inject(CreateTileUrlUseCase) private readonly tileUrl: CreateTileUrlUseCase,
  ) {}

  @Get()
  @RequirePermission('design:read')
  @ApiOkResponse({ schema: openApiSchema(DesignRevisionListResponseSchema) })
  async listAll(@ProjectIdParam() projectId: string): Promise<DesignRevisionListResponse> {
    return { items: (await this.list.execute(projectId)).map(toRevisionSummaryDto) };
  }

  @Post()
  @HttpCode(202)
  @RequirePermission('design:write')
  @ApiOkResponse({ schema: openApiSchema(DesignRevisionSummarySchema) })
  async createOne(
    @ProjectIdParam() projectId: string,
    @Body(new ZodValidationPipe(CreateDesignRevisionRequestSchema))
    body: CreateDesignRevisionRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<DesignRevisionSummary> {
    const revision = await this.create.execute({
      projectId,
      actorId: actorIdOf(request),
      request: body,
    });
    return toRevisionSummaryDto(revision);
  }

  @Get(':revisionId')
  @RequirePermission('design:read')
  @ApiOkResponse({ schema: openApiSchema(DesignRevisionDetailSchema) })
  async getOne(
    @ProjectIdParam() projectId: string,
    @Param('revisionId', UuidParamPipe) revisionId: string,
  ): Promise<DesignRevisionDetail> {
    return toRevisionDetailDto(await this.get.execute(projectId, revisionId));
  }

  @Get(':revisionId/features')
  @RequirePermission('design:read')
  @ApiOkResponse({ schema: openApiSchema(DesignFeaturePageSchema) })
  listFeatures(
    @ProjectIdParam() projectId: string,
    @Param('revisionId', UuidParamPipe) revisionId: string,
    @Query(new ZodValidationPipe(DesignFeatureListQuerySchema)) query: DesignFeatureListQuery,
  ): Promise<DesignFeaturePage> {
    return this.features.execute(projectId, revisionId, query);
  }

  @Get(':revisionId/text-links')
  @RequirePermission('design:read')
  @ApiOkResponse({ schema: openApiSchema(TextLinkPageSchema) })
  listTextLinks(
    @ProjectIdParam() projectId: string,
    @Param('revisionId', UuidParamPipe) revisionId: string,
    @Query(new ZodValidationPipe(TextLinkListQuerySchema)) query: TextLinkListQuery,
  ): Promise<TextLinkPage> {
    return this.textLinks.execute(projectId, revisionId, query);
  }

  @Patch(':revisionId/text-links/:linkId')
  @RequirePermission('design:write')
  @ApiOkResponse({ schema: openApiSchema(TextLinkSchema) })
  reviewTextLink(
    @ProjectIdParam() projectId: string,
    @Param('revisionId', UuidParamPipe) revisionId: string,
    @Param('linkId', UuidParamPipe) linkId: string,
    @Body(new ZodValidationPipe(ReviewTextLinkRequestSchema)) body: ReviewTextLinkRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<TextLink> {
    return this.review.execute({
      projectId,
      revisionId,
      linkId,
      actorId: actorIdOf(request),
      review: body,
    });
  }

  @Get(':revisionId/diff')
  @RequirePermission('design:read')
  @ApiOkResponse({ schema: openApiSchema(DiffPageSchema) })
  listDiff(
    @ProjectIdParam() projectId: string,
    @Param('revisionId', UuidParamPipe) revisionId: string,
    @Query(new ZodValidationPipe(DiffListQuerySchema)) query: DiffListQuery,
  ): Promise<DiffPage> {
    return this.diff.execute(projectId, revisionId, query);
  }

  @Post(':revisionId/publish')
  @HttpCode(200)
  @RequirePermission('design:write')
  @ApiOkResponse({ schema: openApiSchema(DesignRevisionDetailSchema) })
  async publishOne(
    @ProjectIdParam() projectId: string,
    @Param('revisionId', UuidParamPipe) revisionId: string,
    @Body(new ZodValidationPipe(PublishDesignRevisionRequestSchema))
    body: PublishDesignRevisionRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<DesignRevisionDetail> {
    const revision = await this.publish.execute({
      projectId,
      revisionId,
      actorId: actorIdOf(request),
      request: body,
    });
    return toRevisionDetailDto(revision);
  }

  @Post(':revisionId/discard')
  @HttpCode(200)
  @RequirePermission('design:write')
  @ApiOkResponse({ schema: openApiSchema(DesignRevisionDetailSchema) })
  async discardOne(
    @ProjectIdParam() projectId: string,
    @Param('revisionId', UuidParamPipe) revisionId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<DesignRevisionDetail> {
    const revision = await this.discard.execute({
      projectId,
      revisionId,
      actorId: actorIdOf(request),
    });
    return toRevisionDetailDto(revision);
  }

  @Get(':revisionId/tiles.pmtiles')
  @RequirePermission('design:read')
  async downloadTiles(
    @ProjectIdParam() projectId: string,
    @Param('revisionId', UuidParamPipe) revisionId: string,
    @Headers('range') range: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.tiles.execute(projectId, revisionId, range);
    sendRangedObject(response, result, PMTILES_CONTENT_TYPE);
  }

  @Post(':revisionId/tile-url')
  @HttpCode(200)
  @RequirePermission('design:read')
  @ApiOkResponse({ schema: openApiSchema(TileUrlResponseSchema) })
  createTileUrl(
    @ProjectIdParam() projectId: string,
    @Param('revisionId', UuidParamPipe) revisionId: string,
  ): Promise<TileUrlResponse> {
    return this.tileUrl.execute(projectId, revisionId);
  }
}
