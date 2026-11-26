import { describe, expect, it } from 'vitest';
import {
  cellAt,
  cellRects,
  DEFAULT_TABLE_SPEC,
  nextCell,
  rowCount,
  rowHeight,
  specProblem,
  tableAt,
  tableBox,
  tableInWindow,
} from './table';

describe('TABLE (Insert Table dialog, Standard style)', () => {
  it('defaults as AutoCAD: 5 columns of 63.5, 1 data row, Title / Header / Data', () => {
    expect(DEFAULT_TABLE_SPEC).toMatchObject({
      columns: 5,
      columnWidth: 63.5,
      dataRows: 1,
      rowLines: 1,
      styles: ['title', 'header', 'data'],
    });
    // Title and header rows come on top of the data rows.
    expect(rowCount(DEFAULT_TABLE_SPEC)).toBe(3);
    expect(rowCount({ dataRows: 4, styles: ['data', 'data', 'data'] })).toBe(4);
    expect(rowHeight('data', 4.5, 1)).toBeCloseTo(9);
    expect(rowHeight('title', 4.5, 1)).toBeGreaterThan(rowHeight('data', 4.5, 1));
  });
  it('a table at its top-left insertion point, empty cells', () => {
    const table = tableAt(DEFAULT_TABLE_SPEC, [10, 100]);
    expect(table.columns).toHaveLength(5);
    expect(table.cells).toEqual([
      ['', '', '', '', ''],
      ['', '', '', '', ''],
      ['', '', '', '', ''],
    ]);
    const box = tableBox(table);
    expect(box.minX).toBe(10);
    expect(box.maxY).toBe(100);
    expect(box.maxX).toBeCloseTo(10 + 5 * 63.5);
  });
  it('a window shares its width among the columns', () => {
    const table = tableInWindow({ ...DEFAULT_TABLE_SPEC, columns: 4 }, [0, 0], [100, 50]);
    expect(table.x).toBe(0);
    expect(table.y).toBe(50);
    expect(table.columns).toEqual([25, 25, 25, 25]);
  });
  it('a title row is one cell across; Tab goes cell by cell, row by row', () => {
    const table = tableAt({ ...DEFAULT_TABLE_SPEC, columns: 2 }, [0, 0]);
    const rects = cellRects(table);
    expect(rects.filter((c) => c.row === 0)).toHaveLength(1);
    expect(rects.filter((c) => c.row === 1)).toHaveLength(2);
    expect(nextCell(table, { row: 0, col: 0 })).toEqual({ row: 1, col: 0 });
    expect(nextCell(table, { row: 1, col: 0 })).toEqual({ row: 1, col: 1 });
    expect(nextCell(table, { row: 2, col: 1 })).toBeNull();
    expect(cellAt(table, [70, -15])).toEqual({ row: 1, col: 1 });
    expect(cellAt(table, [500, -15])).toBeNull();
  });
  it('the dialog refuses what AutoCAD refuses', () => {
    expect(specProblem(DEFAULT_TABLE_SPEC)).toBeNull();
    expect(specProblem({ ...DEFAULT_TABLE_SPEC, columns: 0 })).toBe('columns');
    expect(specProblem({ ...DEFAULT_TABLE_SPEC, columns: 1.5 })).toBe('columns');
    expect(specProblem({ ...DEFAULT_TABLE_SPEC, dataRows: 0 })).toBe('rows');
    expect(specProblem({ ...DEFAULT_TABLE_SPEC, columnWidth: 0 })).toBe('width');
    expect(specProblem({ ...DEFAULT_TABLE_SPEC, rowLines: 0 })).toBe('lines');
  });
});
