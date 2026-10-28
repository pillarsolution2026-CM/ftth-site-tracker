import { z } from 'zod';

/**
 * Decimals travel as strings so no float ever touches money or quantities (ADR-011).
 * Inputs have at most 14 integer digits. Quantities keep 4 fraction digits (numeric(18,4));
 * unit prices keep 6 (numeric(20,6), ADR-016).
 */
export const DECIMAL4_PATTERN = /^(0|[1-9]\d{0,13})(\.\d{1,4})?$/;
export const DECIMAL6_PATTERN = /^(0|[1-9]\d{0,13})(\.\d{1,6})?$/;

/** Max integer digits of any input decimal (quantity or unit price). */
export const INPUT_MAX_INTEGER_DIGITS = 14;
/** Max fraction digits of a quantity. */
export const QUANTITY_MAX_DECIMALS = 4;
/** Max fraction digits of a unit price (ADR-016). */
export const UNIT_PRICE_MAX_DECIMALS = 6;

/** Any exact decimal emitted by the API (amounts and totals may carry up to 10 fraction digits). */
export const DECIMAL_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Quantity input: non-negative decimal string, ≤ 14 integer and ≤ 4 fraction digits. Never a number. */
export const Decimal4StringSchema = z
  .string()
  .regex(DECIMAL4_PATTERN, 'Expected a non-negative decimal string with at most 4 decimals');
export type Decimal4String = z.infer<typeof Decimal4StringSchema>;

/** Unit-price input: non-negative decimal string, ≤ 14 integer and ≤ 6 fraction digits. */
export const Decimal6StringSchema = z
  .string()
  .regex(DECIMAL6_PATTERN, 'Expected a non-negative decimal string with at most 6 decimals');
export type Decimal6String = z.infer<typeof Decimal6StringSchema>;

/** Output: exact decimal string, shortest form without trailing zeros (e.g. "12.5", "0", "-3.25"). */
export const DecimalStringSchema = z.string().regex(DECIMAL_PATTERN, 'Expected a decimal string');
export type DecimalString = z.infer<typeof DecimalStringSchema>;

/** ISO 4217 code, copied from the project. */
export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 code');
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;
