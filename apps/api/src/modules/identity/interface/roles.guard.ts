import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { AuthenticatedRequest } from './auth-request.js';

const ROLES_KEY = 'roles';

/** Restricts a route to the given roles within the project resolved by ProjectScopeGuard. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.auth?.isAdmin) return true;
    if (request.projectAccess?.roles.some((role) => required.includes(role))) return true;
    throw new AppError('FORBIDDEN', 'Your role does not allow this action');
  }
}
