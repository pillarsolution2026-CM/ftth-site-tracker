import { describe, expect, it } from 'vitest';
import { formatDecimal, formatMoney, normalizeDecimalInput, sumDecimals } from './decimal';

describe('formatDecimal', () => {
  it('keeps every digit of a 14-digit amount with 8 decimals', () => {
    expect(formatDecimal('12345678901234.12345678', 'en')).toBe('12,345,678,901,234.12345678');
  });

  it('does not lose precision beyond double range', () => {
    expect(formatDecimal('9007199254740993.0001', 'en')).toBe('9,007,199,254,740,993.0001');
  });

  it('pads the fraction but never truncates', () => {
    expect(formatMoney('1234.5', 'EGP', 'en')).toBe('1,234.50 EGP');
    expect(formatDecimal('0.123456', 'en', { minFractionDigits: 2 })).toBe('0.123456');
    expect(formatDecimal('7', 'en')).toBe('7');
  });

  it('uses locale separators with Latin digits', () => {
    expect(formatDecimal('1234567.25', 'fr')).toMatch(/^1\s?234\s?567,25$/u);
    expect(formatDecimal('1234567.25', 'ar')).toBe('1,234,567.25');
  });

  it('handles negatives and returns non-decimals unchanged', () => {
    expect(formatDecimal('-1000', 'en')).toBe('-1,000');
    expect(formatDecimal('abc', 'en')).toBe('abc');
  });
});

describe('sumDecimals', () => {
  it('adds exactly where floats would drift', () => {
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimals(['99999999999999.9999', '0.0001'])).toBe('100000000000000');
  });

  it('is zero for no values and handles negatives', () => {
    expect(sumDecimals([])).toBe('0');
    expect(sumDecimals(['1.5', '-2.25'])).toBe('-0.75');
  });
});

describe('normalizeDecimalInput', () => {
  it('converts Arabic digits and separators', () => {
    expect(normalizeDecimalInput(' ١٢٣٫٥٠ ')).toBe('123.50');
    expect(normalizeDecimalInput('1 000,5')).toBe('1000.5');
  });
});
