import { describe, expect, it } from 'vitest';
import {
  InMemoryContractorAccounts,
  InMemoryMemberships,
  InMemoryUsers,
  makeUser,
} from '../testing/in-memory.js';
import { GetMeUseCase } from './get-me.use-case.js';

const P1 = '22222222-2222-4222-8222-222222222222';
const S1 = '44444444-4444-4444-8444-444444444444';
const S2 = '55555555-5555-4555-8555-555555555555';

describe('GetMeUseCase', () => {
  it('aggregates sites per (project, role) and leaves project-wide roles empty', async () => {
    const user = makeUser();
    const useCase = new GetMeUseCase(
      new InMemoryUsers([user]),
      new InMemoryMemberships([
        { userId: user.id, projectId: P1, projectName: 'P1', role: 'supervisor', siteIds: [S1] },
        {
          userId: user.id,
          projectId: P1,
          projectName: 'P1',
          role: 'supervisor',
          siteIds: [S1, S2],
        },
        { userId: user.id, projectId: P1, projectName: 'P1', role: 'pm', siteIds: [S1] },
      ]),
      new InMemoryContractorAccounts(),
    );

    const me = await useCase.execute(user.id);

    expect(me.memberships).toEqual([
      { projectId: P1, projectName: 'P1', role: 'supervisor', zoneIds: [], siteIds: [S1, S2] },
      { projectId: P1, projectName: 'P1', role: 'pm', zoneIds: [], siteIds: [] },
    ]);
    expect(me.contractor).toBeNull();
  });

  it('returns the contractor of a contractor account and no memberships', async () => {
    const user = makeUser();
    const useCase = new GetMeUseCase(
      new InMemoryUsers([user]),
      new InMemoryMemberships([
        { userId: user.id, projectId: P1, projectName: 'P1', role: 'supervisor', siteIds: [S1] },
      ]),
      new InMemoryContractorAccounts(new Map([[user.id, { id: P1, name: 'Acme Works' }]])),
    );

    const me = await useCase.execute(user.id);

    expect(me.contractor).toEqual({ id: P1, name: 'Acme Works' });
    expect(me.memberships).toEqual([]);
  });

  it('rejects an unknown or inactive account with TOKEN_INVALID', async () => {
    const user = makeUser({ isActive: false });
    const useCase = new GetMeUseCase(
      new InMemoryUsers([user]),
      new InMemoryMemberships(),
      new InMemoryContractorAccounts(),
    );

    await expect(useCase.execute(user.id)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });
});
