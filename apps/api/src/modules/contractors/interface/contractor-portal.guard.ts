import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/app-error.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import type {
  ContractorAccountContext,
  ContractorPortalRepository,
} from '../domain/contractor-account.js';
import { CONTRACTOR_PORTAL_REPOSITORY } from '../contractors.tokens.js';

/** Request enriched by ContractorAccountGuard. */
export interface ContractorPortalRequest extends AuthenticatedRequest {
  contractorAccount?: ContractorAccountContext;
}

/**
 * Requires JwtAuthGuard first. Lets only an ACTIVE contractor account through (re-read from the
 * database on every call, so a stopped account is refused at once, not when its token expires) and
 * stores its contractor id, the only source of the portal queries' filter. Everyone else: 403.
 */
@Injectable()
export class ContractorAccountGuard implements CanActivate {
  constructor(
    @Inject(CONTRACTOR_PORTAL_REPOSITORY) private readonly portal: ContractorPortalRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ContractorPortalRequest>();
    if (!request.auth) throw new AppError('TOKEN_INVALID', 'Authentication required');
    const account = await this.portal.findActiveAccount(request.auth.sub);
    if (!account) throw new AppError('FORBIDDEN', 'Contractor accounts only');
    request.contractorAccount = account;
    return true;
  }
}
