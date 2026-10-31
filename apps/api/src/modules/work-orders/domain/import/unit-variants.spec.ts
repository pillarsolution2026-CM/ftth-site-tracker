import type { ImportPreviewRow } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { annotateUnitVariants, collapseWhitespace } from './import-summary.js';

const row = (
  rowNumber: number,
  unit: string | null,
  kind: 'item' | 'heading' = 'item',
): ImportPreviewRow => ({
  rowNumber,
  kind,
  raw: {
    code: String(rowNumber),
    description: 'd',
    unit,
    quantity: null,
    unitPrice: null,
    workType: null,
    amount: null,
  },
  code: String(rowNumber),
  description: 'd',
  unit,
  quantity: null,
  unitPrice: null,
  workType: null,
  sheetAmount: null,
  amount: null,
  issues: [],
});

const variantOf = (rows: ImportPreviewRow[], rowNumber: number) =>
  rows.find((r) => r.rowNumber === rowNumber)?.issues.find((i) => i.code === 'UNIT_FORM_VARIANT');

describe('collapseWhitespace', () => {
  it('collapses spaces, tabs, line breaks and no-break spaces and trims', () => {
    expect(collapseWhitespace('  a \t b\n\n c  d  ')).toBe('a b c d');
  });
});

describe('annotateUnitVariants', () => {
  it('warns every row of a group whose raw forms differ, listing the other rows', () => {
    const rows = annotateUnitVariants([
      row(2, 'BULDING (1 to 8 unit/flat per building)'),
      row(3, 'م.ط'),
      row(4, 'BULDING\n(1 to 8 unit/flat per building)'),
      row(5, 'BULDING  (1 to 8 unit/flat per building)'),
    ]);
    expect(variantOf(rows, 2)).toEqual({
      code: 'UNIT_FORM_VARIANT',
      severity: 'warning',
      field: 'unit',
      params: { otherRows: '4,5' },
    });
    expect(variantOf(rows, 4)?.params).toEqual({ otherRows: '2,5' });
    expect(variantOf(rows, 5)?.params).toEqual({ otherRows: '2,4' });
    expect(variantOf(rows, 3)).toBeUndefined();
  });

  it('leaves identical forms, single rows, headings and empty units alone', () => {
    const rows = annotateUnitVariants([
      row(2, 'عدد'),
      row(3, 'عدد'),
      row(4, 'عدد\n', 'heading'),
      row(5, null),
      row(6, 'م.ط'),
    ]);
    expect(rows.flatMap((r) => r.issues)).toEqual([]);
  });

  it('treats a no-break space as a variant of a plain space', () => {
    const rows = annotateUnitVariants([row(2, 'a b'), row(3, 'a b')]);
    expect(variantOf(rows, 2)?.params).toEqual({ otherRows: '3' });
  });

  it('replaces earlier annotations instead of duplicating them', () => {
    const once = annotateUnitVariants([row(2, 'a b'), row(3, 'a  b')]);
    const twice = annotateUnitVariants(once);
    expect(twice.map((r) => r.issues.length)).toEqual([1, 1]);
  });
});
