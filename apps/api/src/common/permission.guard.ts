import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasPermission, type Permission, type Role } from '@ftth/shared';
import { AppError } from './app-error.js';

const PERMISSION_KEY = 'required_permission';

/** Restricts a route to members whose role grants `permission`. Use after JwtAuthGuard and ProjectScopeGuard. */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);

/** The parts of the authenticated request this guard reads (set by JwtAuthGuard / ProjectScopeGuard). */
interface PermissionRequest {
  auth?: { isAdmin: boolean };
  projectAccess?: { roles: readonly Role[] };
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Fail closed: a route that uses this guard must declare what it needs.
    if (!required) throw new AppError('FORBIDDEN', 'No permission declared for this route');

    const request = context.switchToHttp().getRequest<PermissionRequest>();
    if (request.auth?.isAdmin) return true;
    if (request.projectAccess && hasPermission(request.projectAccess.roles, required)) return true;
    throw new AppError('FORBIDDEN', 'Your role does not allow this action');
  }
}
