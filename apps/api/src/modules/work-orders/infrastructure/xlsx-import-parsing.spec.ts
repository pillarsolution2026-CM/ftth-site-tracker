import type { WorkOrderImportPreviewOptions } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { parseImport, type ParsedImport } from '../domain/import/import-parser.js';
import {
  ARABIC_HEADER,
  buildXlsx,
  ENGLISH_HEADER,
  type SheetSpec,
} from '../testing/xlsx-builder.js';
import { ExcelJsWorkbookReader } from './exceljs-workbook-reader.js';

const reader = new ExcelJsWorkbookReader();

async function parse(
  sheets: SheetSpec[],
  options: WorkOrderImportPreviewOptions = {},
): Promise<ParsedImport> {
  return parseImport(await reader.read(await buildXlsx(sheets)), options);
}

const issueCodes = (parsed: ParsedImport, rowIndex: number): string[] =>
  (parsed.rows[rowIndex]?.issues ?? []).map((issue) => issue.code);

describe('xlsx import parsing: headers', () => {
  it('maps an Arabic header row and reads the items', async () => {
    const parsed = await parse([
      {
        name: 'BOQ',
        rows: [
          [...ARABIC_HEADER, 'نوع الأعمال'],
          ['A-1', 'حفر خندق', 'م.ط', 10, 25.5, 255, 'مدني'],
          ['A-2', 'مواسير', 'م.ط', 3, 100, 300, 'تركيبات'],
        ],
      },
    ]);
    expect(parsed.fileIssues).toEqual([]);
    expect(parsed.headerRow).toBe(1);
    expect(parsed.mapping).toEqual({
      code: 0,
      description: 1,
      unit: 2,
      quantity: 3,
      unitPrice: 4,
      workType: 6,
      amount: 5,
    });
    expect(parsed.rows.map((r) => [r.code, r.quantity, r.unitPrice, r.amount, r.workType])).toEqual(
      [
        ['A-1', '10', '25.5', '255', 'civil'],
        ['A-2', '3', '100', '300', 'installation'],
      ],
    );
    expect(parsed.summary).toMatchObject({ rowCount: 2, errorRowCount: 0, total: '555' });
  });

  it('maps English headers, and French ones', async () => {
    const english = await parse([{ name: 'S', rows: [ENGLISH_HEADER, ['X', 'd', 'u', 1, 2, 2]] }]);
    expect(english.mapping.unitPrice).toBe(4);
    const french = await parse([
      {
        name: 'S',
        rows: [
          [
            'Code',
            'Désignation',
            'Unité',
            'Quantité',
            'Prix unitaire',
            'Montant',
            'Type de travaux',
          ],
          ['X', 'd', 'u', 1, 2, 2, 'planification'],
        ],
      },
    ]);
    expect(french.mapping).toEqual({
      code: 0,
      description: 1,
      unit: 2,
      quantity: 3,
      unitPrice: 4,
      workType: 6,
      amount: 5,
    });
    expect(french.rows[0]?.workType).toBe('planning');
  });

  it('prefers the longest synonym: "سعر الوحدة" is the price, not the unit', async () => {
    const parsed = await parse([
      {
        name: 'S',
        rows: [
          ['كود', 'البيان', 'سعر الوحدة', 'الوحدة', 'الكمية'],
          ['X', 'd', 5, 'م', 2],
        ],
      },
    ]);
    expect(parsed.mapping).toMatchObject({ unitPrice: 2, unit: 3, quantity: 4 });
  });

  it('finds a header that is not in the first row', async () => {
    const parsed = await parse([
      {
        name: 'S',
        rows: [
          ['شركة الاتصالات'],
          [],
          ['أمر تكليف رقم 5'],
          ARABIC_HEADER,
          ['A-1', 'x', 'u', 1, 2, 2],
        ],
      },
    ]);
    expect(parsed.headerRow).toBe(4);
    expect(parsed.rows[0]?.rowNumber).toBe(5);
  });

  it('reports HEADER_ROW_NOT_FOUND when no row has enough matches', async () => {
    const parsed = await parse([
      {
        name: 'S',
        rows: [
          ['a', 'b', 'c'],
          [1, 2, 3],
        ],
      },
    ]);
    expect(parsed.fileIssues).toEqual([{ code: 'HEADER_ROW_NOT_FOUND', field: null }]);
    expect(parsed.headerRow).toBeNull();
    expect(parsed.rows).toEqual([]);
  });

  it('uses the top-left value of merged header cells and ignores the covered cells', async () => {
    const parsed = await parse([
      {
        name: 'S',
        // "البند" spans rows 1-2 of column A; "الوصف" spans B1:C1 (so C is covered).
        rows: [
          ['البند', 'الوصف', null, 'الوحدة', 'الكمية', 'السعر'],
          [null, null, null],
          ['A', 'd', null, 'u', 1, 2],
        ],
        merges: ['A1:A2', 'B1:C1'],
      },
    ]);
    expect(parsed.mapping).toMatchObject({
      code: 0,
      description: 1,
      unit: 3,
      quantity: 4,
      unitPrice: 5,
    });
    // Row 2 is only the covered half of the merged header: empty, hence skipped.
    expect(parsed.rows.map((r) => r.rowNumber)).toEqual([3]);
  });

  it('honours an explicit sheet, header row and mapping override', async () => {
    const sheets: SheetSpec[] = [
      { name: 'cover', rows: [['x']] },
      {
        name: 'data',
        rows: [
          ['q', 'p', 'c', 'd', 'u'],
          ['2', '3', 'K', 'desc', 'm'],
        ],
      },
    ];
    const parsed = await parse(sheets, {
      sheetName: 'data',
      headerRow: 1,
      mapping: {
        code: 2,
        description: 3,
        unit: 4,
        quantity: 0,
        unitPrice: 1,
        workType: null,
        amount: null,
      },
    });
    expect(parsed.sheets).toEqual([
      { name: 'cover', rowCount: 1 },
      { name: 'data', rowCount: 2 },
    ]);
    expect(parsed.rows[0]).toMatchObject({ code: 'K', quantity: '2', unitPrice: '3', unit: 'm' });
    expect((await parse(sheets, { sheetName: 'missing' })).fileIssues).toEqual([
      { code: 'SHEET_NOT_FOUND', field: null },
    ]);
  });

  it('flags unmapped required fields and doubly-mapped columns for the file, not per row', async () => {
    const parsed = await parse([
      {
        name: 'S',
        rows: [
          ['الوصف', 'الوحدة', 'الكمية'],
          ['d', 'u', 1],
        ],
      },
    ]);
    expect(parsed.fileIssues).toEqual(
      expect.arrayContaining([
        { code: 'REQUIRED_FIELD_UNMAPPED', field: 'code' },
        { code: 'REQUIRED_FIELD_UNMAPPED', field: 'unitPrice' },
      ]),
    );
    expect(issueCodes(parsed, 0)).toEqual([]);

    const twice = await parse([{ name: 'S', rows: [ENGLISH_HEADER, ['X', 'd', 'u', 1, 2, 2]] }], {
      headerRow: 1,
      mapping: {
        code: 0,
        description: 0,
        unit: 2,
        quantity: 3,
        unitPrice: 4,
        workType: null,
        amount: null,
      },
    });
    expect(twice.fileIssues).toContainEqual({ code: 'COLUMN_MAPPED_TWICE', field: 'description' });
  });
});

