import { DEFAULT_ELEMENT_GROUPS, ELEMENT_KEYS, EVENT_TYPES } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import {
  buildElementGroupsResponse,
  GetElementGroupsUseCase,
  ReplaceElementGroupsUseCase,
} from './element-groups.use-cases.js';
import type {
  ElementGroupAdmin,
  ElementGroupAdminTx,
  ElementGroupRow,
  UsedMainGroup,
} from './ports.js';

const seeded = (): ElementGroupRow[] =>
  ELEMENT_KEYS.map((element) => ({
    element,
    mains: [...DEFAULT_ELEMENT_GROUPS[element]],
    version: 1,
  }));

function setup(used: UsedMainGroup[] = []) {
  const rows = seeded();
  const events: unknown[] = [];
  const admin: ElementGroupAdmin = {
    list: async () => rows.map((row) => ({ ...row })),
    usedMainGroups: async () => used,
    run: (work) => {
      const tx: ElementGroupAdminTx = {
        lockElement: async (element) => {
          const row = rows.find((entry) => entry.element === element);
          return row ? { ...row, mains: [...row.mains] } : null;
        },
        replace: async ({ element, mains, version }) => {
          const row = rows.find((entry) => entry.element === element);
          if (row) Object.assign(row, { mains: [...mains], version });
        },
        appendEvent: async (event) => {
          events.push(event);
        },
      };
      return work(tx);
    },
  };
  const get = new GetElementGroupsUseCase(admin);
  const replace = new ReplaceElementGroupsUseCase(
    admin,
    { now: () => new Date('2026-11-25T10:00:00Z') },
    get,
  );
  return { get, replace, events, rows };
}

describe('buildElementGroupsResponse', () => {
  it('lists the main groups used by contract lines that no element offers, sorted, with counts', () => {
    const response = buildElementGroupsResponse(seeded(), [
      { main: 'حفر', lineCount: 4 },
      { main: 'زهرة', lineCount: 2 },
      { main: 'ألف', lineCount: 1 },
    ]);
    expect(response.unlinked).toEqual([
      { main: 'ألف', lineCount: 1 },
      { main: 'زهرة', lineCount: 2 },
    ]);
    expect(response.knownMains).toEqual(['ألف', 'حفر', 'زهرة']);
    expect(response.elements.map((entry) => entry.element)).toEqual([...ELEMENT_KEYS]);
  });

  it('has nothing unlinked when every used group is on some element', () => {
    const response = buildElementGroupsResponse(seeded(), [{ main: 'غرف', lineCount: 3 }]);
    expect(response.unlinked).toEqual([]);
  });
});

describe('ReplaceElementGroupsUseCase', () => {
  const actorId = '00000000-0000-4000-8000-000000000001';

  it('replaces the list, bumps the version and records the change as an event', async () => {
    const { replace, events } = setup([{ main: 'جديدة', lineCount: 2 }]);
    const response = await replace.execute({
      element: 'joint',
      actorId,
      request: { mains: ['لحام في الغرف', 'جديدة'], expectedVersion: 1 },
    });
    const joint = response.elements.find((entry) => entry.element === 'joint');
    expect(joint).toEqual({ element: 'joint', mains: ['لحام في الغرف', 'جديدة'], version: 2 });
    expect(response.unlinked).toEqual([]);
    expect(events).toEqual([
      {
        projectId: null,
        entity: 'element_groups',
        entityId: 'joint',
        type: EVENT_TYPES.elementGroupsChanged,
        actorId,
        payload: {
          element: 'joint',
          before: ['لحام في الغرف'],
          after: ['لحام في الغرف', 'جديدة'],
          version: 2,
        },
      },
    ]);
  });

  it('answers a conflict with the current version on a stale version', async () => {
    const { replace, events } = setup();
    await expect(
      replace.execute({ element: 'box', actorId, request: { mains: [], expectedVersion: 5 } }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'STALE_VERSION', currentVersion: 1 },
    });
    expect(events).toEqual([]);
  });

  it('answers not found when the row is missing', async () => {
    const { replace, rows } = setup();
    rows.splice(0, rows.length);
    await expect(
      replace.execute({ element: 'box', actorId, request: { mains: [], expectedVersion: 1 } }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
