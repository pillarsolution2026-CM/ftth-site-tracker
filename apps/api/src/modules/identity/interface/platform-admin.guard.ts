import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/app-error.js';
import type { UserRepository } from '../domain/user.js';
import { USER_REPOSITORY } from '../identity.tokens.js';
import type { AuthenticatedRequest } from './auth-request.js';

/**
 * Requires JwtAuthGuard first. Admin routes do not trust the token's `isAdmin` claim alone: the
 * user is re-read so a deactivated or demoted admin is refused at once, not after the token expires.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) throw new AppError('TOKEN_INVALID', 'Authentication required');
    if (!request.auth.isAdmin) throw new AppError('FORBIDDEN', 'Platform admins only');
    const user = await this.users.findById(request.auth.sub);
    if (!user || !user.isActive || !user.isAdmin) {
      throw new AppError('FORBIDDEN', 'Platform admins only');
    }
    return true;
  }
}
