import { describe, expect, it } from 'vitest';
import type { SharedCabinetsUnmatched } from '@ftth/shared';
import { hasUnmatched, UNMATCHED_LISTS } from './general-cabinets';

const empty: SharedCabinetsUnmatched = {
  onlyInSecondary: [],
  onlyInGeneral: [],
  duplicateInSecondary: [],
  duplicateInGeneral: [],
  unnamedSecondary: 0,
  unnamedGeneral: 0,
  withoutDrawingPosition: [],
  unusable: [],
  listCapped: false,
};

describe('general cabinets unmatched lists', () => {
  it('lists unusable cabinets and shows a capped read', () => {
    expect(UNMATCHED_LISTS).toContain('unusable');
    expect(hasUnmatched(empty)).toBe(false);
    expect(hasUnmatched({ ...empty, unusable: ['x'.repeat(200)] })).toBe(true);
    expect(hasUnmatched({ ...empty, listCapped: true })).toBe(true);
  });
});
