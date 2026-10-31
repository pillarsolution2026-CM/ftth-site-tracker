import { describe, expect, it } from 'vitest';
import { selectRowsForCommit } from '../domain/import/import-commit.js';
import { parseImport } from '../domain/import/import-parser.js';
import {
  buildOwnerBoqXlsx,
  OWNER_BOQ_EXPECTED,
  OWNER_BOQ_HEADER,
} from '../testing/owner-boq-sheet.js';
import { buildXlsx } from '../testing/xlsx-builder.js';
import { ExcelJsWorkbookReader } from './exceljs-workbook-reader.js';

const reader = new ExcelJsWorkbookReader();

async function parseOwnerSheet() {
  return parseImport(await reader.read(await buildOwnerBoqXlsx()), {});
}

describe('owner BOQ layout', () => {
  it('detects the header row, maps مسلسل to the code and finds no errors', async () => {
    const parsed = await parseOwnerSheet();
    expect(parsed.headerRow).toBe(3);
    expect(parsed.mapping).toEqual({
      code: 0,
      workType: 1,
      description: 2,
      unit: 3,
      quantity: 4,
      unitPrice: 5,
      amount: 6,
    });
    expect(parsed.fileIssues).toEqual([]);
    expect(parsed.summary).toMatchObject({
      rowCount: OWNER_BOQ_EXPECTED.rowCount,
      headingCount: OWNER_BOQ_EXPECTED.headingCount,
      errorRowCount: 0,
      total: OWNER_BOQ_EXPECTED.total,
      duplicateCodes: [],
    });
  });

  it('classifies headings and items by kind, keeping zero-quantity items', async () => {
    const parsed = await parseOwnerSheet();
    expect(parsed.rows.map((row) => [row.rowNumber, row.kind])).toEqual([
      [4, 'heading'],
      [5, 'item'],
      [6, 'heading'],
      [7, 'item'],
      [8, 'heading'],
      [9, 'item'],
      [10, 'item'],
      [11, 'heading'],
      [12, 'item'],
      [13, 'item'],
    ]);
    const heading = parsed.rows.find((row) => row.rowNumber === 11);
    expect(heading).toMatchObject({ code: '2-12', description: null, issues: [] });
    const zero = parsed.rows.find((row) => row.rowNumber === 7);
    expect(zero).toMatchObject({ quantity: '0', unitPrice: '0', amount: '0', issues: [] });
    // Work type comes from each row, not from the section.
    expect(parsed.rows.find((row) => row.rowNumber === 9)?.workType).toBe('installation');
    expect(parsed.rows.find((row) => row.rowNumber === 4)?.workType).toBeNull();
  });

  it('warns UNIT_FORM_VARIANT on both BULDING rows and keeps the unit as typed', async () => {
    const parsed = await parseOwnerSheet();
    const warned = parsed.rows.filter((row) =>
      row.issues.some((issue) => issue.code === 'UNIT_FORM_VARIANT'),
    );
    expect(warned.map((row) => row.rowNumber)).toEqual([...OWNER_BOQ_EXPECTED.unitVariantRows]);
    expect(warned[0]?.issues).toEqual([
      {
        code: 'UNIT_FORM_VARIANT',
        severity: 'warning',
        field: 'unit',
        params: { otherRows: '13' },
      },
    ]);
    expect(warned[1]?.issues[0]?.params).toEqual({ otherRows: '12' });
    expect(warned[0]?.unit).toContain(' (1 to 8');
    expect(warned[1]?.unit).toContain('\n(1 to 8');
    expect(parsed.summary.warningRowCount).toBe(2);
  });

  it('commits items and headings for a contract but only items for a work order', async () => {
    const parsed = await parseOwnerSheet();
    const payload = { excludedRowNumbers: [], acceptedDuplicateCodes: [] };

    const contract = selectRowsForCommit(parsed, payload, 'keep');
    expect(contract.ok && contract.lines.map((line) => line.kind)).toEqual([
      'heading',
      'item',
      'heading',
      'item',
      'heading',
      'item',
      'item',
      'heading',
      'item',
      'item',
    ]);

    const workOrder = selectRowsForCommit(parsed, payload);
    expect(workOrder.ok && workOrder.lines.every((line) => line.kind === 'item')).toBe(true);
    expect(workOrder.ok && workOrder.lines).toHaveLength(OWNER_BOQ_EXPECTED.itemCount);
  });

  it('does not let a heading hide a priced row: a row with a price is an item', async () => {
    const parsed = parseImport(
      await reader.read(
        await buildXlsx([
          {
            name: 'S',
            rows: [OWNER_BOQ_HEADER, ['9', 'مدني', 'x', null, 0, 5, null]],
          },
        ]),
      ),
      {},
    );
    expect(parsed.rows[0]).toMatchObject({ kind: 'item' });
    expect(parsed.summary.errorRowCount).toBe(1); // unit missing
  });
});