describe('xlsx import parsing: numbers', () => {
  it('reads Arabic-Indic digits, decimal and thousands separators typed as text', async () => {
    const parsed = await parse([
      {
        name: 'S',
        rows: [
          ENGLISH_HEADER,
          ['A', 'd', 'u', '١٢٫٥', '١٬٢٠٠', null],
          ['B', 'd', 'u', '۳', '1,500.25', null],
          ['C', 'd', 'u', ' 4 ', '0012.50', null],
        ],
      },
    ]);
    expect(parsed.rows.map((r) => [r.quantity, r.unitPrice, r.issues.length])).toEqual([
      ['12.5', '1200', 0],
      ['3', '1500.25', 0],
      ['4', '12.5', 0],
    ]);
  });

  it('never rounds: more than 4 decimals is an error on that row', async () => {
    const parsed = await parse([
      {
        name: 'S',
        rows: [ENGLISH_HEADER, ['A', 'd', 'u', 1.23456, 2, null], ['B', 'd', 'u', 1.2345, 2, null]],
      },
    ]);
    expect(issueCodes(parsed, 0)).toEqual(['TOO_MANY_DECIMALS']);
    expect(parsed.rows[0]?.quantity).toBeNull();
    expect(parsed.rows[1]?.quantity).toBe('1.2345');
    expect(parsed.summary.errorRowCount).toBe(1);
  });

  it('keeps the shortest round-trip text of a number cell (0.1 stays 0.1)', async () => {
    const parsed = await parse([
      { name: 'S', rows: [ENGLISH_HEADER, ['A', 'd', 'u', 0.1, 0.3, null]] },
    ]);
    expect(parsed.rows[0]).toMatchObject({ quantity: '0.1', unitPrice: '0.3', amount: '0.03' });
  });

  it.each([
    ['abc', 'INVALID_NUMBER'],
    [-5, 'NEGATIVE_NUMBER'],
    ['', 'MISSING_VALUE'],
    ['123456789012345', 'NUMBER_OUT_OF_RANGE'],
  ])('quantity %j gives %s', async (value, code) => {
    const parsed = await parse([
      { name: 'S', rows: [ENGLISH_HEADER, ['A', 'd', 'u', value, 2, null]] },
    ]);
    expect(issueCodes(parsed, 0)).toEqual([code]);
  });

  it('accepts a formula with a cached result and flags one without', async () => {
    const parsed = await parse([
      {
        name: 'S',
        rows: [
          ENGLISH_HEADER,
          ['A', 'd', 'u', { formula: '2*3', result: 6 }, 2, null],
          ['B', 'd', 'u', { formula: '2*3' }, 2, null],
          ['C', 'd', 'u', 1, 2, { formula: 'D4*E4' }],
        ],
      },
    ]);
    expect(parsed.rows[0]).toMatchObject({ quantity: '6', amount: '12' });
    expect(issueCodes(parsed, 1)).toEqual(['FORMULA_WITHOUT_RESULT']);
    expect(parsed.rows[1]?.issues[0]).toMatchObject({ field: 'quantity', severity: 'error' });
    // The sheet amount is only a cross-check: an uncached formula there is not an error.
    expect(parsed.rows[2]?.issues).toEqual([]);
    expect(parsed.rows[2]?.sheetAmount).toBeNull();
  });

  it("warns when the sheet amount differs, comparing at the sheet value's decimals", async () => {
    const parsed = await parse([
      {
        name: 'S',
        rows: [
          ENGLISH_HEADER,
          ['A', 'd', 'u', 3, 33.333, 100], // 99.999 rounds to 100 at 0 decimals: matches
          ['B', 'd', 'u', 3, 33.333, 99.99], // 99.999 rounds to 100.00 at 2 decimals: mismatch
          ['C', 'd', 'u', 2, 10, 'n/a'],
        ],
      },
    ]);
    expect(issueCodes(parsed, 0)).toEqual([]);
    expect(parsed.rows[1]?.issues).toEqual([
      expect.objectContaining({ code: 'AMOUNT_MISMATCH', severity: 'warning', field: 'amount' }),
    ]);
    expect(issueCodes(parsed, 2)).toEqual(['AMOUNT_MISMATCH']);
    expect(parsed.summary.errorRowCount).toBe(0);
  });
});

