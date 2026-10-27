/**
 * Neutral view of a spreadsheet. The infrastructure reader (exceljs) produces it; the parser works
 * on it without knowing about files, so the rules are testable with plain objects.
 */
export type RawCell =
  | null
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  /** A formula that has no cached result (file never opened in Excel). */
  | { kind: 'unresolved' };

export interface RawSheet {
  name: string;
  /** 1-based Excel row number → cells (index 0 = column A). Rows without content are absent. */
  rows: ReadonlyMap<number, readonly RawCell[]>;
}

export interface RawWorkbook {
  sheets: readonly RawSheet[];
}

export function sheetRowCount(sheet: RawSheet): number {
  let last = 0;
  for (const [rowNumber, cells] of sheet.rows) {
    if (rowNumber > last && cells.some((cell) => !isBlank(cell))) last = rowNumber;
  }
  return last;
}

export function isBlank(cell: RawCell | undefined): boolean {
  return cell == null || (cell.kind === 'text' && cell.value.trim() === '');
}

/** Excel column letters for a 0-based index: 0 → A, 26 → AA. */
export function columnLetter(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}
