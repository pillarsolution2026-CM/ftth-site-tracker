import { describe, expect, it } from 'vitest';
import { InMemoryMemberships, InMemoryUsers, makeUser } from '../testing/in-memory.js';
import { GetMeUseCase } from './get-me.use-case.js';

const P1 = '22222222-2222-4222-8222-222222222222';
const Z1 = '44444444-4444-4444-8444-444444444444';

describe('GetMeUseCase', () => {
  it('aggregates zones per (project, role) and leaves project-wide roles empty', async () => {
    const user = makeUser();
    const useCase = new GetMeUseCase(
      new InMemoryUsers([user]),
      new InMemoryMemberships([
        { userId: user.id, projectId: P1, projectName: 'P1', role: 'supervisor', zoneId: Z1 },
        { userId: user.id, projectId: P1, projectName: 'P1', role: 'pm', zoneId: Z1 },
      ]),
    );

    const me = await useCase.execute(user.id);

    expect(me.memberships).toEqual([
      { projectId: P1, projectName: 'P1', role: 'supervisor', zoneIds: [Z1] },
      { projectId: P1, projectName: 'P1', role: 'pm', zoneIds: [] },
    ]);
  });

  it('rejects an unknown or inactive account with TOKEN_INVALID', async () => {
    const user = makeUser({ isActive: false });
    const useCase = new GetMeUseCase(new InMemoryUsers([user]), new InMemoryMemberships());

    await expect(useCase.execute(user.id)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });
});
