import { OWNER_BOQ_HEADER } from './owner-boq-sheet.js';
import { buildXlsx, type SheetCell } from './xlsx-builder.js';

/**
 * Synthetic contract sheet and matching work-order sheet in the owner's layout (title rows, the
 * Arabic header in row 3, section headings). No customer data. Work-order quantities are one
 * third of the contract's, as in the owner's files (ADR-028).
 *
 * Contract: 5 items + 3 headings. Work order sheet against it: 0 errors.
 */

/** Column indexes of the owner's layout. */
export const COL = {
  code: 0,
  workType: 1,
  description: 2,
  unit: 3,
  quantity: 4,
  unitPrice: 5,
  amount: 6,
} as const;

interface Line {
  code: string;
  workType?: string;
  description: string;
  unit?: string;
  quantity?: number;
  unitPrice?: number;
}

/** Row 4 onwards. `quantity` is the contract quantity. */
export const CONTRACT_LINES: readonly Line[] = [
  { code: '1', workType: 'مدني', description: 'الأعمال المدنية' }, // row 4: heading
  {
    code: '1-1',
    workType: 'مدني',
    description: 'حفر خندق',
    unit: 'م.ط',
    quantity: 300,
    unitPrice: 12.5,
  }, // row 5
  { code: '1-2', workType: 'مدني', description: 'غرف التفتيش' }, // row 6: heading
  {
    code: '1-2-1',
    workType: 'مدني',
    description: 'غرفة نوع 1',
    unit: 'عدد',
    quantity: 30,
    unitPrice: 8000,
  }, // row 7
  { code: '2', workType: 'تركيبات', description: 'أعمال التركيبات' }, // row 8: heading
  {
    code: '2-9-1',
    workType: 'تركيبات',
    description: 'كابل رئيسي',
    unit: 'م.ط',
    quantity: 15,
    unitPrice: 2,
  }, // row 9
  {
    code: '2-9-1-1',
    workType: 'تركيبات',
    description: 'وصلة كابل',
    unit: 'عدد',
    quantity: 9,
    unitPrice: 3,
  }, // row 10
  {
    code: '4-2-4',
    workType: 'تخطيط',
    description: 'مبنى',
    unit: 'عدد',
    quantity: 6,
    unitPrice: 10,
  }, // row 11
];

export const CONTRACT_SHEET_EXPECTED = { itemCount: 5, headingCount: 3 } as const;

/** Row numbers of the item rows (first data row is 4). */
export const ITEM_ROWS = { trench: 5, chamber: 7, cable: 9, joint: 10, building: 11 } as const;

function toRows(lines: readonly Line[], divisor: number): SheetCell[][] {
  const data = lines.map((line): SheetCell[] => {
    const quantity = line.quantity === undefined ? null : line.quantity / divisor;
    const total =
      quantity !== null && line.unitPrice !== undefined ? quantity * line.unitPrice : null;
    return [
      line.code,
      line.workType ?? null,
      line.description,
      line.unit ?? null,
      quantity,
      line.unitPrice ?? null,
      total,
    ];
  });
  return [['عقد تجريبي', null, null, null, null, null, null], [], [...OWNER_BOQ_HEADER], ...data];
}

/** Rows of the contract sheet (fresh copy each call, tests may edit cells). */
export const contractSheetRows = (): SheetCell[][] => toRows(CONTRACT_LINES, 1);

/** Rows of the work-order sheet: every quantity is a third of the contract's. */
export const workOrderSheetRows = (): SheetCell[][] => toRows(CONTRACT_LINES, 3);

export const buildContractSheet = (): Promise<Buffer> =>
  buildXlsx([{ name: 'BOQ', rows: contractSheetRows() }]);

export const buildWorkOrderSheet = (rows: SheetCell[][] = workOrderSheetRows()): Promise<Buffer> =>
  buildXlsx([{ name: 'WO', rows }]);

/** Sets one cell of a row given by Excel row number. */
export function setCell(
  rows: SheetCell[][],
  rowNumber: number,
  column: keyof typeof COL,
  value: SheetCell,
): SheetCell[][] {
  const row = rows[rowNumber - 1];
  if (!row) throw new Error(`No row ${rowNumber}`);
  row[COL[column]] = value;
  return rows;
}
