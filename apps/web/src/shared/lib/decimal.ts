import type { Locale } from '@ftth/i18n';

/**
 * Exact decimal helpers on strings. Money and quantities never pass through `number`
 * (ADR-011); these helpers only reformat or add digits.
 */

const DECIMAL = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;

interface Separators {
  group: string;
  decimal: string;
}

const separatorCache = new Map<Locale, Separators>();

/** Latin digits in every locale (numbers stay LTR and unambiguous); separators follow the locale. */
function separatorsFor(locale: Locale): Separators {
  const cached = separatorCache.get(locale);
  if (cached) return cached;
  const tag = locale === 'fr' ? 'fr-FR' : 'en-US';
  const parts = new Intl.NumberFormat(tag, { numberingSystem: 'latn' }).formatToParts(1234567.5);
  const result: Separators = {
    group: parts.find((part) => part.type === 'group')?.value ?? ',',
    decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
  };
  separatorCache.set(locale, result);
  return result;
}

export interface FormatDecimalOptions {
  /** Pad the fraction with zeros up to this many digits (e.g. 2 for money). Never truncates. */
  minFractionDigits?: number;
}

/**
 * Formats a decimal string for display with thousands separators. Keeps every digit
 * (14+ integer digits, 8 fraction digits) because it only regroups the string.
 * Returns the input unchanged when it is not a plain decimal.
 */
export function formatDecimal(
  value: string,
  locale: Locale,
  options: FormatDecimalOptions = {},
): string {
  const match = DECIMAL.exec(value);
  if (!match) return value;
  const [, sign = '', integer = '0', fraction = ''] = match;
  const { group, decimal } = separatorsFor(locale);
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const padded = fraction.padEnd(options.minFractionDigits ?? 0, '0');
  return `${sign}${grouped}${padded ? `${decimal}${padded}` : ''}`;
}

/** "1,234.50 EGP": the ISO code is shown instead of a symbol so it is unambiguous. */
export function formatMoney(value: string, currency: string, locale: Locale): string {
  return `${formatDecimal(value, locale, { minFractionDigits: 2 })} ${currency}`;
}

/** Exact sum of decimal strings (BigInt on a common scale). Invalid entries are ignored. */
export function sumDecimals(values: readonly string[]): string {
  const parsed = values.flatMap((value) => {
    const match = DECIMAL.exec(value);
    return match
      ? [{ negative: match[1] === '-', integer: match[2] ?? '0', fraction: match[3] ?? '' }]
      : [];
  });
  const scale = parsed.reduce((max, entry) => Math.max(max, entry.fraction.length), 0);
  let total = 0n;
  for (const entry of parsed) {
    const scaled = BigInt(entry.integer + entry.fraction.padEnd(scale, '0'));
    total += entry.negative ? -scaled : scaled;
  }
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const integer = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

/** Exact `a − b` on decimal strings. */
export function subtractDecimals(a: string, b: string): string {
  return sumDecimals([a, b.startsWith('-') ? b.slice(1) : `-${b}`]);
}

/** Exact comparison of two decimal strings: -1, 0 or 1. Invalid input counts as 0. */
export function compareDecimals(a: string, b: string): -1 | 0 | 1 {
  const difference = subtractDecimals(a, b);
  if (difference === '0') return 0;
  return difference.startsWith('-') ? -1 : 1;
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Typed input → plain decimal string: Arabic digits and separators converted, spaces dropped. */
export function normalizeDecimalInput(raw: string): string {
  return raw
    .trim()
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(EXTENDED_ARABIC_INDIC.indexOf(digit)))
    .replace(/[٫,]/g, '.')
    .replace(/[٬\s]/g, '');
}
