import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import { planSiteReplacement, type WorkOrderSite } from '../domain/work-order-site.js';
import { readSitesSheet } from './work-order-sites.use-cases.js';

const now = new Date('2026-11-18T10:00:00Z');
let counter = 0;
const ids = { next: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` };

const site = (id: string, name: string, position: number): WorkOrderSite => ({
  id,
  workOrderId: 'wo',
  name,
  nameKey: name,
  position,
  createdById: null,
  createdAt: now,
  updatedAt: now,
});

describe('planSiteReplacement', () => {
  it('keeps unchanged sites, renames and reorders by id, adds new ones and removes the rest', () => {
    const current = [site('s1', 'a', 1), site('s2', 'b', 2), site('s3', 'c', 3)];
    const plan = planSiteReplacement({
      workOrderId: 'wo',
      current,
      requested: [{ id: 's1', name: 'a' }, { id: 's3', name: 'c2' }, { name: 'd' }],
      actorId: 'u',
      ids,
      now,
    });
    expect(plan.sites.map((s) => [s.name, s.position])).toEqual([
      ['a', 1],
      ['c2', 2],
      ['d', 3],
    ]);
    expect(plan.updated.map((s) => s.id)).toEqual(['s3']);
    expect(plan.inserted).toHaveLength(1);
    expect(plan.removed.map((s) => s.id)).toEqual(['s2']);
  });

  it('refuses an id that is not a site of the work order', () => {
    expect(() =>
      planSiteReplacement({
        workOrderId: 'wo',
        current: [],
        requested: [{ id: 'x', name: 'a' }],
        actorId: null,
        ids,
        now,
      }),
    ).toThrow(AppError);
  });
});

describe('readSitesSheet', () => {
  it('reads the first column that has text', () => {
    const rows = new Map([
      [2, [null, { kind: 'text' as const, value: 'المواقع' }]],
      [
        3,
        [null, { kind: 'text' as const, value: 'موقع 1' }, { kind: 'text' as const, value: 'x' }],
      ],
      [4, [null, { kind: 'number' as const, value: 7 }]],
    ]);
    expect(readSitesSheet({ name: 'S', rows })).toEqual({
      names: ['موقع 1', '7'],
      repeated: [],
      tooLongRows: [],
    });
  });

  it('returns no names for an empty sheet', () => {
    expect(readSitesSheet({ name: 'S', rows: new Map() }).names).toEqual([]);
  });
});
