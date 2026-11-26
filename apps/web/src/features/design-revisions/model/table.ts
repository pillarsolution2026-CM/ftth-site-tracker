import {
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  type TableCellStyle,
} from '@ftth/shared';
import type { Pt } from './geometry';

/**
 * AutoCAD's TABLE (owner 2026-11-26), pure: the Insert Table dialog's values, the table they make
 * and where each cell is. AutoCAD's «Standard» table style of acadiso.dwt: data and header text
 * 4.5, title text 6, cell margins 1.5, column width 63.5, one-line rows.
 */

export const STANDARD_TABLE = {
  textHeight: 4.5,
  titleHeight: 6,
  margin: 1.5,
  columnWidth: 63.5,
  columns: 5,
  dataRows: 1,
  rowLines: 1,
} as const;
/** Line spacing of a cell's text (AutoCAD draws a line about 4/3 of the text height). */
export const LINE_SPACING = 4 / 3;

/** What the Insert Table dialog sends (the AutoCAD fields the screen keeps). */
export interface TableSpec {
  insertion: 'point' | 'window';
  columns: number;
  columnWidth: number;
  /** Data rows (AutoCAD counts the title and header rows apart). */
  dataRows: number;
  /** Row height in lines of text. */
  rowLines: number;
  styles: [TableCellStyle, TableCellStyle, TableCellStyle];
  textHeight: number;
}

export const DEFAULT_TABLE_SPEC: TableSpec = {
  insertion: 'point',
  columns: STANDARD_TABLE.columns,
  columnWidth: STANDARD_TABLE.columnWidth,
  dataRows: STANDARD_TABLE.dataRows,
  rowLines: STANDARD_TABLE.rowLines,
  styles: ['title', 'header', 'data'],
  textHeight: STANDARD_TABLE.textHeight,
};

/** Text height of a cell of this style (a title is bigger, as AutoCAD's Standard). */
export function cellTextHeight(style: TableCellStyle, height: number): number {
  return style === 'title'
    ? (height * STANDARD_TABLE.titleHeight) / STANDARD_TABLE.textHeight
    : height;
}

/** Height of a row of `lines` lines of text of this style. */
export function rowHeight(style: TableCellStyle, height: number, lines: number): number {
  const margin = (height * STANDARD_TABLE.margin) / STANDARD_TABLE.textHeight;
  return 2 * margin + lines * cellTextHeight(style, height) * LINE_SPACING;
}

/** The style of row `row` (0-based): row 1, row 2, then the others (AutoCAD's dialog). */
export function styleOfRow(styles: readonly TableCellStyle[], row: number): TableCellStyle {
  return (row === 0 ? styles[0] : row === 1 ? styles[1] : styles[2]) ?? 'data';
}

/**
 * Rows of the table: the title and header rows the styles name (each «title» or «header» among
 * row 1 and row 2 is one row of its own), then the data rows; AutoCAD's dialog counts them so.
 */
export function rowCount(spec: Pick<TableSpec, 'dataRows' | 'styles'>): number {
  const extra = [spec.styles[0], spec.styles[1]].filter((s) => s !== 'data').length;
  return Math.max(1, spec.dataRows + extra);
}

/** The spec checked against the dialog's limits (as AutoCAD: at least one column and row). */
export function specProblem(
  spec: TableSpec,
): 'columns' | 'rows' | 'width' | 'lines' | 'height' | null {
  if (!Number.isInteger(spec.columns) || spec.columns < 1 || spec.columns > MAX_TABLE_COLUMNS) {
    return 'columns';
  }
  const rows = rowCount(spec);
  if (
    !Number.isInteger(spec.dataRows) ||
    spec.dataRows < 1 ||
    rows > MAX_TABLE_ROWS ||
    rows * spec.columns > MAX_TABLE_CELLS
  ) {
    return 'rows';
  }
  if (!(spec.columnWidth > 0)) return 'width';
  if (!Number.isInteger(spec.rowLines) || spec.rowLines < 1) return 'lines';
  if (!(spec.textHeight > 0)) return 'height';
  return null;
}

