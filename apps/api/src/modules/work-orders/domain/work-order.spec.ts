import { describe, expect, it } from 'vitest';
import type { IdGenerator } from '../../../common/clock.js';
import { Decimal } from './decimal.js';
import { itemAmount, WorkOrder, type NewItem } from './work-order.js';

let counter = 0;
const ids: IdGenerator = {
  next: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
};
const now = new Date('2026-10-27T10:00:00Z');

const item = (code: string, quantity: string, unitPrice: string): NewItem => ({
  code,
  description: `desc ${code}`,
  unit: 'm',
  quantity: Decimal.parse(quantity),
  unitPrice: Decimal.parse(unitPrice),
  workType: 'civil',
});

function orderWith(items: NewItem[], accepted: string[] = []): WorkOrder {
  return WorkOrder.create(
    {
      projectId: 'p',
      number: 'WO-1',
      currency: 'EGP',
      source: 'manual',
      items,
      acceptedDuplicateCodes: accepted,
      createdById: 'u',
    },
    ids,
    now,
  );
}

describe('WorkOrder', () => {
  it('numbers items 1..n in order and starts at version 1', () => {
    const order = orderWith([item('A', '1', '1'), item('B', '1', '1')]);
    expect(order.items.map((i) => i.lineNo)).toEqual([1, 2]);
    expect(order.header.version).toBe(1);
    expect(order.header.title).toBeNull();
  });

  it('totals Σ quantity × unit price exactly', () => {
    const order = orderWith([
      item('A', '0.1', '0.2'),
      item('B', '3', '33.3333'),
      item('C', '12.5', '4'),
    ]);
    expect(itemAmount(order.items[0] as never).toString()).toBe('0.02');
    expect(order.total.toString()).toBe('150.0199');
  });

  it('refuses duplicate codes that were not accepted, and keeps accepted ones as separate lines', () => {
    const items = [item('A', '1', '1'), item('A', '2', '1')];
    expect(() => orderWith(items)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    const order = orderWith(items, ['A']);
    expect(order.items).toHaveLength(2);
    expect(order.duplicateCodes()).toEqual([{ code: 'A', lineNos: [1, 2] }]);
  });

  it('adds an item at max+1 (line numbers are not compacted) and rejects a taken line', () => {
    const order = orderWith([item('A', '1', '1'), item('B', '1', '1'), item('C', '1', '1')]);
    const without = new WorkOrder(
      order.header,
      [order.items[0], order.items[2]].filter(Boolean) as never,
    );
    expect(without.nextLineNo()).toBe(4);
    const values = item('D', '1', '1');
    expect(without.buildItem(values, { acceptDuplicateCode: false }, ids, now).lineNo).toBe(4);
    expect(() =>
      without.buildItem(values, { lineNo: 3, acceptDuplicateCode: false }, ids, now),
    ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(
      without.buildItem(values, { lineNo: 2, acceptDuplicateCode: false }, ids, now).lineNo,
    ).toBe(2);
  });

  it('needs explicit acceptance to add or rename to an existing code', () => {
    const order = orderWith([item('A', '1', '1'), item('B', '1', '1')]);
    expect(() =>
      order.buildItem(item('A', '1', '1'), { acceptDuplicateCode: false }, ids, now),
    ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(order.buildItem(item('A', '1', '1'), { acceptDuplicateCode: true }, ids, now).code).toBe(
      'A',
    );

    const second = order.items[1];
    expect(() => order.changeItem(second?.id ?? '', { code: 'A' }, false, now)).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    expect(order.changeItem(second?.id ?? '', { code: 'A' }, true, now).after.code).toBe('A');
    // Keeping its own code is not a duplicate.
    expect(
      order.changeItem(second?.id ?? '', { code: 'B', unit: 'km' }, false, now).after.unit,
    ).toBe('km');
  });

  it('changes only the given fields', () => {
    const order = orderWith([item('A', '2', '5')]);
    const { before, after } = order.changeItem(
      order.items[0]?.id ?? '',
      { quantity: Decimal.parse('3') },
      false,
      now,
    );
    expect(before.quantity.toString()).toBe('2');
    expect(after).toMatchObject({ code: 'A', unit: 'm' });
    expect(itemAmount(after).toString()).toBe('15');
  });

  it('compares the optimistic version', () => {
    const order = orderWith([]);
    expect(() => order.assertVersion(1)).not.toThrow();
    expect(() => order.assertVersion(2)).toThrow(
      expect.objectContaining({
        code: 'CONFLICT',
        details: expect.objectContaining({ reason: 'VERSION_MISMATCH' }),
      }),
    );
  });

  it('answers NOT_FOUND for an unknown item', () => {
    expect(() => orderWith([]).findItem('x')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });

  it('keeps the work type on edits and lets an edit change it', () => {
    const order = orderWith([item('A', '1', '1')]);
    const id = order.items[0]?.id ?? '';
    expect(order.changeItem(id, { unit: 'km' }, false, now).after.workType).toBe('civil');
    expect(order.changeItem(id, { workType: 'planning' }, false, now).after.workType).toBe(
      'planning',
    );
  });

  it('makes the first edit of an item saved before ADR-016 set a work type', () => {
    const created = orderWith([item('A', '1', '1')]);
    const legacy = new WorkOrder(
      created.header,
      created.items.map((existing) => ({ ...existing, workType: null })),
    );
    const id = legacy.items[0]?.id ?? '';
    expect(() => legacy.changeItem(id, { unit: 'km' }, false, now)).toThrow(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
        details: { reason: 'WORK_TYPE_REQUIRED' },
      }),
    );
    expect(legacy.changeItem(id, { workType: 'installation' }, false, now).after.workType).toBe(
      'installation',
    );
  });
});
