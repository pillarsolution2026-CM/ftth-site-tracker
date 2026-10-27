import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedRequest } from './auth-request.js';
import { Roles, RolesGuard } from './roles.guard.js';

class Handlers {
  @Roles('pm', 'qc')
  restricted(): void {}

  open(): void {}
}

function contextFor(handler: () => void, request: Partial<AuthenticatedRequest>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const guard = new RolesGuard(new Reflector());
const proto = Handlers.prototype;
const access = (roles: Array<'pm' | 'supervisor'>) => ({
  projectId: 'p',
  roles,
  scope: { kind: 'project' as const },
});

describe('RolesGuard', () => {
  it('allows routes without @Roles', () => {
    expect(guard.canActivate(contextFor(proto.open, {}))).toBe(true);
  });

  it('allows a member with a listed role', () => {
    const request = { auth: { sub: 'u', isAdmin: false }, projectAccess: access(['pm']) };
    expect(guard.canActivate(contextFor(proto.restricted, request))).toBe(true);
  });

  it('rejects a member with another role', () => {
    const request = { auth: { sub: 'u', isAdmin: false }, projectAccess: access(['supervisor']) };
    expect(() => guard.canActivate(contextFor(proto.restricted, request))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('always allows a platform admin', () => {
    const request = { auth: { sub: 'u', isAdmin: true } };
    expect(guard.canActivate(contextFor(proto.restricted, request))).toBe(true);
  });
});
