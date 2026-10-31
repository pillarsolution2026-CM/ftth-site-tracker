import type { ImportPreviewRow, ImportRowIssue } from '@ftth/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ApprovedContract } from '../domain/contract-lines.js';
import { Decimal } from '../domain/decimal.js';
import { checkImportAgainstContract } from '../domain/import/contract-matching.js';
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
import { ExcelJsWorkbookReader } from './exceljs-workbook-reader.js';

const reader = new ExcelJsWorkbookReader();
let contract: ApprovedContract;

beforeAll(async () => {
  contract = await approvedContractFromSheet();
});

async function check(rows: SheetCell[][], reserved: Record<number, string> = {}) {
  const parsed = parseImport(await reader.read(await buildWorkOrderSheet(rows)), {});
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
const rowOf = (rows: readonly ImportPreviewRow[], rowNumber: number) =>
  rows.find((row) => row.rowNumber === rowNumber);

describe('work-order sheet against the contract (owner layout)', () => {
  it('has no errors when every row equals the contract and quantities are a third', async () => {
    const result = await check(workOrderSheetRows());
    expect(result.fileIssues).toEqual([]);
    expect(result.summary).toMatchObject({
      rowCount: CONTRACT_SHEET_EXPECTED.itemCount + CONTRACT_SHEET_EXPECTED.headingCount,
      headingCount: CONTRACT_SHEET_EXPECTED.headingCount,
      errorRowCount: 0,
    });
    expect(result.rows.filter((row) => row.kind === 'item')).toHaveLength(
      CONTRACT_SHEET_EXPECTED.itemCount,
    );
  });

  it('flags a changed price with the contract value', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.chamber, 'unitPrice', 8100);
    const { rows: out, summary } = await check(rows);
    expect(errorsOf(rowOf(out, ITEM_ROWS.chamber))).toEqual([
      {
        code: 'CONTRACT_MISMATCH',
        severity: 'error',
        field: 'unitPrice',
        params: { contractValue: '8000' },
      },
    ]);
    expect(summary.errorRowCount).toBe(1);
  });

  it('treats 8000 and 8000.00 as the same price (decimal equality, not text)', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.chamber, 'unitPrice', '8000.00');
    const { rows: out } = await check(rows);
    expect(errorsOf(rowOf(out, ITEM_ROWS.chamber))).toEqual([]);
  });

  it('flags a changed unit, description and work type, one issue per field', async () => {
    const rows = workOrderSheetRows();
    setCell(rows, ITEM_ROWS.trench, 'unit', 'كم');
    setCell(rows, ITEM_ROWS.trench, 'description', 'حفر خندق عميق');
    setCell(rows, ITEM_ROWS.trench, 'workType', 'تركيبات');
    const { rows: out } = await check(rows);
    const issues = errorsOf(rowOf(out, ITEM_ROWS.trench));
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

  it('leaves heading rows alone', async () => {
    const { rows: out } = await check(workOrderSheetRows());
    expect(
      out.filter((row) => row.kind === 'heading').every((row) => row.issues.length === 0),
    ).toBe(true);
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
});
