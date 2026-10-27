import ExcelJS from 'exceljs';
import { AppError } from '../../../common/app-error.js';
import type { WorkbookReader } from '../application/ports.js';
import type { RawCell, RawSheet, RawWorkbook } from '../domain/import/raw-workbook.js';

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object' && value !== null) {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part: { text?: string }) => part.text ?? '').join('');
    }
    if ('text' in value) return textOf(value.text);
    if ('error' in value) return String(value.error);
  }
  return String(value);
}

/** Cached formula results are read as values; a formula without a result stays "unresolved". */
function toRawCell(value: ExcelJS.CellValue): RawCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'object' && !(value instanceof Date)) {
    if ('formula' in value || 'sharedFormula' in value) {
      const result = (value as { result?: ExcelJS.CellValue }).result;
      return result === undefined || result === null ? { kind: 'unresolved' } : toRawCell(result);
    }
  }
  return { kind: 'text', value: textOf(value) };
}

function toRawSheet(sheet: ExcelJS.Worksheet): RawSheet {
  const rows = new Map<number, RawCell[]>();
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: RawCell[] = [];
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      // Merged ranges: only the top-left cell carries the value; the covered cells are empty.
      if (cell.type === ExcelJS.ValueType.Merge) return;
      cells[columnNumber - 1] = toRawCell(cell.value);
    });
    // Sparse arrays read as undefined; make the holes explicit empty cells.
    rows.set(
      rowNumber,
      Array.from(cells, (cell) => cell ?? null),
    );
  });
  return { name: sheet.name, rows };
}

export class ExcelJsWorkbookReader implements WorkbookReader {
  async read(file: Buffer): Promise<RawWorkbook> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(file as unknown as ArrayBuffer);
    } catch {
      throw new AppError('UNSUPPORTED_FILE', 'The file is not a readable .xlsx workbook');
    }
    return { sheets: workbook.worksheets.map(toRawSheet) };
  }
}
