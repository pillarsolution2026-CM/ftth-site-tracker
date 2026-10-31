import { describe, expect, it } from 'vitest';
import {
  AddWorkOrderItemRequestSchema,
  CreateWorkOrderRequestSchema,
  unacceptedDuplicateCodes,
  UpdateWorkOrderItemRequestSchema,
  UpdateWorkOrderRequestSchema,
  WorkOrderItemInputSchema,
  WorkOrderSummarySchema,
} from './work-order.schemas.js';

const item = {
  code: 'C-101',
  description: 'حفر وردم',
  unit: 'm',
  quantity: '120.5',
  unitPrice: '35.25',
  workType: 'civil',
};

describe('WorkOrderItemInputSchema', () => {
  it('accepts a valid item and trims text', () => {
    expect(WorkOrderItemInputSchema.parse({ ...item, code: '  C-101 ' }).code).toBe('C-101');
  });

  it.each(['code', 'description', 'unit', 'quantity', 'unitPrice', 'workType'] as const)(
    'requires %s',
    (field) => {
      const partial = Object.fromEntries(Object.entries(item).filter(([key]) => key !== field));
      expect(WorkOrderItemInputSchema.safeParse(partial).success).toBe(false);
    },
  );

  it('rejects negative, float and over-precise money', () => {
    expect(WorkOrderItemInputSchema.safeParse({ ...item, quantity: '-1' }).success).toBe(false);
    expect(WorkOrderItemInputSchema.safeParse({ ...item, unitPrice: 35.25 }).success).toBe(false);
    const overPrecise = { ...item, unitPrice: '1.0000001' };
    expect(WorkOrderItemInputSchema.safeParse(overPrecise).success).toBe(false);
  });

  it('keeps 4 decimals for quantities and 6 for unit prices (ADR-016)', () => {
    expect(WorkOrderItemInputSchema.safeParse({ ...item, unitPrice: '5.59936' }).success).toBe(
      true,
    );
    expect(WorkOrderItemInputSchema.safeParse({ ...item, unitPrice: '1.000001' }).success).toBe(
      true,
    );
    expect(WorkOrderItemInputSchema.safeParse({ ...item, quantity: '1.0001' }).success).toBe(true);
    expect(WorkOrderItemInputSchema.safeParse({ ...item, quantity: '1.00001' }).success).toBe(
      false,
    );
  });

  it('accepts units up to 64 characters (ADR-016)', () => {
    const unit = 'BULDING (more than 8 unit/flat per building)';
    expect(WorkOrderItemInputSchema.safeParse({ ...item, unit }).success).toBe(true);
    expect(WorkOrderItemInputSchema.safeParse({ ...item, unit: 'u'.repeat(64) }).success).toBe(
      true,
    );
    expect(WorkOrderItemInputSchema.safeParse({ ...item, unit: 'u'.repeat(65) }).success).toBe(
      false,
    );
  });

  it('accepts only the fixed work types', () => {
    for (const workType of ['civil', 'installation', 'planning'])
      expect(WorkOrderItemInputSchema.safeParse({ ...item, workType }).success).toBe(true);
    expect(WorkOrderItemInputSchema.safeParse({ ...item, workType: 'مدني' }).success).toBe(false);
    expect(WorkOrderItemInputSchema.safeParse({ ...item, workType: 'other' }).success).toBe(false);
  });

  it('rejects blank text after trimming', () => {
    expect(WorkOrderItemInputSchema.safeParse({ ...item, unit: '   ' }).success).toBe(false);
  });
});

const CONTRACT_ITEM_ID = '2d8f6a4e-3c1d-4a8e-9f7b-2d5c6e7f8a91';

