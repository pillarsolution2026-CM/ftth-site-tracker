import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  ContractorListResponseSchema,
  ContractorSchema,
  CreateContractorRequestSchema,
  UpdateContractorRequestSchema,
  type Contractor,
  type ContractorListResponse,
  type CreateContractorRequest,
  type UpdateContractorRequest,
} from '@ftth/shared';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { PlatformAdminGuard } from '../../identity/interface/platform-admin.guard.js';
import { GetContractorUseCase, ListContractorsUseCase } from '../application/contractor-queries.js';
import {
  CreateContractorUseCase,
  UpdateContractorUseCase,
} from '../application/contractor.use-cases.js';
import { toContractorDto } from './contractor.presenter.js';

/** Platform-admin only (ADR-036): the shared list of subcontractors. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/contractors')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminContractorsController {
  constructor(
    @Inject(ListContractorsUseCase) private readonly list: ListContractorsUseCase,
    @Inject(GetContractorUseCase) private readonly get: GetContractorUseCase,
    @Inject(CreateContractorUseCase) private readonly create: CreateContractorUseCase,
    @Inject(UpdateContractorUseCase) private readonly update: UpdateContractorUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ schema: openApiSchema(ContractorListResponseSchema) })
  async listAll(): Promise<ContractorListResponse> {
    return { items: (await this.list.execute()).map(toContractorDto) };
  }

  @Post()
  @ApiCreatedResponse({ schema: openApiSchema(ContractorSchema) })
  async createOne(
    @Body(new ZodValidationPipe(CreateContractorRequestSchema)) body: CreateContractorRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<Contractor> {
    return toContractorDto(
      await this.create.execute({ actorId: actorIdOf(request), request: body }),
    );
  }

  @Get(':contractorId')
  @ApiOkResponse({ schema: openApiSchema(ContractorSchema) })
  async getOne(@Param('contractorId', UuidParamPipe) contractorId: string): Promise<Contractor> {
    return toContractorDto(await this.get.execute(contractorId));
  }

  @Patch(':contractorId')
  @ApiOkResponse({ schema: openApiSchema(ContractorSchema) })
  async updateOne(
    @Param('contractorId', UuidParamPipe) contractorId: string,
    @Body(new ZodValidationPipe(UpdateContractorRequestSchema)) body: UpdateContractorRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<Contractor> {
    return toContractorDto(
      await this.update.execute({ contractorId, actorId: actorIdOf(request), request: body }),
    );
  }
}
