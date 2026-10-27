import type { ImportRowIssueCode } from '@ftth/shared';
import { isBlank, type RawCell } from './raw-workbook.js';

/**
 * Plain decimal text of a JS number without exponent. Uses the shortest round-trip representation
 * (`String(n)`) and only rearranges its digits: no arithmetic, so no new float error is introduced.
 */
export function plainNumberString(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const text = String(value);
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign = '', first = '', fraction = '', exponent = '0'] = match;
  const digits = first + fraction;
  const pointAt = 1 + Number(exponent);
  if (pointAt <= 0) return `${sign}0.${'0'.repeat(-pointAt)}${digits}`;
  if (pointAt >= digits.length) return `${sign}${digits}${'0'.repeat(pointAt - digits.length)}`;
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

/** Displayed text of a cell; null for empty or unresolved cells. */
export function cellText(cell: RawCell | undefined): string | null {
  if (isBlank(cell) || !cell) return null;
  if (cell.kind === 'number') return plainNumberString(cell.value);
  if (cell.kind === 'text') return cell.value.trim();
  return null;
}

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/**
 * Text typed by a person into a numeric column: Arabic-Indic digits (٠-٩, ۰-۹) become ASCII,
 * `٫` becomes `.`, thousands separators (`٬`, `,`) and spaces (incl. no-break) are dropped.
 */
export function normalizeNumericText(text: string): string {
  return text
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - ARABIC_INDIC_ZERO))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - EXTENDED_ARABIC_INDIC_ZERO))
    .replace(/\u066b/g, '.')
    .replace(/\u2212/g, '-')
    .replace(/[\u066c,\s\u00a0\u202f]/g, '');
}

const PLAIN_NUMBER = /^(-?)(\d*)(?:\.(\d+))?$/;
const MAX_INTEGER_DIGITS = 14;
const MAX_FRACTION_DIGITS = 4;

export type NumberParse =
  | { ok: true; value: string }
  | { ok: false; code: ImportRowIssueCode; params?: Record<string, string | number> };

/** Splits plain numeric text into sign, integer digits (no leading zeros) and fraction (no trailing zeros). */
function splitPlainNumber(
  text: string,
): { negative: boolean; integer: string; fraction: string } | null {
  const match = PLAIN_NUMBER.exec(text);
  if (!match) return null;
  const [, sign = '', integerPart = '', fractionPart = ''] = match;
  if (integerPart === '' && fractionPart === '') return null;
  return {
    negative: sign === '-',
    integer: integerPart.replace(/^0+(?=\d)/, '') || '0',
    fraction: fractionPart.replace(/0+$/, ''),
  };
}

function numericSource(cell: RawCell | undefined): string | null {
  if (isBlank(cell) || !cell) return null;
  if (cell.kind === 'number') return plainNumberString(cell.value) ?? '';
  return cell.kind === 'text' ? normalizeNumericText(cell.value) : null;
}

/** Quantity or unit price: non-negative, ≤ 14 integer digits, ≤ 4 decimals (never rounded). */
export function parseInputDecimal(cell: RawCell | undefined): NumberParse {
  if (cell?.kind === 'unresolved') return { ok: false, code: 'FORMULA_WITHOUT_RESULT' };
  const source = numericSource(cell);
  if (source === null) return { ok: false, code: 'MISSING_VALUE' };
  const parts = splitPlainNumber(source);
  if (!parts) return { ok: false, code: 'INVALID_NUMBER' };

  const isZero = parts.integer === '0' && parts.fraction === '';
  if (parts.negative && !isZero) return { ok: false, code: 'NEGATIVE_NUMBER' };
  if (parts.integer.length > MAX_INTEGER_DIGITS) {
    return {
      ok: false,
      code: 'NUMBER_OUT_OF_RANGE',
      params: { maxIntegerDigits: MAX_INTEGER_DIGITS },
    };
  }
  if (parts.fraction.length > MAX_FRACTION_DIGITS) {
    return { ok: false, code: 'TOO_MANY_DECIMALS', params: { max: MAX_FRACTION_DIGITS } };
  }
  return { ok: true, value: parts.fraction ? `${parts.integer}.${parts.fraction}` : parts.integer };
}

/**
 * The sheet's own "amount" value, used only for the cross-check. May be negative and have any
 * number of decimals. A number cell is limited to 15 significant digits, which is all Excel
 * itself displays, so float noise such as 1234.9200000000001 is not reported as a mismatch.
 */
export function parseSheetAmount(cell: RawCell | undefined): string | null {
  if (cell?.kind === 'unresolved') return null;
  const source =
    cell?.kind === 'number'
      ? plainNumberString(Number(cell.value.toPrecision(15)))
      : numericSource(cell);
  if (source === null) return null;
  const parts = splitPlainNumber(source);
  if (!parts) return null;
  const isZero = parts.integer === '0' && parts.fraction === '';
  const body = parts.fraction ? `${parts.integer}.${parts.fraction}` : parts.integer;
  return parts.negative && !isZero ? `-${body}` : body;
}