describe('xlsx import parsing: rows', () => {
  it('skips fully empty rows but returns every other row with its issues', async () => {
    const parsed = await parse([
      {
        name: 'S',
        rows: [
          ENGLISH_HEADER,
          ['A', 'd', 'u', 1, 2, null],
          [],
          [null, '  '],
          ['', 'only description'],
        ],
      },
    ]);
    expect(parsed.rows.map((r) => r.rowNumber)).toEqual([2, 5]);
    expect(issueCodes(parsed, 1)).toEqual([
      'MISSING_VALUE',
      'MISSING_VALUE',
      'MISSING_VALUE',
      'MISSING_VALUE',
    ]);
  });

  it('marks every row of a repeated code as DUPLICATE_CODE with the other row numbers', async () => {
    const parsed = await parse([
      {
        name: 'S',
        rows: [
          ENGLISH_HEADER,
          ['A', 'd', 'u', 1, 2, null],
          ['B', 'd', 'u', 1, 2, null],
          ['A', 'e', 'u', 1, 2, null],
          ['A', 'f', 'u', 1, 2, null],
        ],
      },
    ]);
    expect(parsed.rows[0]?.issues).toEqual([
      {
        code: 'DUPLICATE_CODE',
        severity: 'warning',
        field: 'code',
        params: { code: 'A', otherRows: '4,5' },
      },
    ]);
    expect(issueCodes(parsed, 1)).toEqual([]);
    expect(issueCodes(parsed, 3)).toEqual(['DUPLICATE_CODE']);
    expect(parsed.summary.duplicateCodes).toEqual([{ code: 'A', rowNumbers: [2, 4, 5] }]);
    expect(parsed.summary.warningRowCount).toBe(3);
  });

  it('reports an empty data area and an empty sheet', async () => {
    expect(
      (await parse([{ name: 'S', rows: [[...ENGLISH_HEADER, 'Work Type']] }])).fileIssues,
    ).toEqual([{ code: 'NO_ITEM_ROWS', field: null }]);
    expect((await parse([{ name: 'S', rows: [] }])).fileIssues).toEqual([
      { code: 'SHEET_EMPTY', field: null },
    ]);
  });

  it('reports the Excel letter of every column', async () => {
    const parsed = await parse([{ name: 'S', rows: [ENGLISH_HEADER, ['A', 'd', 'u', 1, 2, 2]] }]);
    expect(parsed.columns.map((c) => [c.index, c.letter, c.header])).toEqual([
      [0, 'A', 'Code'],
      [1, 'B', 'Description'],
      [2, 'C', 'Unit'],
      [3, 'D', 'Quantity'],
      [4, 'E', 'Unit Price'],
      [5, 'F', 'Amount'],
    ]);
  });
});

