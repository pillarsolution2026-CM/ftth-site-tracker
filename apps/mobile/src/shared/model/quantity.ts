/**
 * Exact quantity arithmetic on decimal strings with 4 fraction digits (the server's
 * numeric(18,4)). Values are scaled to integer ten-thousandths in a BigInt; no float ever.
 */
const SCALE = 4;
const PATTERN = /^(\d+)(?:\.(\d{1,4}))?$/;

export function toUnits(value: string): bigint {
  const match = PATTERN.exec(value.trim());
  if (!match) throw new RangeError(`Not a quantity: ${JSON.stringify(value)}`);
  const [, whole = '0', fraction = ''] = match;
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, '0'));
}

export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / 10n ** BigInt(SCALE);
  const fraction = (abs % 10n ** BigInt(SCALE)).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** a + b for non-negative quantities; also accepts server outputs like "12.5". */
export function addQuantities(...values: readonly string[]): string {
  return fromUnits(values.reduce((sum, value) => sum + toUnits(value), 0n));
}

/** Stepper: adds `delta` whole units, never below zero. */
export function stepQuantity(value: string, delta: number): string {
  const next = toUnits(value) + BigInt(delta) * 10n ** BigInt(SCALE);
  return fromUnits(next < 0n ? 0n : next);
}

export function compareQuantities(a: string, b: string): -1 | 0 | 1 {
  const diff = toUnits(a) - toUnits(b);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

export const isZeroQuantity = (value: string): boolean => toUnits(value) === 0n;
