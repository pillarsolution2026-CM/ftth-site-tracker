import { describe, expect, it } from 'vitest';
import { compareDecimals, subtractDecimals } from '@/shared/lib/decimal';
import { ITEM_A, ITEM_B, availability } from '@/test-utils/work-orders';
import { canSubmit, checkSelection, filterItems, linePayload } from './line-picker';
import { exceedsAvailable, validateQuantity } from './quantity-form';

const ITEMS = [
  availability(),
  availability({ contractItemId: ITEM_B, code: 'B-2', description: 'Splice closure' }),
];

describe('decimal helpers', () => {
  it('subtracts and compares exactly, without floats', () => {
    expect(subtractDecimals('0.3', '0.1')).toBe('0.2');
    expect(compareDecimals('0.30', '0.3')).toBe(0);
    expect(compareDecimals('70.0001', '70')).toBe(1);
    expect(compareDecimals('9', '10')).toBe(-1);
  });
});

describe('filterItems', () => {
  it('matches code or description, case-insensitively', () => {
    expect(filterItems(ITEMS, 'b-2').map((item) => item.code)).toEqual(['B-2']);
    expect(filterItems(ITEMS, 'trench').map((item) => item.code)).toEqual(['A-1']);
    expect(filterItems(ITEMS, '  ')).toHaveLength(2);
    expect(filterItems(ITEMS, 'zzz')).toHaveLength(0);
  });
});

describe('checkSelection', () => {
  it('accepts a quantity up to what is available', () => {
    const [check] = checkSelection(ITEMS, [{ contractItemId: ITEM_A, quantity: '70' }]);
    expect(check?.issues).toEqual([]);
    expect(check?.available).toBe('70');
  });

  it('warns when the quantity is above what is available, but does not block', () => {
    const checks = checkSelection(ITEMS, [{ contractItemId: ITEM_A, quantity: '70.0001' }]);
    expect(checks[0]?.issues).toEqual(['exceeds']);
    expect(canSubmit(checks)).toBe(true);
    expect(linePayload(checks)).toEqual([{ contractItemId: ITEM_A, quantity: '70.0001' }]);
  });

  it('blocks an empty or invalid quantity (more than 4 decimals, not a number)', () => {
    for (const quantity of ['', 'abc', '1.23456', '-1']) {
      const checks = checkSelection(ITEMS, [{ contractItemId: ITEM_A, quantity }]);
      expect(checks[0]?.issues, quantity).toContain('invalidQuantity');
      expect(canSubmit(checks)).toBe(false);
      expect(linePayload(checks)).toBeNull();
    }
  });

  it('normalises Arabic digits and flags an item chosen twice', () => {
    const checks = checkSelection(ITEMS, [
      { contractItemId: ITEM_A, quantity: '٥٫٥' },
      { contractItemId: ITEM_A, quantity: '1' },
    ]);
    expect(checks[0]?.quantity).toBe('5.5');
    expect(checks.every((check) => check.issues.includes('repeated'))).toBe(true);
    expect(canSubmit(checks)).toBe(false);
  });

  it('counts the quantity a line already holds when editing it', () => {
    const checks = checkSelection(ITEMS, [{ contractItemId: ITEM_A, quantity: '90' }], {
      [ITEM_A]: '20',
    });
    expect(checks[0]?.issues).toEqual([]);
  });
});

describe('quantity-only edit', () => {
  it('validates the quantity as a decimal string', () => {
    expect(validateQuantity(' 12.5 ')).toEqual({ ok: true, quantity: '12.5' });
    expect(validateQuantity('')).toEqual({ ok: false, error: 'validation.required' });
    expect(validateQuantity('1.00001')).toEqual({ ok: false, error: 'validation.decimal' });
  });

  it('exceeds only above available plus the quantity the line holds now', () => {
    expect(exceedsAvailable('90', '20', '70')).toBe(false);
    expect(exceedsAvailable('90.0001', '20', '70')).toBe(true);
  });
});
