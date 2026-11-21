import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  ContractorAccountListResponseSchema,
  ContractorAccountSchema,
  CreateContractorAccountRequestSchema,
  UpdateContractorAccountRequestSchema,
  type ContractorAccount,
  type ContractorAccountListResponse,
  type CreateContractorAccountRequest,
  type UpdateContractorAccountRequest,
} from '@ftth/shared';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { PlatformAdminGuard } from '../../identity/interface/platform-admin.guard.js';
import {
  CreateContractorAccountUseCase,
  ListContractorAccountsUseCase,
  SetContractorAccountActiveUseCase,
} from '../application/contractor-account.use-cases.js';
import { ContractorAccountCreateRateLimitGuard } from './contractor-account-rate-limit.guard.js';
import type { ContractorAccountRecord } from '../domain/contractor-account.js';

const toDto = (account: ContractorAccountRecord): ContractorAccount => ({
  userId: account.userId,
  email: account.email,
  displayName: account.displayName,
  locale: account.locale,
  isActive: account.isActive,
  createdAt: account.createdAt.toISOString(),
});

/**
 * Login accounts of a registered contractor (ADR-053). Platform admin only; the registration must
 * belong to the project in the URL (404 otherwise).
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/projects/:projectId/contractors/:registrationId/accounts')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class ContractorAccountsController {
  constructor(
    @Inject(ListContractorAccountsUseCase) private readonly list: ListContractorAccountsUseCase,
    @Inject(CreateContractorAccountUseCase) private readonly create: CreateContractorAccountUseCase,
    @Inject(SetContractorAccountActiveUseCase)
    private readonly setActive: SetContractorAccountActiveUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ schema: openApiSchema(ContractorAccountListResponseSchema) })
  async getAll(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Param('registrationId', UuidParamPipe) registrationId: string,
  ): Promise<ContractorAccountListResponse> {
    const result = await this.list.execute({ projectId, registrationId });
    return { contractorId: result.contractorId, items: result.items.map(toDto) };
  }

  @Post()
  @UseGuards(ContractorAccountCreateRateLimitGuard)
  @ApiCreatedResponse({ schema: openApiSchema(ContractorAccountSchema) })
  async createOne(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Param('registrationId', UuidParamPipe) registrationId: string,
    @Body(new ZodValidationPipe(CreateContractorAccountRequestSchema))
    body: CreateContractorAccountRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ContractorAccount> {
    const created = await this.create.execute(
      { projectId, registrationId, request: body },
      actorIdOf(request),
    );
    return toDto(created);
  }

  @Patch(':userId')
  @ApiOkResponse({ schema: openApiSchema(ContractorAccountSchema) })
  async updateOne(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Param('registrationId', UuidParamPipe) registrationId: string,
    @Param('userId', UuidParamPipe) userId: string,
    @Body(new ZodValidationPipe(UpdateContractorAccountRequestSchema))
    body: UpdateContractorAccountRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ContractorAccount> {
    const updated = await this.setActive.execute(
      { projectId, registrationId, userId, request: body },
      actorIdOf(request),
    );
    return toDto(updated);
  }
}
