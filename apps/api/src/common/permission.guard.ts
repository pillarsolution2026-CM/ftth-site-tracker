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

/**
 * Restricts a route to members whose role grants `permission`. With several permissions the
 * route is open to a member who holds any one of them (e.g. the sync push accepts both kinds of
 * operation, and each operation is then checked against its own permission). Use after
 * JwtAuthGuard and ProjectScopeGuard.
 */
export const RequirePermission = (permission: Permission, ...alternatives: Permission[]) =>
  SetMetadata(PERMISSION_KEY, [permission, ...alternatives]);

/** The parts of the authenticated request this guard reads (set by JwtAuthGuard / ProjectScopeGuard). */
interface PermissionRequest {
  auth?: { isAdmin: boolean };
  projectAccess?: { roles: readonly Role[] };
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Fail closed: a route that uses this guard must declare what it needs.
    if (!required || required.length === 0) {
      throw new AppError('FORBIDDEN', 'No permission declared for this route');
    }

    const request = context.switchToHttp().getRequest<PermissionRequest>();
    if (request.auth?.isAdmin) return true;
    const roles = request.projectAccess?.roles;
    if (roles && required.some((permission) => hasPermission(roles, permission))) return true;
    throw new AppError('FORBIDDEN', 'Your role does not allow this action');
  }
}
