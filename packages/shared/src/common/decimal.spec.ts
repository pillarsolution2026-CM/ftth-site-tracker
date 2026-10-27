import { describe, expect, it } from 'vitest';
import { CurrencyCodeSchema, Decimal4StringSchema, DecimalStringSchema } from './decimal.js';

describe('Decimal4StringSchema (inputs: quantity, unit price)', () => {
  it.each(['0', '1', '12.5', '0.0001', '99999999999999.9999', '1.50'])('accepts %s', (value) => {
    expect(Decimal4StringSchema.safeParse(value).success).toBe(true);
  });

  it.each(['-1', '1.23456', '100000000000000', '1e3', '1,5', '.5', '5.', '01', ' 1', '', 'NaN'])(
    'rejects %j',
    (value) => {
      expect(Decimal4StringSchema.safeParse(value).success).toBe(false);
    },
  );

  it('rejects numbers: money never travels as a float', () => {
    expect(Decimal4StringSchema.safeParse(12.5).success).toBe(false);
  });
});

describe('DecimalStringSchema (outputs: amounts, totals)', () => {
  it.each(['0', '-3.25', '123456789012345678901234.12345678'])('accepts %s', (value) => {
    expect(DecimalStringSchema.safeParse(value).success).toBe(true);
  });

  it.each(['1e5', '+1', '1.', 'abc'])('rejects %j', (value) => {
    expect(DecimalStringSchema.safeParse(value).success).toBe(false);
  });
});

describe('CurrencyCodeSchema', () => {
  it('accepts ISO 4217 codes only', () => {
    expect(CurrencyCodeSchema.safeParse('EGP').success).toBe(true);
    expect(CurrencyCodeSchema.safeParse('egp').success).toBe(false);
    expect(CurrencyCodeSchema.safeParse('EG').success).toBe(false);
  });
});
