import { describe, expect, it } from 'vitest';
import { matchHeaderRow, normalizeHeader } from './header-matching.js';
import type { RawCell } from './raw-workbook.js';

const texts = (...values: string[]): RawCell[] => values.map((value) => ({ kind: 'text', value }));

describe('normalizeHeader', () => {
  it.each([
    ['الإجمالي', 'الاجمالي'],
    ['  الكمّية  ', 'الكميه'],
    ['سعر   الوحدة', 'سعر الوحده'],
    ['الفئـــة', 'الفيه'], // hamza-on-yeh decomposes to a plain yeh; synonyms are normalised the same way
    ['Désignation', 'designation'],
    ['UNIT  PRICE', 'unit price'],
    ['مُتَر', 'متر'],
  ])('%j becomes %j', (input, expected) => {
    expect(normalizeHeader(input)).toBe(expected);
  });
});

describe('matchHeaderRow', () => {
  it('matches whole words only: "rate" does not match "separate"', () => {
    expect(matchHeaderRow(texts('separate', 'rate')).mapping.unitPrice).toBe(1);
    expect(matchHeaderRow(texts('separate')).matched).toBe(0);
  });

  it('uses a header that merely contains a synonym ("الكمية المطلوبة", "Unit price (EGP)")', () => {
    const { mapping } = matchHeaderRow(texts('الكمية المطلوبة', 'Unit price (EGP)'));
    expect(mapping).toMatchObject({ quantity: 0, unitPrice: 1 });
  });

  it('gives each column to one field only', () => {
    const { mapping, matched } = matchHeaderRow(texts('Item Description'));
    expect(matched).toBe(1);
    expect(mapping.description).toBe(0);
    expect(mapping.code).toBeNull();
  });

  it('ignores numeric and blank cells', () => {
    const cells: RawCell[] = [null, { kind: 'number', value: 2024 }, { kind: 'text', value: ' ' }];
    expect(matchHeaderRow(cells).matched).toBe(0);
  });
});
