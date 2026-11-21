import { SUPERVISOR_SITES_EVENT, type SupervisorWithSites } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import type { DomainEventInput } from '../../../common/event-log.port.js';
import type { SupervisorSitesRepository } from '../domain/supervisor-sites.js';
import {
  ListSupervisorSitesUseCase,
  ReplaceSupervisorSitesUseCase,
} from './supervisor-sites.use-cases.js';

const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';
const ACTOR = '99999999-9999-4999-8999-999999999999';
const SITE_A = '44444444-4444-4444-8444-444444444444';
const SITE_B = '55555555-5555-4555-8555-555555555555';
const FOREIGN = '66666666-6666-4666-8666-666666666666';

function fake(held: string[], isSupervisor = true) {
  const state = { held: [...held] };
  const events: DomainEventInput[] = [];
  const repo: SupervisorSitesRepository = {
    listSites: async () => [
      { siteId: SITE_A, name: 'A', workOrderId: PROJECT, workOrderNumber: 'WO-1' },
      { siteId: SITE_B, name: 'B', workOrderId: PROJECT, workOrderNumber: 'WO-1' },
    ],
    listSupervisors: async () => [supervisor(state.held)],
    lockSupervisorAssignments: async () => undefined,
    findSupervisor: async () => (isSupervisor ? supervisor(state.held) : null),
    existingSiteIds: async (_project, ids) => ids.filter((id) => id !== FOREIGN),
    replace: async (_project, _user, ids) => {
      state.held = [...ids];
    },
  };
  const replace = new ReplaceSupervisorSitesUseCase({
    run: (work) => work({ sites: repo, events: { append: async (e) => void events.push(e) } }),
  });
  return { state, events, repo, replace };
}

const supervisor = (siteIds: string[]): SupervisorWithSites => ({
  userId: USER,
  displayName: 'S',
  email: 's@example.test',
  isActive: true,
  siteIds,
});

describe('ReplaceSupervisorSitesUseCase', () => {
  it('replaces his sites and writes one event with before and after', async () => {
    const { replace, state, events } = fake([SITE_A]);
    const result = await replace.execute(
      { projectId: PROJECT, userId: USER, siteIds: [SITE_B] },
      ACTOR,
    );
    expect(result.siteIds).toEqual([SITE_B]);
    expect(state.held).toEqual([SITE_B]);
    expect(events).toEqual([
      {
        projectId: PROJECT,
        entity: 'supervisor_sites',
        entityId: USER,
        type: SUPERVISOR_SITES_EVENT,
        actorId: ACTOR,
        payload: { before: [SITE_A], after: [SITE_B] },
      },
    ]);
  });

  it('accepts an empty list (he then sees nothing)', async () => {
    const { replace, state } = fake([SITE_A]);
    await replace.execute({ projectId: PROJECT, userId: USER, siteIds: [] }, ACTOR);
    expect(state.held).toEqual([]);
  });

  it('404 when the user is not a supervisor of the project', async () => {
    const { replace, events } = fake([], false);
    await expect(
      replace.execute({ projectId: PROJECT, userId: USER, siteIds: [] }, ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(events).toEqual([]);
  });

  it('422 when a site is not of the project, and nothing changes', async () => {
    const { replace, state, events } = fake([SITE_A]);
    await expect(
      replace.execute({ projectId: PROJECT, userId: USER, siteIds: [SITE_B, FOREIGN] }, ACTOR),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(state.held).toEqual([SITE_A]);
    expect(events).toEqual([]);
  });
});

describe('ListSupervisorSitesUseCase', () => {
  it('returns the sites and the supervisors', async () => {
    const { repo } = fake([SITE_A]);
    const result = await new ListSupervisorSitesUseCase(repo).execute(PROJECT);
    expect(result.sites.map((site) => site.siteId)).toEqual([SITE_A, SITE_B]);
    expect(result.supervisors).toEqual([supervisor([SITE_A])]);
  });
});
