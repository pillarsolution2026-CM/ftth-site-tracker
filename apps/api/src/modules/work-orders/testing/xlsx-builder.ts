import ExcelJS from 'exceljs';

export type SheetCell = ExcelJS.CellValue;

export interface SheetSpec {
  name: string;
  /** Rows as written; `null` leaves a cell empty. Row 1 is the first entry. */
  rows: ReadonlyArray<readonly SheetCell[]>;
  /** Merge ranges such as "A1:A2" or "B1:C1". */
  merges?: readonly string[];
}

/** Builds an .xlsx in memory so import tests never depend on binary fixtures. */
export async function buildXlsx(sheets: readonly SheetSpec[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name);
    spec.rows.forEach((values, rowIndex) => {
      values.forEach((value, columnIndex) => {
        if (value !== null && value !== undefined) {
          sheet.getCell(rowIndex + 1, columnIndex + 1).value = value;
        }
      });
    });
    for (const range of spec.merges ?? []) sheet.mergeCells(range);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export const ARABIC_HEADER = ['البند', 'الوصف', 'الوحدة', 'الكمية', 'سعر الوحدة', 'القيمة'];
export const ENGLISH_HEADER = ['Code', 'Description', 'Unit', 'Quantity', 'Unit Price', 'Amount'];
