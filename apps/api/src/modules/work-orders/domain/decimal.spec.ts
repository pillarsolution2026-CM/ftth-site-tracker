import { describe, expect, it } from 'vitest';
import { Decimal, sumDecimals } from './decimal.js';

const d = (text: string) => Decimal.parse(text);

describe('Decimal', () => {
  it.each([
    ['0', '0'],
    ['12.5000', '12.5'],
    ['007', '7'],
    ['-3.250', '-3.25'],
    ['-0', '0'],
    ['0.0001', '0.0001'],
    ['100.00', '100'],
  ])('parses %s as the shortest exact form %s', (input, expected) => {
    expect(d(input).toString()).toBe(expected);
  });

  it.each(['', '1e3', '+1', '1,5', '.5', '5.', 'abc', ' 1', '1 '])('rejects %j', (input) => {
    expect(() => Decimal.parse(input)).toThrow(RangeError);
  });

  it('adds without float error (0.1 + 0.2 = 0.3 exactly)', () => {
    expect(d('0.1').add(d('0.2')).toString()).toBe('0.3');
    expect(d('0.1').add(d('0.2')).equals(d('0.3'))).toBe(true);
  });

  it('multiplies exactly, keeping every digit (scale 8 for two 4-decimal inputs)', () => {
    expect(d('0.0001').mul(d('0.0001')).toString()).toBe('0.00000001');
    expect(d('12.5').mul(d('4')).toString()).toBe('50');
    expect(d('99999999999999.9999').mul(d('99999999999999.9999')).toString()).toBe(
      '9999999999999999980000000000.00000001',
    );
  });

  it('compares and sums', () => {
    expect(d('1.10').compare(d('1.1'))).toBe(0);
    expect(d('1.2').compare(d('1.19'))).toBe(1);
    expect(d('-1').compare(d('0'))).toBe(-1);
    expect(sumDecimals([d('0.1'), d('0.2'), d('0.3')]).toString()).toBe('0.6');
    expect(sumDecimals([]).toString()).toBe('0');
  });

  it.each([
    ['2.5', 0, '3'],
    ['2.4999', 0, '2'],
    ['-2.5', 0, '-3'],
    ['99.999', 2, '100'],
    ['1.005', 2, '1.01'],
    ['1.5', 3, '1.5'],
  ])('rounds %s half away from zero at %i decimals to %s', (input, scale, expected) => {
    expect(d(input).roundHalfUp(scale).toString()).toBe(expected);
  });

  it('knows its sign', () => {
    expect(d('-0.0001').isNegative()).toBe(true);
    expect(d('0').isNegative()).toBe(false);
  });
});