describe('CreateWorkOrderRequestSchema', () => {
  it('accepts a header without items and applies defaults', () => {
    const parsed = CreateWorkOrderRequestSchema.parse({ number: 'WO-2026-01' });
    expect(parsed.lines).toEqual([]);
  });

  it('requires a number', () => {
    expect(CreateWorkOrderRequestSchema.safeParse({ number: ' ' }).success).toBe(false);
  });

  it('validates issuedOn as a calendar date', () => {
    expect(
      CreateWorkOrderRequestSchema.safeParse({ number: 'A', issuedOn: '2026-10-27' }).success,
    ).toBe(true);
    expect(
      CreateWorkOrderRequestSchema.safeParse({ number: 'A', issuedOn: '27/10/2026' }).success,
    ).toBe(false);
  });

  it('takes lines of contract items and refuses the same contract item twice (ADR-028)', () => {
    const line = { contractItemId: CONTRACT_ITEM_ID, quantity: '50' };
    expect(CreateWorkOrderRequestSchema.safeParse({ number: 'A', lines: [line] }).success).toBe(
      true,
    );
    expect(
      CreateWorkOrderRequestSchema.safeParse({
        number: 'A',
        lines: [line, { ...line, quantity: '20' }],
      }).success,
    ).toBe(false);
    // Free-text items are no longer accepted: the line comes from the contract.
    expect(
      CreateWorkOrderRequestSchema.safeParse({ number: 'A', lines: [{ ...item }] }).success,
    ).toBe(false);
  });
});

describe('unacceptedDuplicateCodes', () => {
  it('lists each repeated code once, minus accepted ones', () => {
    const items = [{ code: 'A' }, { code: 'B' }, { code: 'A' }, { code: 'C' }, { code: 'C' }];
    expect(unacceptedDuplicateCodes(items, [])).toEqual(['A', 'C']);
    expect(unacceptedDuplicateCodes(items, ['C'])).toEqual(['A']);
  });
});

describe('update requests', () => {
  it('requires expectedVersion and at least one field on the header', () => {
    expect(UpdateWorkOrderRequestSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(UpdateWorkOrderRequestSchema.safeParse({ title: 'x' }).success).toBe(false);
    const clearTitle = { expectedVersion: 2, title: null };
    expect(UpdateWorkOrderRequestSchema.safeParse(clearTitle).success).toBe(true);
  });

  it('edits only the quantity of a line', () => {
    expect(UpdateWorkOrderItemRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateWorkOrderItemRequestSchema.parse({ quantity: '3' })).toEqual({ quantity: '3' });
    expect(
      UpdateWorkOrderItemRequestSchema.safeParse({ quantity: '3', unitPrice: '1' }).success,
    ).toBe(false);
  });

  it('adds a contract item with optional lineNo', () => {
    const line = { contractItemId: CONTRACT_ITEM_ID, quantity: '1' };
    expect(AddWorkOrderItemRequestSchema.parse(line).lineNo).toBeUndefined();
    expect(AddWorkOrderItemRequestSchema.safeParse({ ...line, lineNo: 0 }).success).toBe(false);
    expect(AddWorkOrderItemRequestSchema.safeParse(item).success).toBe(false);
  });
});

describe('WorkOrderSummarySchema', () => {
  it('carries totals as decimal strings', () => {
    const summary = {
      id: '0b8f6a4e-3c1d-4a8e-9f7b-2d5c6e7f8a90',
      projectId: '1c9f7b5e-4d2e-4b9f-8a6c-3e6d7f8a9b01',
      number: 'WO-1',
      title: null,
      issuedOn: null,
      currency: 'EGP',
      source: 'manual',
      itemCount: 1,
      total: '4247.625',
      attachmentCount: 0,
      version: 1,
      createdAt: '2026-10-27T10:00:00.000Z',
      updatedAt: '2026-10-27T10:00:00.000Z',
    };
    expect(WorkOrderSummarySchema.safeParse(summary).success).toBe(true);
    expect(WorkOrderSummarySchema.safeParse({ ...summary, total: 4247.625 }).success).toBe(false);
  });
});
