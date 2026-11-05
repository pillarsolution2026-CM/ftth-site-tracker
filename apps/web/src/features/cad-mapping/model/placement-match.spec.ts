import type { PlacementItem } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { itemLabel, itemOption, normalizeCode, suggestMatches } from './placement-match';

const item = (handle: string, code: string | null, names: string[] = []): PlacementItem => ({
  handle,
  featureType: 'cabinet',
  code,
  names,
  layer: 'L',
  x: 0,
  y: 0,
});
const mark = (id: string, name: string) => ({ id, name, lat: 30, lon: 31 });

describe('normalizeCode', () => {
  it('drops type words, spaces and case', () => {
    expect(normalizeCode('Cab 1-7')).toBe('1-7');
    expect(normalizeCode('cabinet 1 - 7')).toBe('1-7');
    expect(normalizeCode(' hh-04b ')).toBe('04B');
    expect(normalizeCode('HH04B')).toBe('04B');
    expect(normalizeCode('04B')).toBe('04B');
    // A word that only starts like a type word is kept.
    expect(normalizeCode('Cabo')).toBe('CABO');
  });
});

describe('suggestMatches', () => {
  it('matches a placemark to the one item with the same code (ADR-035 examples)', () => {
    const items = [item('C1', '1-7'), item('H1', '04B'), item('X', null)];
    expect(
      suggestMatches([mark('a', 'Cab 1-7'), mark('b', '04B'), mark('c', 'Road')], items),
    ).toEqual({ a: 'C1', b: 'H1' });
  });

  it('matches a text written around an item without a code (cabinet "1-7" in Rabaa)', () => {
    const items = [item('C1', null, ['22U', '1-7']), item('C2', null, ['22U', '1-6'])];
    expect(suggestMatches([mark('a', 'Cab 1-7'), mark('b', '22U')], items)).toEqual({ a: 'C1' });
  });

  it('suggests nothing when a code is ambiguous or an item is claimed twice', () => {
    expect(suggestMatches([mark('a', '1-7')], [item('C1', '1-7'), item('C2', '1 - 7')])).toEqual(
      {},
    );
    expect(suggestMatches([mark('a', '1-7'), mark('b', 'Cab 1-7')], [item('C1', '1-7')])).toEqual(
      {},
    );
  });

  it('labels an item by its code, else its handle, with its texts in lists', () => {
    expect(itemLabel(item('C1', '1-7'))).toBe('1-7');
    expect(itemLabel(item('C1', null, ['1-7']))).toBe('#C1');
    expect(itemOption(item('C1', null, ['22U', '1-7']))).toBe('#C1 (22U · 1-7)');
    expect(itemOption(item('C1', '04B'))).toBe('04B');
  });
});
