import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AddContractorLineRequestSchema,
  AddContractorPriceRequestSchema,
  ProjectContractorsResponseSchema,
  RegisterContractorRequestSchema,
  UpdateContractorLineRequestSchema,
  type AddContractorLineRequest,
  type AddContractorPriceRequest,
  type ProjectContractorsResponse,
  type RegisterContractorRequest,
  type UpdateContractorLineRequest,
} from '@ftth/shared';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { PlatformAdminGuard } from '../../identity/interface/platform-admin.guard.js';
import { GetProjectContractorsUseCase } from '../application/contractor-queries.js';
import {
  AddContractorLineUseCase,
  AddContractorPriceUseCase,
  RegisterContractorUseCase,
  RemoveContractorLineUseCase,
  RemoveRegistrationUseCase,
  UpdateContractorLineUseCase,
} from '../application/registration.use-cases.js';
import { toProjectContractorsDto } from './contractor.presenter.js';

/** Platform-admin only (ADR-036): contractors on a project's work order, their lines and prices. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/projects/:projectId/contractors')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminProjectContractorsController {
  constructor(
    @Inject(GetProjectContractorsUseCase) private readonly get: GetProjectContractorsUseCase,
    @Inject(RegisterContractorUseCase) private readonly register: RegisterContractorUseCase,
    @Inject(RemoveRegistrationUseCase)
    private readonly removeRegistration: RemoveRegistrationUseCase,
    @Inject(AddContractorLineUseCase) private readonly addLine: AddContractorLineUseCase,
    @Inject(UpdateContractorLineUseCase) private readonly updateLine: UpdateContractorLineUseCase,
    @Inject(RemoveContractorLineUseCase) private readonly removeLine: RemoveContractorLineUseCase,
    @Inject(AddContractorPriceUseCase) private readonly addPrice: AddContractorPriceUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ schema: openApiSchema(ProjectContractorsResponseSchema) })
  async getAll(
    @Param('projectId', UuidParamPipe) projectId: string,
  ): Promise<ProjectContractorsResponse> {
    return toProjectContractorsDto(await this.get.execute(projectId));
  }

  @Post()
  @ApiCreatedResponse({ schema: openApiSchema(ProjectContractorsResponseSchema) })
  async registerOne(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Body(new ZodValidationPipe(RegisterContractorRequestSchema)) body: RegisterContractorRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectContractorsResponse> {
    return toProjectContractorsDto(
      await this.register.execute({ projectId, actorId: actorIdOf(request), request: body }),
    );
  }

  @Delete(':registrationId')
  @ApiOkResponse({ schema: openApiSchema(ProjectContractorsResponseSchema) })
  async removeOne(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Param('registrationId', UuidParamPipe) registrationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectContractorsResponse> {
    return toProjectContractorsDto(
      await this.removeRegistration.execute({
        projectId,
        registrationId,
        actorId: actorIdOf(request),
      }),
    );
  }

  @Post(':registrationId/lines')
  @ApiCreatedResponse({ schema: openApiSchema(ProjectContractorsResponseSchema) })
  async addOneLine(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Param('registrationId', UuidParamPipe) registrationId: string,
    @Body(new ZodValidationPipe(AddContractorLineRequestSchema)) body: AddContractorLineRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectContractorsResponse> {
    return toProjectContractorsDto(
      await this.addLine.execute({
        projectId,
        registrationId,
        actorId: actorIdOf(request),
        request: body,
      }),
    );
  }

  @Patch(':registrationId/lines/:lineId')
  @ApiOkResponse({ schema: openApiSchema(ProjectContractorsResponseSchema) })
  async updateOneLine(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Param('registrationId', UuidParamPipe) registrationId: string,
    @Param('lineId', UuidParamPipe) lineId: string,
    @Body(new ZodValidationPipe(UpdateContractorLineRequestSchema))
    body: UpdateContractorLineRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectContractorsResponse> {
    return toProjectContractorsDto(
      await this.updateLine.execute({
        projectId,
        registrationId,
        lineId,
        actorId: actorIdOf(request),
        request: body,
      }),
    );
  }

  @Delete(':registrationId/lines/:lineId')
  @ApiOkResponse({ schema: openApiSchema(ProjectContractorsResponseSchema) })
  async removeOneLine(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Param('registrationId', UuidParamPipe) registrationId: string,
    @Param('lineId', UuidParamPipe) lineId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectContractorsResponse> {
    return toProjectContractorsDto(
      await this.removeLine.execute({
        projectId,
        registrationId,
        lineId,
        actorId: actorIdOf(request),
      }),
    );
  }

  @Post(':registrationId/lines/:lineId/prices')
  @ApiCreatedResponse({ schema: openApiSchema(ProjectContractorsResponseSchema) })
  async addOnePrice(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Param('registrationId', UuidParamPipe) registrationId: string,
    @Param('lineId', UuidParamPipe) lineId: string,
    @Body(new ZodValidationPipe(AddContractorPriceRequestSchema)) body: AddContractorPriceRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectContractorsResponse> {
    return toProjectContractorsDto(
      await this.addPrice.execute({
        projectId,
        registrationId,
        lineId,
        actorId: actorIdOf(request),
        request: body,
      }),
    );
  }
}
