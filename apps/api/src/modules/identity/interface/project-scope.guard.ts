import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../../common/app-error.js';
import type { ResolveProjectAccessUseCase } from '../application/resolve-project-access.use-case.js';
import { RESOLVE_PROJECT_ACCESS_USE_CASE } from '../identity.tokens.js';
import type { AuthenticatedRequest } from './auth-request.js';

/** Requires JwtAuthGuard first. Resolves membership for `:projectId` and stores it on the request. */
@Injectable()
export class ProjectScopeGuard implements CanActivate {
  constructor(
    @Inject(RESOLVE_PROJECT_ACCESS_USE_CASE)
    private readonly resolveAccess: ResolveProjectAccessUseCase,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) throw new AppError('TOKEN_INVALID', 'Authentication required');

    const projectId = z.uuid().safeParse(request.params.projectId);
    if (!projectId.success) {
      throw new AppError('VALIDATION_FAILED', 'projectId must be a UUID');
    }
    request.projectAccess = await this.resolveAccess.execute({
      userId: request.auth.sub,
      isAdmin: request.auth.isAdmin,
      projectId: projectId.data,
    });
    return true;
  }
}
