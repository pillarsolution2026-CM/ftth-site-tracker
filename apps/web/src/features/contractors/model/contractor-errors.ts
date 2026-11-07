import { CONTRACTOR_CONFLICT_REASONS, type ContractorLine } from '@ftth/shared';
import { ltr, type Locale, type MessageKey } from '@ftth/i18n';
import { ApiClientError, errorCodeOf } from '@/shared/api/bff-client';
import { formatDecimal, multiplyDecimals, sumDecimals } from '@/shared/lib/decimal';
import type { Msg } from './contractor-forms';

const PARAM_KEYS = [
  'code',
  'workOrderQuantity',
  'reservedQuantity',
  'requestedQuantity',
  'availableQuantity',
  'contractPrice',
  'requestedPrice',
  'latestEffectiveFrom',
] as const;

/**
 * A failed contractor call as a message: the 409 `details.reason` in words with its numbers,
 * else the generic text of the error code.
 */
export function contractorErrorMsg(error: unknown): Msg {
  if (error instanceof ApiClientError && error.code === 'CONFLICT') {
    const details = error.details;
    if (typeof details === 'object' && details !== null) {
      const record = details as Record<string, unknown>;
      const reason = CONTRACTOR_CONFLICT_REASONS.find((candidate) => candidate === record.reason);
      if (reason) {
        const params: Record<string, string> = {};
        for (const key of PARAM_KEYS) {
          const value = record[key];
          if (typeof value === 'string' || typeof value === 'number') params[key] = String(value);
        }
        return { key: `contractors.reasons.${reason}`, params };
      }
    }
  }
  return { key: `errors.${errorCodeOf(error)}` };
}

/**
 * Translates a message. Numbers are grouped for the locale and isolated left-to-right, so they
 * read correctly inside Arabic text; codes and dates are isolated too.
 */
export function translateMsg(
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  locale: Locale,
  message: Msg,
): string {
  const params = Object.fromEntries(
    Object.entries(message.params ?? {}).map(([key, value]) => [
      key,
      ltr(/^-?\d+(\.\d+)?$/.test(value) ? formatDecimal(value, locale) : value),
    ]),
  );
  return t(message.key, params);
}

/** The price in force now: the newest one (prices come oldest first). */
export function latestPrice(line: ContractorLine) {
  return line.prices[line.prices.length - 1];
}

/** Exact total of a contractor: Σ quantity × latest price. Decimal strings, never floats. */
export function registrationTotal(lines: readonly ContractorLine[]): string {
  return sumDecimals(
    lines.map((line) => multiplyDecimals(line.quantity, latestPrice(line)?.unitPrice ?? '0')),
  );
}
