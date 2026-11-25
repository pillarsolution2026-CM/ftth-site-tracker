import { Body, Controller, Get, Inject, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  ElementGroupsResponseSchema,
  ElementKeySchema,
  ReplaceElementGroupsRequestSchema,
  type ElementGroupsResponse,
  type ElementKey,
  type ReplaceElementGroupsRequest,
} from '@ftth/shared';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { openApiSchema } from '../../../common/openapi.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { PlatformAdminGuard } from '../../identity/interface/platform-admin.guard.js';
import {
  GetElementGroupsUseCase,
  ReplaceElementGroupsUseCase,
} from '../application/element-groups.use-cases.js';

/** Platform-admin only (ADR-056): which main groups each element of the drawing offers. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/element-groups')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminElementGroupsController {
  constructor(
    @Inject(GetElementGroupsUseCase) private readonly get: GetElementGroupsUseCase,
    @Inject(ReplaceElementGroupsUseCase) private readonly replace: ReplaceElementGroupsUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ schema: openApiSchema(ElementGroupsResponseSchema) })
  getAll(): Promise<ElementGroupsResponse> {
    return this.get.execute();
  }

  /** Replaces one element's list; answers the whole map again (new version, unlinked groups). */
  @Put(':element')
  @ApiOkResponse({ schema: openApiSchema(ElementGroupsResponseSchema) })
  replaceOne(
    @Param('element', new ZodValidationPipe(ElementKeySchema)) element: ElementKey,
    @Body(new ZodValidationPipe(ReplaceElementGroupsRequestSchema))
    body: ReplaceElementGroupsRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ElementGroupsResponse> {
    return this.replace.execute({ element, actorId: actorIdOf(request), request: body });
  }
}
