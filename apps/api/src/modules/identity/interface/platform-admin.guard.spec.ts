import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { InMemoryUsers, makeUser } from '../testing/in-memory.js';
import type { AuthenticatedRequest } from './auth-request.js';
import { PlatformAdminGuard } from './platform-admin.guard.js';

function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('PlatformAdminGuard', () => {
  const admin = makeUser({ isAdmin: true });
  const demoted = makeUser({ isAdmin: false });
  const inactive = makeUser({ isAdmin: true, isActive: false });
  const guard = new PlatformAdminGuard(new InMemoryUsers([admin, demoted, inactive]));
  const asAdmin = (sub: string) => contextFor({ auth: { sub, isAdmin: true } });

  it('lets an active admin through', async () => {
    await expect(guard.canActivate(asAdmin(admin.id))).resolves.toBe(true);
  });

  it('refuses a non-admin token without reading the database', async () => {
    await expect(
      guard.canActivate(contextFor({ auth: { sub: admin.id, isAdmin: false } })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses an admin token whose user was demoted, deactivated or deleted', async () => {
    for (const sub of [demoted.id, inactive.id, '00000000-0000-4000-8000-000000000000']) {
      await expect(guard.canActivate(asAdmin(sub))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('answers TOKEN_INVALID without authentication', async () => {
    await expect(guard.canActivate(contextFor({}))).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });
});
