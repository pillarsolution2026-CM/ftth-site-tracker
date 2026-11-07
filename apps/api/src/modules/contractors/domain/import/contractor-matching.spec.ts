/* Test file: an index into a result that was just asserted to have that many rows. */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { ImportPreviewRow, ImportRowIssueCode } from '@ftth/shared';
import { scopeKeyOf } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../work-orders/domain/decimal.js';
import type { ScopeHolding, WorkOrderLine } from '../contractor.js';
import {
  annotateContractorSheet,
  selectContractorRows,
  slotOf,
  type ContractorSheetContext,
} from './contractor-matching.js';

const BOX = '10000000-0000-4000-8000-000000000001';
const TRENCH = '10000000-0000-4000-8000-000000000002';
const OLD = '10000000-0000-4000-8000-000000000003';

const line = (overrides: Partial<WorkOrderLine> & Pick<WorkOrderLine, 'id' | 'code'>) => ({
  lineNo: 1,
  description: `Item ${overrides.code}`,
  unit: 'عدد',
  workType: 'installation' as const,
  unitPrice: Decimal.parse('10'),
  quantity: Decimal.parse('100'),
  contractItemId: `c-${overrides.id}`,
  ...overrides,
});

const LINES: WorkOrderLine[] = [
  line({
    id: BOX,
    code: '2-12-4-8',
    description: 'بوكس توزيع',
    quantity: Decimal.parse('225'),
    unitPrice: Decimal.parse('2033.12'),
  }),
  line({ id: TRENCH, code: '1-1', description: 'حفر', unit: 'م.ط' }),
  line({ id: OLD, code: 'OLD', contractItemId: null }),
];

const SCOPE_A = 'تركيب الخوصة';
const SCOPE_B = 'تركيب البوكس';
const SCOPE_C = 'لحام البوكس';

const held = (scope: string | null, quantity: string, highestPrice: string): ScopeHolding => ({
  workOrderItemId: BOX,
  scopeKey: scopeKeyOf(scope),
  scope,
  quantity: Decimal.parse(quantity),
  highestPrice: Decimal.parse(highestPrice),
});

/** Other contractors already hold A 225 @300, B 225 @900, C 150 @500 on the box line. */
const OWNER_HOLDINGS = [
  held(SCOPE_A, '225', '300'),
  held(SCOPE_B, '225', '900'),
  held(SCOPE_C, '150', '500'),
];

const context = (
  holdings: readonly ScopeHolding[] = [],
  ownSlots: string[] = [],
): ContractorSheetContext => ({ lines: LINES, holdings, ownSlots: new Set(ownSlots) });

let rowNumber = 1;
const row = (
  fields: Partial<ImportPreviewRow> & { code: string },
  kind: ImportPreviewRow['kind'] = 'item',
): ImportPreviewRow => {
  rowNumber += 1;
  const target = LINES.find((l) => l.code === fields.code);
  return {
    rowNumber,
    kind,
    raw: {
      code: fields.code,
      description: null,
      unit: null,
      quantity: fields.quantity === undefined ? '1' : fields.quantity,
      unitPrice: null,
      workType: null,
      amount: null,
      scope: fields.scope ?? null,
    },
    description: target?.description ?? null,
    unit: target?.unit ?? null,
    quantity: '1',
    unitPrice: '1',
    workType: null,
    scope: null,
    sheetAmount: null,
    amount: null,
    issues: [],
    ...fields,
  };
};

const codesOf = (r: ImportPreviewRow): ImportRowIssueCode[] => r.issues.map((i) => i.code);
const check = (rows: ImportPreviewRow[], ctx = context()) => annotateContractorSheet(rows, ctx);
const boxRow = (scope: string | null, quantity: string, unitPrice: string) =>
  row({ code: '2-12-4-8', scope, quantity, unitPrice });