export interface TableShape {
  x: number;
  y: number;
  columns: number[];
  rows: number[];
  height: number;
  styles: [TableCellStyle, TableCellStyle, TableCellStyle];
  cells: string[][];
}

/** What the cell helpers read of a table (saved ones are read-only). */
export interface TableGrid {
  x: number;
  y: number;
  columns: readonly number[];
  rows: readonly number[];
  styles: readonly TableCellStyle[];
}

/** The table a spec makes with its top-left corner at `at` (empty cells). */
export function tableAt(spec: TableSpec, at: Pt): TableShape {
  const rows = rowCount(spec);
  return {
    x: at[0],
    y: at[1],
    columns: Array.from({ length: spec.columns }, () => spec.columnWidth),
    rows: Array.from({ length: rows }, (_, r) =>
      rowHeight(styleOfRow(spec.styles, r), spec.textHeight, spec.rowLines),
    ),
    height: spec.textHeight,
    styles: [...spec.styles],
    cells: Array.from({ length: rows }, () => Array.from({ length: spec.columns }, () => '')),
  };
}

/**
 * «Specify window»: the table fills the window from its first corner (top-left) to the second;
 * the columns share the width, and the rows keep their height (AutoCAD then sets the number of
 * data rows from the height when «Auto» — here the dialog's rows stay).
 */
export function tableInWindow(spec: TableSpec, a: Pt, b: Pt): TableShape {
  const left = Math.min(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const width = Math.abs(b[0] - a[0]);
  const shape = tableAt(spec, [left, top]);
  if (width > 0) shape.columns = shape.columns.map(() => width / spec.columns);
  return shape;
}

/** Cell rectangles: [row][column] → {x0, y0 (top), x1, y1 (bottom)}; a title row is one cell. */
export function cellRects(table: TableGrid) {
  const out: { row: number; col: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  let top = table.y;
  const width = table.columns.reduce((s, w) => s + w, 0);
  table.rows.forEach((h, row) => {
    const bottom = top - h;
    if (styleOfRow(table.styles, row) === 'title' && row < 2) {
      out.push({ row, col: 0, x0: table.x, y0: top, x1: table.x + width, y1: bottom });
    } else {
      let left = table.x;
      table.columns.forEach((w, col) => {
        out.push({ row, col, x0: left, y0: top, x1: left + w, y1: bottom });
        left += w;
      });
    }
    top = bottom;
  });
  return out;
}

/** The cell under a drawing point, or null. */
export function cellAt(table: TableGrid, p: Pt): { row: number; col: number } | null {
  const hit = cellRects(table).find(
    (c) => p[0] >= c.x0 && p[0] <= c.x1 && p[1] <= c.y0 && p[1] >= c.y1,
  );
  return hit ? { row: hit.row, col: hit.col } : null;
}

/** The next cell AutoCAD's cell editor goes to with Tab (row by row; a title row is one cell). */
export function nextCell(
  table: Omit<TableGrid, 'x' | 'y'>,
  at: { row: number; col: number },
): { row: number; col: number } | null {
  const single = (row: number) => row < 2 && styleOfRow(table.styles, row) === 'title';
  const last = single(at.row) ? 0 : table.columns.length - 1;
  if (at.col < last) return { row: at.row, col: at.col + 1 };
  if (at.row + 1 < table.rows.length) return { row: at.row + 1, col: 0 };
  return null;
}

/** The table's outline box (drawing units). */
export function tableBox(table: Omit<TableGrid, 'styles'>) {
  const width = table.columns.reduce((s, w) => s + w, 0);
  const height = table.rows.reduce((s, h) => s + h, 0);
  return { minX: table.x, maxX: table.x + width, minY: table.y - height, maxY: table.y };
}
