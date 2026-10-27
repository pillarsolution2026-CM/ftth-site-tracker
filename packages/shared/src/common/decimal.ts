import { z } from 'zod';

/**
 * Decimals travel as strings so no float ever touches money or quantities (ADR-011).
 * PostgreSQL stores inputs as numeric(18,4): at most 14 integer digits and 4 fraction digits.
 */
export const DECIMAL4_PATTERN = /^(0|[1-9]\d{0,13})(\.\d{1,4})?$/;

/** Any exact decimal emitted by the API (amounts and totals may carry up to 8 fraction digits). */
export const DECIMAL_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Input: non-negative decimal string, max 14 integer digits and 4 fraction digits. Never a number. */
export const Decimal4StringSchema = z
  .string()
  .regex(DECIMAL4_PATTERN, 'Expected a non-negative decimal string with at most 4 decimals');
export type Decimal4String = z.infer<typeof Decimal4StringSchema>;

/** Output: exact decimal string, shortest form without trailing zeros (e.g. "12.5", "0", "-3.25"). */
export const DecimalStringSchema = z.string().regex(DECIMAL_PATTERN, 'Expected a decimal string');
export type DecimalString = z.infer<typeof DecimalStringSchema>;

/** ISO 4217 code, copied from the project. */
export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 code');
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;