describe('contractor sheet against the work order', () => {
  it('accepts a clean row and keeps headings untouched', () => {
    const [clean, heading] = check([
      row({ code: '1-1', quantity: '10', unitPrice: '10' }),
      row({ code: '1' }, 'heading'),
    ]);
    expect(clean?.issues).toEqual([]);
    expect(heading?.kind).toBe('heading');
    expect(heading?.issues).toEqual([]);
  });

  it('owner example: the fourth scope fits exactly, spacing does not make a new scope', () => {
    const [ok] = check([boxRow('لحام  البوكس', '75', '833.12')], context(OWNER_HOLDINGS));
    expect(ok?.issues).toEqual([]);
  });

  it('owner example: one more unit of the same scope is QUANTITY_EXCEEDS_WORK_ORDER', () => {
    const [over] = check([boxRow('لحام  البوكس', '76', '833.12')], context(OWNER_HOLDINGS));
    expect(codesOf(over!)).toEqual(['QUANTITY_EXCEEDS_WORK_ORDER']);
    expect(over?.issues[0]?.params).toEqual({
      scope: 'لحام  البوكس',
      workOrderQuantity: '225',
      reservedQuantity: '150',
      availableQuantity: '75',
    });
  });

  it('owner example: a price above the room is PRICE_EXCEEDS_CONTRACT with the numbers', () => {
    const [over] = check([boxRow('لحام  البوكس', '75', '834')], context(OWNER_HOLDINGS));
    expect(codesOf(over!)).toEqual(['PRICE_EXCEEDS_CONTRACT']);
    expect(over?.issues[0]?.params).toEqual({
      scope: 'لحام  البوكس',
      contractPrice: '2033.12',
      otherScopesPrice: '1200',
      maxAllowedPrice: '833.12',
    });
  });

  it('owner example: a whole row on a line held by scopes is WHOLE_AND_SCOPES_MIXED', () => {
    const [mixed] = check([boxRow(null, '10', '100')], context(OWNER_HOLDINGS));
    expect(codesOf(mixed!)).toContain('WHOLE_AND_SCOPES_MIXED');
  });

  it('a scoped row on a line held whole is WHOLE_AND_SCOPES_MIXED', () => {
    const [mixed] = check([boxRow(SCOPE_A, '10', '100')], context([held(null, '50', '100')]));
    expect(codesOf(mixed!)).toContain('WHOLE_AND_SCOPES_MIXED');
  });

  it('whole and scoped rows in one sheet are both flagged', () => {
    const rows = check([boxRow(null, '10', '100'), boxRow(SCOPE_A, '10', '100')]);
    expect(rows.map(codesOf)).toEqual([['WHOLE_AND_SCOPES_MIXED'], ['WHOLE_AND_SCOPES_MIXED']]);
  });

  it('the same code and scope twice in a sheet is CODE_SCOPE_REPEATED on both rows', () => {
    const rows = check([boxRow(SCOPE_A, '10', '100'), boxRow('تركيب  الخوصة', '10', '100')]);
    expect(rows.map(codesOf)).toEqual([['CODE_SCOPE_REPEATED'], ['CODE_SCOPE_REPEATED']]);
    expect(rows[0]?.issues[0]?.params).toMatchObject({ otherRows: String(rows[1]?.rowNumber) });
  });

  it('the same code with different scopes is fine', () => {
    const rows = check([boxRow(SCOPE_A, '225', '300'), boxRow(SCOPE_B, '225', '900')]);
    expect(rows.map(codesOf)).toEqual([[], []]);
  });

  it('counts the other scopes of the same sheet in the price sum', () => {
    const rows = check([boxRow(SCOPE_A, '10', '1500'), boxRow(SCOPE_B, '10', '600')]);
    expect(rows.map(codesOf)).toEqual([['PRICE_EXCEEDS_CONTRACT'], ['PRICE_EXCEEDS_CONTRACT']]);
    expect(rows[0]?.issues[0]?.params).toMatchObject({
      otherScopesPrice: '600',
      maxAllowedPrice: '1433.12',
    });
  });

  it('a scope that already has contractors counts at its highest price', () => {
    // Existing high 500 for C; a row at 100 on C still counts C at 500, so A+B+C = 1700 is fine.
    const [low] = check([boxRow(SCOPE_C, '10', '100')], context(OWNER_HOLDINGS));
    expect(low?.issues).toEqual([]);
    // A sheet row on a new scope D needs room: 2033.12 - 1700 = 333.12.
    const [fits, over] = [
      check([boxRow('نطاق جديد', '1', '333.12')], context(OWNER_HOLDINGS))[0],
      check([boxRow('نطاق جديد', '1', '333.13')], context(OWNER_HOLDINGS))[0],
    ];
    expect(fits?.issues).toEqual([]);
    expect(codesOf(over!)).toEqual(['PRICE_EXCEEDS_CONTRACT']);
  });

  it('counts other contractors and the sheet itself against the quantity of a scope', () => {
    const [first, second] = check(
      [boxRow(SCOPE_A, '100', '10'), boxRow(SCOPE_A, '100', '10')],
      context([held(SCOPE_A, '100', '10')]),
    );
    // 100 held + 100 other row + 100 own = 300 > 225 for both.
    expect(codesOf(first!)).toContain('QUANTITY_EXCEEDS_WORK_ORDER');
    expect(
      second?.issues.find((i) => i.code === 'QUANTITY_EXCEEDS_WORK_ORDER')?.params,
    ).toMatchObject({
      reservedQuantity: '200',
      availableQuantity: '25',
    });
  });

  it('NOT_IN_WORK_ORDER, WORK_ORDER_MISMATCH per field, LEGACY_WORK_ORDER_LINE', () => {
    const [unknown, mismatch, legacy] = check([
      row({ code: '9-9', description: 'x', unit: 'y' }),
      row({ code: '1-1', description: 'غير الحفر', unit: 'كم' }),
      row({ code: 'OLD', quantity: '1', unitPrice: '1' }),
    ]);
    expect(codesOf(unknown!)).toEqual(['NOT_IN_WORK_ORDER']);
    expect(mismatch?.issues.map((i) => [i.code, i.field, i.params])).toEqual([
      ['WORK_ORDER_MISMATCH', 'description', { workOrderValue: 'حفر' }],
      ['WORK_ORDER_MISMATCH', 'unit', { workOrderValue: 'م.ط' }],
    ]);
    expect(codesOf(legacy!)).toEqual(['LEGACY_WORK_ORDER_LINE']);
  });

  it('LINE_ALREADY_ASSIGNED when appending a line and scope the registration holds', () => {
    const ctx = context([held(SCOPE_A, '10', '10')], [slotOf(BOX, scopeKeyOf(SCOPE_A))]);
    const [again, other] = check(
      [boxRow('تركيب  الخوصة', '5', '10'), boxRow(SCOPE_B, '5', '10')],
      ctx,
    );
    expect(codesOf(again!)).toContain('LINE_ALREADY_ASSIGNED');
    expect(codesOf(other!)).toEqual([]);
  });

  it('an empty quantity skips the row with only the warning', () => {
    const [skipped] = check([row({ code: '1-1', quantity: null })]);
    expect(skipped?.kind).toBe('skipped');
    expect(codesOf(skipped!)).toEqual(['EMPTY_QUANTITY_SKIPPED']);
  });
});

describe('selecting the rows to commit', () => {
  const parsed = (rows: ImportPreviewRow[]) =>
    ({ fileIssues: [], rows, sheets: [], sheetName: 's', headerRow: 1 }) as never;

  it('keeps item rows only and refuses row errors, file issues and an empty selection', () => {
    const ok = selectContractorRows(
      parsed(
        check([row({ code: '1-1', quantity: '1', unitPrice: '1' }), row({ code: '1' }, 'heading')]),
      ),
    );
    expect(ok.ok && ok.rows).toHaveLength(1);

    const errors = selectContractorRows(parsed(check([row({ code: '9-9' })])));
    expect(errors).toMatchObject({ ok: false, details: { reason: 'ROW_ERRORS' } });

    const none = selectContractorRows(parsed(check([row({ code: '1' }, 'heading')])));
    expect(none).toMatchObject({ ok: false, details: { reason: 'NO_ROWS_INCLUDED' } });

    const issues = selectContractorRows({
      ...(parsed([]) as object),
      fileIssues: [{ code: 'REQUIRED_FIELD_UNMAPPED', field: 'unit' }],
    } as never);
    expect(issues).toMatchObject({ ok: false, details: { reason: 'FILE_ISSUES' } });
  });
});
