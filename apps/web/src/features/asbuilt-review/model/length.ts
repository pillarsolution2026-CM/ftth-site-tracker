import type { Locale } from '@ftth/i18n';
import { compareDecimals, formatDecimal, subtractDecimals } from '@/shared/lib/decimal';

export interface LengthDifference {
  /** Exact decimal string `proposed − design` (BigInt on a common scale, never float). */
  value: string;
  direction: 'longer' | 'shorter' | 'same';
}

/** Null when either length is missing (a point, or an added route has no design). */
export function lengthDifference(
  design: string | null,
  proposed: string | null,
): LengthDifference | null {
  if (design === null || proposed === null) return null;
  const order = compareDecimals(proposed, design);
  return {
    value: subtractDecimals(proposed, design),
    direction: order > 0 ? 'longer' : order < 0 ? 'shorter' : 'same',
  };
}

/** "1,234.500 m" (metres to the millimetre, as the server stores them). */
export function formatLengthM(value: string, locale: Locale): string {
  return `${formatDecimal(value, locale, { minFractionDigits: 3 })} m`;
}

/** Signed difference: "+1.250 m", "−0.400 m" (a real minus sign) or "0.000 m". */
export function formatLengthDifference(difference: LengthDifference, locale: Locale): string {
  const magnitude = difference.value.startsWith('-') ? difference.value.slice(1) : difference.value;
  const text = formatLengthM(magnitude, locale);
  if (difference.direction === 'longer') return `+${text}`;
  return difference.direction === 'shorter' ? `−${text}` : text;
}
