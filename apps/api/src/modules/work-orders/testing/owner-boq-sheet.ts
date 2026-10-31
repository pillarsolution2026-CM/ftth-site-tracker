import { buildXlsx, type SheetCell } from './xlsx-builder.js';

/**
 * Synthetic sheet that mimics the layout of the owner's BOQ (`contract boq.xlsx`, 2026-10-31):
 * two title rows, the Arabic header in row 3 and the data below. It contains no customer data.
 *
 * Expected import: 10 rows → 6 items + 4 headings, total 1335, UNIT_FORM_VARIANT on rows 12 and 13.
 */
export const OWNER_BOQ_HEADER: readonly string[] = [
  'مسلسل',
  'نوع الاعمال',
  'البيـــــــــان',
  'الوحدة',
  'الكمية',
  'سعر الوحدة \nجم بدون الضريبة',
  'الاجمالي بدون الضريبة',
];

export const BUILDING_UNIT_A = 'BULDING (1 to 8 unit/flat per building)';
export const BUILDING_UNIT_B = 'BULDING\n(1 to 8 unit/flat per building)';

const amount = (formula: string, result: number): SheetCell => ({ formula, result });

export const OWNER_BOQ_ROWS: ReadonlyArray<readonly SheetCell[]> = [
  ['عقد تجريبي', null, null, null, null, null, null], // row 1: title
  [], // row 2: blank
  OWNER_BOQ_HEADER, // row 3
  ['1', 'مدني', 'الإعمال المدنيــة'], // row 4: heading, nothing else
  ['1-1', 'مدني', 'حفر خندق', 'م.ط', 100, 12.5, amount('F5*E5', 1250)], // row 5
  ['1-2', 'مدني', 'غرف التفتيش', null, null, null, 0], // row 6: heading, amount 0
  ['1-2-1', 'مدني', 'غرفة نوع 1', 'عدد', 0, 0, 0], // row 7: item with zero quantity and price
  ['2', 'تركيبات', 'أعمال التركيبات'], // row 8: heading
  ['2-9-1', 'تركيبات', 'كابل رئيسي', 'م.ط', 10, 2, amount('F9*E9', 20)], // row 9: priced parent
  ['2-9-1-1', 'تركيبات', 'وصلة كابل', 'عدد', 5, 3, amount('F10*E10', 15)], // row 10: priced child
  ['2-12', 'تركيبات'], // row 11: heading without a description
  ['4-2-4', 'تخطيط', 'مبنى', BUILDING_UNIT_A, 3, 10, amount('F12*E12', 30)], // row 12
  ['4-2-5', 'تخطيط', 'مبنى', BUILDING_UNIT_B, 2, 10, amount('F13*E13', 20)], // row 13
];

export const OWNER_BOQ_EXPECTED = {
  rowCount: 10,
  itemCount: 6,
  headingCount: 4,
  total: '1335',
  unitVariantRows: [12, 13],
} as const;

export function buildOwnerBoqXlsx(): Promise<Buffer> {
  return buildXlsx([{ name: 'BOQ', rows: OWNER_BOQ_ROWS }]);
}
