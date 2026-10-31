import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AddContractItemRequestSchema,
  ApproveContractRequestSchema,
  ContractDetailSchema,
  ContractListResponseSchema,
  CreateContractRequestSchema,
  RemoveContractItemQuerySchema,
  UpdateContractItemRequestSchema,
  UpdateContractRequestSchema,
  type AddContractItemRequest,
  type ApproveContractRequest,
  type ContractDetail,
  type ContractListResponse,
  type CreateContractRequest,
  type UpdateContractItemRequest,
  type UpdateContractRequest,
} from '@ftth/shared';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { PlatformAdminGuard } from '../../identity/interface/platform-admin.guard.js';
import { GetContractUseCase, ListContractsUseCase } from '../application/contract-queries.js';
import {
  AddContractItemUseCase,
  ApproveContractUseCase,
  CreateContractUseCase,
  RemoveContractItemUseCase,
  UpdateContractItemUseCase,
  UpdateContractUseCase,
} from '../application/contract.use-cases.js';
import { toDetailDto, toSummaryDto } from './contract.presenter.js';

/** Platform-admin only (ADR-027): contracts and their BOQ. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/contracts')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminContractsController {
  constructor(
    @Inject(ListContractsUseCase) private readonly list: ListContractsUseCase,
    @Inject(GetContractUseCase) private readonly get: GetContractUseCase,
    @Inject(CreateContractUseCase) private readonly create: CreateContractUseCase,
    @Inject(UpdateContractUseCase) private readonly update: UpdateContractUseCase,
    @Inject(AddContractItemUseCase) private readonly addItem: AddContractItemUseCase,
    @Inject(UpdateContractItemUseCase) private readonly updateItem: UpdateContractItemUseCase,
    @Inject(RemoveContractItemUseCase) private readonly removeItem: RemoveContractItemUseCase,
    @Inject(ApproveContractUseCase) private readonly approve: ApproveContractUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ schema: openApiSchema(ContractListResponseSchema) })
  async listAll(): Promise<ContractListResponse> {
    return { items: (await this.list.execute()).map(toSummaryDto) };
  }

  @Post()
  @ApiCreatedResponse({ schema: openApiSchema(ContractDetailSchema) })
  async createOne(
    @Body(new ZodValidationPipe(CreateContractRequestSchema)) body: CreateContractRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ContractDetail> {
    return toDetailDto(await this.create.execute({ actorId: actorIdOf(request), request: body }));
  }

  @Get(':contractId')
  @ApiOkResponse({ schema: openApiSchema(ContractDetailSchema) })
  async getOne(@Param('contractId', UuidParamPipe) contractId: string): Promise<ContractDetail> {
    return toDetailDto(await this.get.execute(contractId));
  }

  @Patch(':contractId')
  @ApiOkResponse({ schema: openApiSchema(ContractDetailSchema) })
  async updateOne(
    @Param('contractId', UuidParamPipe) contractId: string,
    @Body(new ZodValidationPipe(UpdateContractRequestSchema)) body: UpdateContractRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ContractDetail> {
    return toDetailDto(
      await this.update.execute({ contractId, actorId: actorIdOf(request), request: body }),
    );
  }

  @Post(':contractId/items')
  @ApiCreatedResponse({ schema: openApiSchema(ContractDetailSchema) })
  async addOneItem(
    @Param('contractId', UuidParamPipe) contractId: string,
    @Body(new ZodValidationPipe(AddContractItemRequestSchema)) body: AddContractItemRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ContractDetail> {
    return toDetailDto(
      await this.addItem.execute({ contractId, actorId: actorIdOf(request), request: body }),
    );
  }

  @Patch(':contractId/items/:itemId')
  @ApiOkResponse({ schema: openApiSchema(ContractDetailSchema) })
  async updateOneItem(
    @Param('contractId', UuidParamPipe) contractId: string,
    @Param('itemId', UuidParamPipe) itemId: string,
    @Body(new ZodValidationPipe(UpdateContractItemRequestSchema)) body: UpdateContractItemRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ContractDetail> {
    return toDetailDto(
      await this.updateItem.execute({
        contractId,
        itemId,
        actorId: actorIdOf(request),
        request: body,
      }),
    );
  }

  @Delete(':contractId/items/:itemId')
  @ApiOkResponse({ schema: openApiSchema(ContractDetailSchema) })
  async removeOneItem(
    @Param('contractId', UuidParamPipe) contractId: string,
    @Param('itemId', UuidParamPipe) itemId: string,
    @Query(new ZodValidationPipe(RemoveContractItemQuerySchema))
    query: { expectedVersion: number },
    @Req() request: AuthenticatedRequest,
  ): Promise<ContractDetail> {
    return toDetailDto(
      await this.removeItem.execute({
        contractId,
        itemId,
        actorId: actorIdOf(request),
        expectedVersion: query.expectedVersion,
      }),
    );
  }

  @Post(':contractId/approve')
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(ContractDetailSchema) })
  async approveOne(
    @Param('contractId', UuidParamPipe) contractId: string,
    @Body(new ZodValidationPipe(ApproveContractRequestSchema)) body: ApproveContractRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ContractDetail> {
    return toDetailDto(
      await this.approve.execute({ contractId, actorId: actorIdOf(request), request: body }),
    );
  }
}
