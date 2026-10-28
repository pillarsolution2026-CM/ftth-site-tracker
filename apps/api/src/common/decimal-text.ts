const NUMERIC_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Shortest exact form of a PostgreSQL `numeric` text ("12.500" → "12.5", "1.000" → "1",
 * "-0.000" → "0"), the form `DecimalStringSchema` producers emit. Pure string work: no float.
 */
export function toDecimalText(numeric: string): string {
  const match = NUMERIC_TEXT.exec(numeric.trim());
  if (!match) throw new RangeError(`Not a decimal string: ${JSON.stringify(numeric)}`);
  const [, sign, integer = '0', fraction = ''] = match;
  const trimmed = fraction.replace(/0+$/, '');
  const whole = integer.replace(/^0+(?=\d)/, '');
  const isZero = /^0*$/.test(whole) && trimmed === '';
  return `${sign === '-' && !isZero ? '-' : ''}${whole}${trimmed ? `.${trimmed}` : ''}`;
}

export const toDecimalTextOrNull = (numeric: string | null): string | null =>
  numeric === null ? null : toDecimalText(numeric);
