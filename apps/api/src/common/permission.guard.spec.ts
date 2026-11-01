import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { PermissionGuard, RequirePermission } from './permission.guard.js';

class Handlers {
  @RequirePermission('work_orders:read')
  read(): void {}

  @RequirePermission('work_orders:write')
  write(): void {}

  @RequirePermission('cad_files:write')
  cadWrite(): void {}

  @RequirePermission('execution:write', 'asbuilt:write')
  either(): void {}

  undeclared(): void {}
}

const guard = new PermissionGuard(new Reflector());
const proto = Handlers.prototype;

function contextFor(
  handler: () => void,
  request: { auth?: { isAdmin: boolean }; projectAccess?: { roles: Role[] } },
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
const member = (...roles: Role[]) => ({ auth: { isAdmin: false }, projectAccess: { roles } });

describe('PermissionGuard', () => {
  it.each<[Role, boolean, boolean]>([
    // role, may read, may write
    ['admin', true, true],
    ['pm', true, true],
    ['qc', true, false],
    ['supervisor', true, false],
    ['contractor', false, false],
  ])('%s: read=%s write=%s', (role, mayRead, mayWrite) => {
    const attempt = (handler: () => void) => () =>
      guard.canActivate(contextFor(handler, member(role)));
    if (mayRead) expect(attempt(proto.read)()).toBe(true);
    else expect(attempt(proto.read)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    if (mayWrite) expect(attempt(proto.write)()).toBe(true);
    else expect(attempt(proto.write)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('allows when any of several roles grants it', () => {
    expect(guard.canActivate(contextFor(proto.write, member('supervisor', 'pm')))).toBe(true);
  });

  it('with several permissions allows a member who holds any one of them', () => {
    expect(guard.canActivate(contextFor(proto.either, member('supervisor')))).toBe(true);
    expect(guard.canActivate(contextFor(proto.either, member('pm')))).toBe(true);
    expect(() => guard.canActivate(contextFor(proto.either, member('qc')))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('always allows a platform admin, even without a project assignment', () => {
    expect(guard.canActivate(contextFor(proto.cadWrite, { auth: { isAdmin: true } }))).toBe(true);
  });

  it('denies when the project scope was never resolved', () => {
    expect(() => guard.canActivate(contextFor(proto.read, { auth: { isAdmin: false } }))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('fails closed on a route that declares no permission', () => {
    expect(() => guard.canActivate(contextFor(proto.undeclared, member('pm')))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});
