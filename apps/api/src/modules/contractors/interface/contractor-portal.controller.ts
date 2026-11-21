import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ContractorPortalResponseSchema, type ContractorPortalResponse } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import { openApiSchema } from '../../../common/openapi.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { GetContractorPortalUseCase } from '../application/contractor-portal.use-case.js';
import { ContractorAccountGuard, type ContractorPortalRequest } from './contractor-portal.guard.js';

/** The contractor's own read-only view (ADR-053): only an active contractor account. */
@ApiTags('contractor')
@ApiBearerAuth()
@Controller('contractor')
@UseGuards(JwtAuthGuard, ContractorAccountGuard)
export class ContractorPortalController {
  constructor(
    @Inject(GetContractorPortalUseCase) private readonly portal: GetContractorPortalUseCase,
  ) {}

  @Get('me')
  @ApiOkResponse({ schema: openApiSchema(ContractorPortalResponseSchema) })
  me(@Req() request: ContractorPortalRequest): Promise<ContractorPortalResponse> {
    // ContractorAccountGuard guarantees `contractorAccount`.
    if (!request.contractorAccount) throw new AppError('FORBIDDEN', 'Contractor accounts only');
    return this.portal.execute(request.contractorAccount);
  }
}
