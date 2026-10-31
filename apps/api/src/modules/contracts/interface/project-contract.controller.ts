import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ContractDetailSchema, type ContractDetail } from '@ftth/shared';
import { ProjectIdParam } from '../../../common/http/params.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import { GetProjectContractUseCase } from '../application/contract-queries.js';
import { toDetailDto } from './contract.presenter.js';

/** The contract of the project, read-only; admin and pm only (`contract:read`, owner). */
@ApiTags('contracts')
@ApiBearerAuth()
@Controller('projects/:projectId/contract')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class ProjectContractController {
  constructor(
    @Inject(GetProjectContractUseCase) private readonly getContract: GetProjectContractUseCase,
  ) {}

  @Get()
  @RequirePermission('contract:read')
  @ApiOkResponse({ schema: openApiSchema(ContractDetailSchema) })
  async get(@ProjectIdParam() projectId: string): Promise<ContractDetail> {
    return toDetailDto(await this.getContract.execute(projectId));
  }
}
