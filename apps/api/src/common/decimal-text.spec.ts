import { describe, expect, it } from 'vitest';
import { toDecimalText, toDecimalTextOrNull } from './decimal-text.js';

describe('toDecimalText', () => {
  it.each([
    ['12.500', '12.5'],
    ['1.000', '1'],
    ['0.950', '0.95'],
    ['0.000', '0'],
    ['-0.000', '0'],
    ['-3.250', '-3.25'],
    ['100', '100'],
    ['100.0', '100'],
    ['007.10', '7.1'],
    ['0.0254', '0.0254'],
    ['1000.000000', '1000'],
  ])('%s -> %s', (input, expected) => {
    expect(toDecimalText(input)).toBe(expected);
  });

  it('rejects anything that is not plain decimal text', () => {
    expect(() => toDecimalText('1e3')).toThrow(RangeError);
    expect(() => toDecimalText('NaN')).toThrow(RangeError);
    expect(() => toDecimalText('')).toThrow(RangeError);
  });

  it('passes null through', () => {
    expect(toDecimalTextOrNull(null)).toBeNull();
    expect(toDecimalTextOrNull('2.50')).toBe('2.5');
  });
});
