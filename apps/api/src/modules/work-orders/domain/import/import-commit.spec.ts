import type { ColumnMapping } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { selectRowsForCommit } from './import-commit.js';
import { parseImport } from './import-parser.js';
import type { RawCell, RawWorkbook } from './raw-workbook.js';

const text = (value: string): RawCell => ({ kind: 'text', value });
const num = (value: number): RawCell => ({ kind: 'number', value });

const mapping: ColumnMapping = {
  code: 0,
  description: 1,
  unit: 2,
  quantity: 3,
  unitPrice: 4,
  workType: 5,
  amount: null,
};

function workbook(rows: RawCell[][]): RawWorkbook {
  const header = ['Code', 'Description', 'Unit', 'Quantity', 'Unit Price', 'Work Type'].map(text);
  return { sheets: [{ name: 'S', rows: new Map([header, ...rows].map((r, i) => [i + 1, r])) }] };
}
const row = (code: string, quantity: number | string = 1): RawCell[] => [
  text(code),
  text('d'),
  text('m'),
  typeof quantity === 'number' ? num(quantity) : text(quantity),
  num(2),
  text('مدني'),
];
const select = (rows: RawCell[][], payload: { excluded?: number[]; accepted?: string[] } = {}) =>
  selectRowsForCommit(parseImport(workbook(rows), { headerRow: 1, mapping }), {
    excludedRowNumbers: payload.excluded ?? [],
    acceptedDuplicateCodes: payload.accepted ?? [],
  });

describe('selectRowsForCommit', () => {
  it('turns clean rows into items that remember their sheet row', () => {
    const result = select([row('A'), row('B', 3)]);
    expect(result).toMatchObject({ ok: true, excludedCount: 0 });
    if (!result.ok) return;
    expect(
      result.lines.flatMap((i) =>
        i.kind === 'item' ? [[i.code, i.quantity.toString(), i.sourceRow]] : [],
      ),
    ).toEqual([
      ['A', '1', 2],
      ['B', '3', 3],
    ]);
  });

  it('refuses rows with errors unless they are excluded', () => {
    const rows = [row('A'), row('B', 'abc')];
    expect(select(rows)).toMatchObject({
      ok: false,
      details: {
        reason: 'ROW_ERRORS',
        rows: [{ rowNumber: 3, issues: [expect.objectContaining({ code: 'INVALID_NUMBER' })] }],
      },
    });
    expect(select(rows, { excluded: [3] })).toMatchObject({ ok: true, excludedCount: 1 });
  });

  it('refuses unresolved duplicates, accepts them explicitly, or lets exclusion resolve them', () => {
    const rows = [row('A'), row('A', 2), row('B')];
    expect(select(rows)).toMatchObject({
      ok: false,
      details: { reason: 'UNRESOLVED_DUPLICATES', duplicateCodes: ['A'] },
    });
    expect(select(rows, { accepted: ['A'] })).toMatchObject({ ok: true });
    expect(select(rows, { excluded: [3] })).toMatchObject({ ok: true });
  });

  it('refuses an import with no included rows', () => {
    expect(select([row('A')], { excluded: [2] })).toMatchObject({
      ok: false,
      details: { reason: 'NO_ROWS_INCLUDED' },
    });
  });

  it('refuses when the file itself has issues', () => {
    const result = selectRowsForCommit(
      parseImport(workbook([row('A')]), { headerRow: 1, mapping: { ...mapping, unit: null } }),
      { excludedRowNumbers: [], acceptedDuplicateCodes: [] },
    );
    expect(result).toMatchObject({
      ok: false,
      details: {
        reason: 'FILE_ISSUES',
        fileIssues: [{ code: 'REQUIRED_FIELD_UNMAPPED', field: 'unit' }],
      },
    });
  });
});
