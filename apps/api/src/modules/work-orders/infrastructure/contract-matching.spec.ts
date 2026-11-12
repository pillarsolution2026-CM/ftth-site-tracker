import type { ImportPreviewRow, ImportRowIssue } from '@ftth/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ApprovedContract } from '../domain/contract-lines.js';
import { Decimal } from '../domain/decimal.js';
import { checkImportAgainstContract } from '../domain/import/contract-matching.js';
import { selectRowsForCommit } from '../domain/import/import-commit.js';
import { parseImport } from '../domain/import/import-parser.js';
import { approvedContractFromSheet, itemIdOfRow } from '../testing/approved-contract.js';
import {
  buildWorkOrderSheet,
  CONTRACT_SHEET_EXPECTED,
  ITEM_ROWS,
  setCell,
  workOrderSheetRows,
} from '../testing/work-order-contract-sheets.js';
import type { SheetCell } from '../testing/xlsx-builder.js';
import { buildXlsx } from '../testing/xlsx-builder.js';
import { ExcelJsWorkbookReader } from './exceljs-workbook-reader.js';

const reader = new ExcelJsWorkbookReader();
let contract: ApprovedContract;

beforeAll(async () => {
  contract = await approvedContractFromSheet();
});

async function check(rows: SheetCell[][], reserved: Record<number, string> = {}) {
  const parsed = parseImport(await reader.read(await buildWorkOrderSheet(rows)), {}, 'workOrder');
  const reservations = new Map(
    Object.entries(reserved).map(([row, quantity]) => [
      itemIdOfRow(Number(row)),
      Decimal.parse(quantity),
    ]),
  );
  return checkImportAgainstContract(parsed, contract, reservations);
}

const errorsOf = (row: ImportPreviewRow | undefined): ImportRowIssue[] =>
  (row?.issues ?? []).filter((found) => found.severity === 'error');
const warningsOf = (row: ImportPreviewRow | undefined): ImportRowIssue[] =>
  (row?.issues ?? []).filter((found) => found.severity === 'warning');
const rowOf = (rows: readonly ImportPreviewRow[], rowNumber: number) =>
  rows.find((row) => row.rowNumber === rowNumber);

