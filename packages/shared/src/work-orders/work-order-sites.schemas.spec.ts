import { describe, expect, it } from 'vitest';
import {
  ReplaceWorkOrderSitesRequestSchema,
  repeatedSiteNames,
  siteKeyOf,
  siteNamesFromColumn,
} from './work-order-sites.schemas.js';

describe('siteKeyOf', () => {
  it('compares names after normalising spaces, case and Arabic letter forms', () => {
    expect(siteKeyOf('  أم   شيحان ')).toBe(siteKeyOf('ام شيحان'));
    expect(siteKeyOf('قرية الروضة')).toBe(siteKeyOf('قريه الروضه'));
    expect(siteKeyOf('Site A')).toBe(siteKeyOf('site  a'));
    expect(siteKeyOf('   ')).toBeNull();
  });
});

describe('repeatedSiteNames', () => {
  it('lists each repeated name once', () => {
    expect(repeatedSiteNames(['أ', 'ب', 'ا', 'آ', 'ج'])).toEqual(['ا']);
    expect(repeatedSiteNames(['a', 'b'])).toEqual([]);
  });
});

describe('ReplaceWorkOrderSitesRequestSchema', () => {
  it('accepts new and existing sites and collapses spaces', () => {
    const parsed = ReplaceWorkOrderSitesRequestSchema.parse({
      expectedVersion: 2,
      sites: [
        { name: '  موقع   1 ' },
        { id: '0b7f3b0e-8f7e-4d3a-9d1c-6c2f1e0a9b11', name: 'موقع 2' },
      ],
    });
    expect(parsed.sites.map((site) => site.name)).toEqual(['موقع 1', 'موقع 2']);
  });

  it('refuses a repeated name and a repeated id', () => {
    expect(
      ReplaceWorkOrderSitesRequestSchema.safeParse({
        expectedVersion: 1,
        sites: [{ name: 'أم شيحان' }, { name: 'ام شيحان' }],
      }).success,
    ).toBe(false);
    const id = '0b7f3b0e-8f7e-4d3a-9d1c-6c2f1e0a9b11';
    expect(
      ReplaceWorkOrderSitesRequestSchema.safeParse({
        expectedVersion: 1,
        sites: [
          { id, name: 'a' },
          { id, name: 'b' },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts an empty list (all sites removed)', () => {
    expect(
      ReplaceWorkOrderSitesRequestSchema.parse({ expectedVersion: 1, sites: [] }).sites,
    ).toEqual([]);
  });
});

describe('siteNamesFromColumn', () => {
  it('skips the header row and empty cells and drops repeats', () => {
    const result = siteNamesFromColumn([
      { row: 1, text: 'اسم الموقع' },
      { row: 2, text: 'موقع  أ' },
      { row: 3, text: null },
      { row: 4, text: 'موقع ب' },
      { row: 5, text: 'موقع ا' },
    ]);
    expect(result).toEqual({ names: ['موقع أ', 'موقع ب'], repeated: ['موقع ا'], tooLongRows: [] });
  });

  it('keeps a first row that is not a header', () => {
    expect(siteNamesFromColumn([{ row: 1, text: 'موقع 1' }]).names).toEqual(['موقع 1']);
  });

  it('reports names that are too long', () => {
    expect(siteNamesFromColumn([{ row: 7, text: 'x'.repeat(201) }]).tooLongRows).toEqual([7]);
  });
});