describe('xlsx import parsing: work type, price decimals, unit length (ADR-016)', () => {
  // Same layout as the owner's BOQ sheet: serial, work type, description, unit, qty, price, total.
  const OWNER_HEADER = [
    'مسلسل',
    'نوع الاعمال',
    'البيـــــــان',
    'الوحدة',
    'الكمية',
    'سعر الوحدة \nجم بدون الضريبة',
    'الاجمالي بدون الضريبة',
  ];
  const ownerSheet = (rows: unknown[][]) =>
    parse([{ name: 'S', rows: [OWNER_HEADER, ...rows] as never }], {
      headerRow: 1,
      mapping: {
        code: 0,
        workType: 1,
        description: 2,
        unit: 3,
        quantity: 4,
        unitPrice: 5,
        amount: 6,
      },
    });

  it('detects the work type column from the Arabic header', async () => {
    const parsed = await parse([
      { name: 'S', rows: [OWNER_HEADER, ['1-1', 'مدني', 'd', 'م3', 1, 2, 2]] },
    ]);
    expect(parsed.suggestedMapping).toMatchObject({
      workType: 1,
      description: 2,
      unit: 3,
      quantity: 4,
      unitPrice: 5,
      amount: 6,
    });
    // "مسلسل" is not a code synonym: the user maps column A by hand (unchanged behaviour).
    expect(parsed.suggestedMapping.code).toBeNull();
  });

  it('reads the three work types and rejects anything else', async () => {
    const parsed = await ownerSheet([
      ['1', 'مدني', 'd', 'عدد', 1, 2, 2],
      ['2', 'تركيبات', 'd', 'عدد', 1, 2, 2],
      ['3', ' تخطيط ', 'd', 'عدد', 1, 2, 2],
      ['4', 'صيانة', 'd', 'عدد', 1, 2, 2],
      ['5', null, 'd', 'عدد', 1, 2, 2],
    ]);
    expect(parsed.rows.map((r) => r.workType)).toEqual([
      'civil',
      'installation',
      'planning',
      null,
      null,
    ]);
    expect(parsed.rows[3]?.issues).toEqual([
      expect.objectContaining({ code: 'INVALID_WORK_TYPE', field: 'workType', severity: 'error' }),
    ]);
    expect(issueCodes(parsed, 4)).toEqual(['MISSING_VALUE']);
  });

  it('requires the work type column to be mapped', async () => {
    const parsed = await parse([{ name: 'S', rows: [ENGLISH_HEADER, ['A', 'd', 'u', 1, 2, 2]] }]);
    expect(parsed.fileIssues).toEqual([{ code: 'REQUIRED_FIELD_UNMAPPED', field: 'workType' }]);
  });

  it('accepts unit prices with up to 6 decimals and keeps quantities at 4', async () => {
    const parsed = await ownerSheet([
      ['2-2-1', 'مدني', 'd', 'م.ط', 21000, 5.59936, 117586.56],
      ['2-7-5-1', 'مدني', 'd', 'م.ط', 1500, 4.06624, 6099.36],
      ['X', 'مدني', 'd', 'م.ط', 1, 1.1234567, null],
      ['Y', 'مدني', 'd', 'م.ط', 1.23456, 1, null],
    ]);
    expect(parsed.rows[0]).toMatchObject({
      unitPrice: '5.59936',
      amount: '117586.56',
      issues: [],
    });
    expect(parsed.rows[1]).toMatchObject({ unitPrice: '4.06624', amount: '6099.36', issues: [] });
    expect(parsed.rows[2]?.issues).toEqual([
      expect.objectContaining({
        code: 'TOO_MANY_DECIMALS',
        field: 'unitPrice',
        params: { max: 6 },
      }),
    ]);
    expect(parsed.rows[3]?.issues).toEqual([
      expect.objectContaining({ code: 'TOO_MANY_DECIMALS', field: 'quantity', params: { max: 4 } }),
    ]);
  });

  it('accepts units up to 64 characters', async () => {
    const longest = 'BULDING\n\n(more than 8 unit/flat per building)';
    const parsed = await ownerSheet([
      ['4-2-4', 'تخطيط', 'd', longest, 3750, 77.25856, 289719.6],
      ['Z', 'تخطيط', 'd', 'u'.repeat(65), 1, 1, null],
    ]);
    expect(parsed.rows[0]).toMatchObject({ unit: longest, issues: [] });
    expect(parsed.rows[1]?.issues).toEqual([
      expect.objectContaining({ code: 'TEXT_TOO_LONG', field: 'unit', params: { max: 64 } }),
    ]);
  });

  it('still flags section headings without unit, quantity or price', async () => {
    const parsed = await ownerSheet([['1-1', 'مدني', 'غرف التفتيش', null, null, null, null]]);
    expect(issueCodes(parsed, 0)).toEqual(['MISSING_VALUE', 'MISSING_VALUE', 'MISSING_VALUE']);
  });
});

describe('ExcelJsWorkbookReader', () => {
  it('refuses bytes that are not a workbook', async () => {
    await expect(reader.read(Buffer.from('PK\u0003\u0004 not really a zip'))).rejects.toMatchObject(
      {
        code: 'UNSUPPORTED_FILE',
      },
    );
  });
});
