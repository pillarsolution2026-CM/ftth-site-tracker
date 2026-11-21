import { describe, expect, it } from 'vitest';
import { groupSitesByWorkOrder, sameSet } from './site-groups';

const site = (siteId: string, workOrderId: string, workOrderNumber: string) => ({
  siteId,
  name: siteId,
  workOrderId,
  workOrderNumber,
});

describe('site groups', () => {
  it('groups by work order in the order sent', () => {
    const groups = groupSitesByWorkOrder([
      site('a', 'w1', 'WO-1'),
      site('b', 'w2', 'WO-2'),
      site('c', 'w1', 'WO-1'),
    ]);
    expect(groups.map((g) => [g.workOrderNumber, g.sites.map((s) => s.siteId)])).toEqual([
      ['WO-1', ['a', 'c']],
      ['WO-2', ['b']],
    ]);
  });

  it('compares id sets regardless of order', () => {
    expect(sameSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameSet(['a'], ['a', 'b'])).toBe(false);
  });
});