describe('work-order sheet against the contract (owner layout)', () => {
  it('has no errors when every row equals the contract and quantities are a third', async () => {
    const result = await check(workOrderSheetRows());
    expect(result.fileIssues).toEqual([]);
    expect(result.summary).toMatchObject({
      rowCount: CONTRACT_SHEET_EXPECTED.itemCount + CONTRACT_SHEET_EXPECTED.headingCount,
      // ADR-044: the contract's headings are skipped silently, not stored or shown as headings.
      headingCount: 0,
      skippedCount: CONTRACT_SHEET_EXPECTED.headingCount,
      errorRowCount: 0,
    });
    expect(result.rows.filter((row) => row.kind === 'item')).toHaveLength(
      CONTRACT_SHEET_EXPECTED.itemCount,
    );
  });

  it('warns about a changed price with the contract value, never an error', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.chamber, 'unitPrice', 8100);
    const { rows: out, summary } = await check(rows);
    expect(errorsOf(rowOf(out, ITEM_ROWS.chamber))).toEqual([]);
    expect(warningsOf(rowOf(out, ITEM_ROWS.chamber))).toEqual([
      {
        code: 'CONTRACT_MISMATCH',
        severity: 'warning',
        field: 'unitPrice',
        params: { contractValue: '8000' },
      },
    ]);
    expect(summary.errorRowCount).toBe(0);
    expect(summary.warningRowCount).toBe(1);
  });

  it('treats 8000 and 8000.00 as the same price (decimal equality, not text)', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.chamber, 'unitPrice', '8000.00');
    const { rows: out } = await check(rows);
    expect(errorsOf(rowOf(out, ITEM_ROWS.chamber))).toEqual([]);
  });

  it('warns about a changed unit, description and work type, one issue per field', async () => {
    const rows = workOrderSheetRows();
    setCell(rows, ITEM_ROWS.trench, 'unit', 'كم');
    setCell(rows, ITEM_ROWS.trench, 'description', 'حفر خندق عميق');
    setCell(rows, ITEM_ROWS.trench, 'workType', 'تركيبات');
    const { rows: out } = await check(rows);
    expect(errorsOf(rowOf(out, ITEM_ROWS.trench))).toEqual([]);
    const issues = warningsOf(rowOf(out, ITEM_ROWS.trench));
    expect(issues.map((found) => [found.code, found.field, found.params?.contractValue])).toEqual([
      ['CONTRACT_MISMATCH', 'description', 'حفر خندق'],
      ['CONTRACT_MISMATCH', 'unit', 'م.ط'],
      ['CONTRACT_MISMATCH', 'workType', 'civil'],
    ]);
  });

  it('compares text trimmed, so stray spaces are not a difference', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.trench, 'description', '  حفر خندق  ');
    setCell(rows, ITEM_ROWS.trench, 'unit', ' م.ط ');
    const { rows: out } = await check(rows);
    expect(errorsOf(rowOf(out, ITEM_ROWS.trench))).toEqual([]);
  });

  it('does not see a line-break or double-space difference in description and unit', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.trench, 'description', 'حفر\n  خندق');
    setCell(rows, ITEM_ROWS.trench, 'unit', 'م.ط');
    const { rows: out } = await check(rows);
    expect(rowOf(out, ITEM_ROWS.trench)?.issues).toEqual([]);
  });

  it('flags a code that is not in the contract', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.cable, 'code', '9-9-9');
    const { rows: out } = await check(rows);
    expect(errorsOf(rowOf(out, ITEM_ROWS.cable))).toEqual([
      { code: 'NOT_IN_CONTRACT', severity: 'error', field: 'code', params: { code: '9-9-9' } },
    ]);
  });

  it('never matches a heading of the contract: its code is not an item', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.cable, 'code', '1-2');
    const { rows: out } = await check(rows);
    expect(errorsOf(rowOf(out, ITEM_ROWS.cable)).map((found) => found.code)).toEqual([
      'NOT_IN_CONTRACT',
    ]);
  });

  it('skips the contract headings silently, with no issue', async () => {
    const { rows: out } = await check(workOrderSheetRows());
    const skipped = out.filter((row) => row.kind === 'skipped');
    expect(skipped).toHaveLength(CONTRACT_SHEET_EXPECTED.headingCount);
    expect(skipped.every((row) => row.issues.length === 0)).toBe(true);
  });

  it('skips a contract heading with a zero quantity but refuses one with a quantity', async () => {
    const zero = await check(setCell(workOrderSheetRows(), ITEM_ROWS.cable, 'code', '1-2'));
    expect(errorsOf(rowOf(zero.rows, ITEM_ROWS.cable))).toHaveLength(1);
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.cable, 'code', '1-2');
    setCell(rows, ITEM_ROWS.cable, 'quantity', 0);
    const { rows: out } = await check(rows);
    expect(rowOf(out, ITEM_ROWS.cable)).toMatchObject({ kind: 'skipped', issues: [] });
  });

  it('skips a heading of the file only (code not in the contract, no unit, quantity 0 or empty) silently (owner 2026-11-12)', async () => {
    for (const quantity of [0, null]) {
      const rows = setCell(workOrderSheetRows(), ITEM_ROWS.cable, 'code', '2-14');
      setCell(rows, ITEM_ROWS.cable, 'unit', null);
      setCell(rows, ITEM_ROWS.cable, 'quantity', quantity);
      const { rows: out, summary } = await check(rows);
      expect(rowOf(out, ITEM_ROWS.cable)).toMatchObject({ kind: 'skipped', issues: [] });
      expect(summary.errorRowCount).toBe(0);
    }
  });

  it('still refuses a code not in the contract when the row has a unit or a quantity', async () => {
    const withUnit = setCell(workOrderSheetRows(), ITEM_ROWS.cable, 'code', '2-14');
    setCell(withUnit, ITEM_ROWS.cable, 'quantity', 0);
    expect(errorsOf(rowOf((await check(withUnit)).rows, ITEM_ROWS.cable))).toHaveLength(1);
    const withQuantity = setCell(workOrderSheetRows(), ITEM_ROWS.cable, 'code', '2-14');
    setCell(withQuantity, ITEM_ROWS.cable, 'unit', null);
    setCell(withQuantity, ITEM_ROWS.cable, 'quantity', 5);
    expect(errorsOf(rowOf((await check(withQuantity)).rows, ITEM_ROWS.cable))).toHaveLength(1);
  });

  it('skips a row without a code silently, whatever its other cells hold', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.cable, 'code', null);
    setCell(rows, ITEM_ROWS.cable, 'quantity', 'total');
    const { rows: out, summary } = await check(rows);
    expect(rowOf(out, ITEM_ROWS.cable)).toMatchObject({ kind: 'skipped', issues: [] });
    expect(summary.errorRowCount).toBe(0);
  });

  it('keeps a priced item an item when its unit and price cells are empty', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.chamber, 'unit', null);
    setCell(rows, ITEM_ROWS.chamber, 'unitPrice', null);
    setCell(rows, ITEM_ROWS.chamber, 'workType', null);
    const { rows: out } = await check(rows);
    expect(rowOf(out, ITEM_ROWS.chamber)).toMatchObject({ kind: 'item', issues: [] });
  });

  it('rounds a quantity to 4 decimals half-up without any issue, and accepts 0', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.trench, 'quantity', 99.00005);
    setCell(rows, ITEM_ROWS.chamber, 'quantity', 0);
    const { rows: out } = await check(rows);
    expect(rowOf(out, ITEM_ROWS.trench)?.quantity).toBe('99.0001');
    expect(rowOf(out, ITEM_ROWS.trench)?.issues).toEqual([]);
    expect(rowOf(out, ITEM_ROWS.chamber)).toMatchObject({ kind: 'item', quantity: '0' });
    expect(rowOf(out, ITEM_ROWS.chamber)?.issues).toEqual([]);
  });

  it('keeps a quantity that cannot be read as an error', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.trench, 'quantity', 'abc');
    setCell(rows, ITEM_ROWS.chamber, 'quantity', -2);
    const { rows: out } = await check(rows);
    expect(errorsOf(rowOf(out, ITEM_ROWS.trench)).map((found) => found.code)).toEqual([
      'INVALID_NUMBER',
    ]);
    expect(errorsOf(rowOf(out, ITEM_ROWS.chamber)).map((found) => found.code)).toEqual([
      'NEGATIVE_NUMBER',
    ]);
  });

  it('never makes an optional cell an error: unreadable price, work type and text are absent', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.trench, 'unitPrice', 'abc');
    setCell(rows, ITEM_ROWS.trench, 'workType', 'nonsense');
    setCell(rows, ITEM_ROWS.trench, 'description', 'x'.repeat(5000));
    setCell(rows, ITEM_ROWS.trench, 'unit', null);
    const { rows: out } = await check(rows);
    expect(rowOf(out, ITEM_ROWS.trench)?.issues).toEqual([]);
  });

  it('computes the amount from the contract price, not the file', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.chamber, 'unitPrice', 9999);
    const { rows: out } = await check(rows);
    const chamber = rowOf(out, ITEM_ROWS.chamber);
    expect(chamber?.amount).toBe(
      Decimal.parse('8000')
        .mul(Decimal.parse(chamber?.quantity ?? '0'))
        .toString(),
    );
  });

  it('marks a code on two rows as CODE_REPEATED on both, replacing DUPLICATE_CODE', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.joint, 'code', '2-9-1');
    const { rows: out } = await check(rows);
    const first = errorsOf(rowOf(out, ITEM_ROWS.cable));
    const second = errorsOf(rowOf(out, ITEM_ROWS.joint));
    expect(first).toContainEqual({
      code: 'CODE_REPEATED',
      severity: 'error',
      field: 'code',
      params: { code: '2-9-1', otherRows: String(ITEM_ROWS.joint) },
    });
    expect(second.map((found) => found.code)).toContain('CODE_REPEATED');
    expect(second.find((found) => found.code === 'CODE_REPEATED')?.params?.otherRows).toBe(
      String(ITEM_ROWS.cable),
    );
    expect(out.flatMap((row) => row.issues).some((found) => found.code === 'DUPLICATE_CODE')).toBe(
      false,
    );
  });

  it('flags a quantity above the contract quantity', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.building, 'quantity', 7);
    const { rows: out } = await check(rows);
    expect(errorsOf(rowOf(out, ITEM_ROWS.building))).toEqual([
      {
        code: 'QUANTITY_EXCEEDS_CONTRACT',
        severity: 'error',
        field: 'quantity',
        params: { availableQuantity: '6', contractQuantity: '6', reservedQuantity: '0' },
      },
    ]);
  });

  it('subtracts what other work orders reserved', async () => {
    // Contract 300, other work order holds 250.5: 100 asked, 49.5 available.
    const { rows: out } = await check(workOrderSheetRows(), { [ITEM_ROWS.trench]: '250.5' });
    expect(errorsOf(rowOf(out, ITEM_ROWS.trench))).toEqual([
      {
        code: 'QUANTITY_EXCEEDS_CONTRACT',
        severity: 'error',
        field: 'quantity',
        params: { availableQuantity: '49.5', contractQuantity: '300', reservedQuantity: '250.5' },
      },
    ]);
    // Exactly the remainder is fine.
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.trench, 'quantity', 49.5);
    const fits = await check(rows, { [ITEM_ROWS.trench]: '250.5' });
    expect(errorsOf(rowOf(fits.rows, ITEM_ROWS.trench))).toEqual([]);
  });

  it('skips an item row whose quantity cell is empty, with a warning only (owner 2026-10-31)', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.chamber, 'quantity', null);
    // Even a changed price is not checked: the row is not part of the work order.
    setCell(rows, ITEM_ROWS.chamber, 'unitPrice', 9999);
    const result = await check(rows);
    const skipped = rowOf(result.rows, ITEM_ROWS.chamber);
    expect(skipped?.kind).toBe('skipped');
    expect(skipped?.issues.map((found) => [found.code, found.severity])).toEqual([
      ['EMPTY_QUANTITY_SKIPPED', 'warning'],
    ]);
    expect(result.summary.errorRowCount).toBe(0);
    const selection = selectRowsForCommit(result, {
      excludedRowNumbers: [],
      acceptedDuplicateCodes: [],
    });
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.lines.map((line) => line.sourceRow)).not.toContain(ITEM_ROWS.chamber);
    }
  });

  it('does not skip a quantity of 0', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.chamber, 'quantity', 0);
    const result = await check(rows);
    expect(rowOf(result.rows, ITEM_ROWS.chamber)?.kind).toBe('item');
  });
});

describe('work-order profile mapping (ADR-044)', () => {
  const sheet = (header: string[]) => buildXlsx([{ name: 'WO', rows: [header, ['1-1', 5, 'x']] }]);

  it('requires only the code and the quantity columns', async () => {
    const file = await sheet(['الكود', 'الكمية', 'ملاحظات']);
    const workbook = await reader.read(file);
    const workOrder = parseImport(workbook, { headerRow: 1 }, 'workOrder');
    expect(workOrder.fileIssues).toEqual([]);
    const standard = parseImport(workbook, { headerRow: 1 });
    expect(standard.fileIssues.map((found) => found.field).sort()).toEqual([
      'description',
      'unit',
      'unitPrice',
      'workType',
    ]);
  });

  it('reports a missing quantity column in this profile', async () => {
    const workbook = await reader.read(await sheet(['الكود', 'الوصف', 'ملاحظات']));
    const parsed = parseImport(workbook, { headerRow: 1 }, 'workOrder');
    expect(parsed.fileIssues).toEqual([{ code: 'REQUIRED_FIELD_UNMAPPED', field: 'quantity' }]);
  });
});
