import { describe, expect, it } from 'vitest';
import type { IdGenerator } from '../../../common/clock.js';
import {
  assertWithinContract,
  availableQuantity,
  lineFromContract,
  type ApprovedContract,
  type ContractItemInfo,
} from './contract-lines.js';
import { Decimal } from './decimal.js';
import { itemAmount, WorkOrder, type NewItem } from './work-order.js';

let counter = 0;
const ids: IdGenerator = {
  next: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
};
const now = new Date('2026-10-27T10:00:00Z');

const contractItem = (
  id: string,
  code: string,
  quantity: string,
  unitPrice: string,
): ContractItemInfo => ({
  id,
  lineNo: 1,
  code,
  description: `desc ${code}`,
  unit: 'm',
  unitPrice: Decimal.parse(unitPrice),
  workType: 'civil',
  quantity: Decimal.parse(quantity),
});

const contract: ApprovedContract = {
  id: 'contract-1',
  number: 'C-1',
  items: [
    contractItem('ci-a', 'A', '100', '5'),
    contractItem('ci-b', 'B', '10.5', '33.3333'),
    contractItem('ci-c', 'C', '12.5', '4'),
  ],
};

const line = (itemId: string, quantity: string): NewItem =>
  lineFromContract(contract, itemId, Decimal.parse(quantity));

function orderWith(items: NewItem[]): WorkOrder {
  return WorkOrder.create(
    {
      projectId: 'p',
      number: 'WO-1',
      currency: 'EGP',
      source: 'manual',
      items,
      createdById: 'u',
    },
    ids,
    now,
  );
}

describe('WorkOrder', () => {
  it('numbers items 1..n in order, links them to the contract and starts at version 1', () => {
    const order = orderWith([line('ci-a', '1'), line('ci-b', '1')]);
    expect(order.items.map((i) => [i.lineNo, i.contractId, i.contractItemId])).toEqual([
      [1, 'contract-1', 'ci-a'],
      [2, 'contract-1', 'ci-b'],
    ]);
    expect(order.header.version).toBe(1);
    expect(order.header.title).toBeNull();
  });

  it('copies code, description, unit, price and work type from the contract item', () => {
    const copied = line('ci-b', '2');
    expect(copied).toMatchObject({
      code: 'B',
      description: 'desc B',
      unit: 'm',
      workType: 'civil',
    });
    expect(copied.unitPrice.toString()).toBe('33.3333');
  });

  it('totals Σ quantity × unit price exactly', () => {
    const order = orderWith([line('ci-a', '0.1'), line('ci-b', '3'), line('ci-c', '12.5')]);
    expect(itemAmount(order.items[0] as never).toString()).toBe('0.5');
    expect(order.total.toString()).toBe('150.4999');
  });

  it('refuses a line whose contract item is not in the contract', () => {
    expect(() => line('nope', '1')).toThrow(
      expect.objectContaining({
        code: 'CONFLICT',
        details: expect.objectContaining({ reason: 'NOT_IN_CONTRACT' }),
      }),
    );
  });

  it('refuses a contract item used twice', () => {
    expect(() => orderWith([line('ci-a', '1'), line('ci-a', '2')])).toThrow(
      expect.objectContaining({
        code: 'CONFLICT',
        details: expect.objectContaining({ reason: 'CONTRACT_ITEM_REPEATED' }),
      }),
    );
  });

  it('adds an item at max+1 (line numbers are not compacted) and rejects a taken line', () => {
    const order = orderWith([line('ci-a', '1'), line('ci-b', '1')]);
    const second = order.items[1];
    const without = new WorkOrder(order.header, [order.items[0]].filter(Boolean) as never);
    expect(without.nextLineNo()).toBe(2);
    expect(second?.lineNo).toBe(2);
    const added = without.buildItem(line('ci-c', '1'), {}, ids, now);
    expect(added.lineNo).toBe(2);
    expect(() => without.buildItem(line('ci-c', '1'), { lineNo: 1 }, ids, now)).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'LINE_TAKEN' }) }),
    );
    expect(without.buildItem(line('ci-c', '1'), { lineNo: 7 }, ids, now).lineNo).toBe(7);
  });

  it('refuses to add a contract item the order already uses', () => {
    const order = orderWith([line('ci-a', '1')]);
    expect(() => order.buildItem(line('ci-a', '1'), {}, ids, now)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'CONTRACT_ITEM_REPEATED' }),
      }),
    );
  });

  it('changes only the quantity of a line', () => {
    const order = orderWith([line('ci-a', '2')]);
    const { before, after } = order.changeQuantity(
      order.items[0]?.id ?? '',
      Decimal.parse('3'),
      now,
    );
    expect(before.quantity.toString()).toBe('2');
    expect(after).toMatchObject({ code: 'A', unit: 'm', contractItemId: 'ci-a' });
    expect(itemAmount(after).toString()).toBe('15');
  });

  it('refuses to edit a line saved before contract lines (LEGACY_ITEM)', () => {
    const created = orderWith([line('ci-a', '1')]);
    const legacy = new WorkOrder(
      created.header,
      created.items.map((existing) => ({ ...existing, contractId: null, contractItemId: null })),
    );
    expect(() => legacy.changeQuantity(legacy.items[0]?.id ?? '', Decimal.parse('2'), now)).toThrow(
      expect.objectContaining({
        code: 'CONFLICT',
        details: expect.objectContaining({ reason: 'LEGACY_ITEM' }),
      }),
    );
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
});

describe('reservation math', () => {
  const item = contractItem('ci-x', 'X', '10.5', '1');

  it('accepts up to exactly the contract quantity, with exact decimals', () => {
    expect(() =>
      assertWithinContract(item, Decimal.parse('0.1'), Decimal.parse('10.4')),
    ).not.toThrow();
    expect(availableQuantity(item, Decimal.parse('0.3')).toString()).toBe('10.2');
  });

  it('refuses one unit of the last digit above, with every number in the details', () => {
    expect(() =>
      assertWithinContract(item, Decimal.parse('0.1'), Decimal.parse('10.4001')),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFLICT',
        details: {
          reason: 'QUANTITY_EXCEEDS_CONTRACT',
          contractItemId: 'ci-x',
          code: 'X',
          contractQuantity: '10.5',
          reservedQuantity: '0.1',
          requestedQuantity: '10.4001',
          availableQuantity: '10.4',
        },
      }),
    );
  });

  it('reports no availability below zero for data that already exceeds', () => {
    expect(() => assertWithinContract(item, Decimal.parse('11'), Decimal.parse('1'))).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ availableQuantity: '0', reservedQuantity: '11' }),
      }),
    );
  });
});
