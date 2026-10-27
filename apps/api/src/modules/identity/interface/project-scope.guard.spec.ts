import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ResolveProjectAccessUseCase } from '../application/resolve-project-access.use-case.js';
import { InMemoryMemberships } from '../testing/in-memory.js';
import type { AuthenticatedRequest } from './auth-request.js';
import { ProjectScopeGuard } from './project-scope.guard.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PROJECT_A = '22222222-2222-4222-8222-222222222222';
const PROJECT_B = '33333333-3333-4333-8333-333333333333';
const ZONE_1 = '44444444-4444-4444-8444-444444444444';
const ZONE_2 = '55555555-5555-4555-8555-555555555555';

function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function guardWith(rows: ConstructorParameters<typeof InMemoryMemberships>[0]) {
  return new ProjectScopeGuard(new ResolveProjectAccessUseCase(new InMemoryMemberships(rows)));
}

function requestFor(projectId: string, isAdmin = false): Partial<AuthenticatedRequest> {
  return { auth: { sub: USER, isAdmin }, params: { projectId } };
}

describe('ProjectScopeGuard', () => {
  it('allows a member and exposes role and zones on the request', async () => {
    const guard = guardWith([
      { userId: USER, projectId: PROJECT_A, projectName: 'A', role: 'supervisor', zoneId: ZONE_1 },
      { userId: USER, projectId: PROJECT_A, projectName: 'A', role: 'supervisor', zoneId: ZONE_2 },
    ]);
    const request = requestFor(PROJECT_A);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.projectAccess).toEqual({
      projectId: PROJECT_A,
      roles: ['supervisor'],
      zoneIds: [ZONE_1, ZONE_2],
    });
  });

  it('gives project-wide roles an empty zone list', async () => {
    const guard = guardWith([
      { userId: USER, projectId: PROJECT_A, projectName: 'A', role: 'pm', zoneId: null },
    ]);
    const request = requestFor(PROJECT_A);

    await guard.canActivate(contextFor(request));
    expect(request.projectAccess?.zoneIds).toEqual([]);
  });

  it('rejects a non-member with FORBIDDEN', async () => {
    const guard = guardWith([
      { userId: USER, projectId: PROJECT_A, projectName: 'A', role: 'pm', zoneId: null },
    ]);

    await expect(guard.canActivate(contextFor(requestFor(PROJECT_B)))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('does not leak other users memberships', async () => {
    const guard = guardWith([
      { userId: 'someone-else', projectId: PROJECT_A, projectName: 'A', role: 'pm', zoneId: null },
    ]);

    await expect(guard.canActivate(contextFor(requestFor(PROJECT_A)))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('lets a platform admin through without an assignment', async () => {
    const guard = guardWith([]);
    const request = requestFor(PROJECT_B, true);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.projectAccess?.roles).toEqual(['admin']);
  });

  it('rejects a malformed projectId with VALIDATION_FAILED', async () => {
    const guard = guardWith([]);

    await expect(guard.canActivate(contextFor(requestFor('not-a-uuid')))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects when JwtAuthGuard has not run', async () => {
    const guard = guardWith([]);

    await expect(
      guard.canActivate(contextFor({ params: { projectId: PROJECT_A } })),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });
});
