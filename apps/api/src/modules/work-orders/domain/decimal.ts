const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Exact decimal number: an integer count of 10^-scale units. No `number` goes in or comes out, so
 * money and quantities can never pick up float error (rule 6). Always kept in shortest form
 * (no trailing fraction zeros), so equal values have equal representations.
 */
export class Decimal {
  static readonly zero = new Decimal(0n, 0);

  private constructor(
    /** Value × 10^scale. */
    readonly units: bigint,
    readonly scale: number,
  ) {}

  /** Plain decimal text such as "12.5" or "-3"; exponents, signs other than "-", and separators are rejected. */
  static parse(text: string): Decimal {
    const match = DECIMAL_TEXT.exec(text);
    if (!match) throw new RangeError(`Not a decimal string: ${JSON.stringify(text)}`);
    const [, sign, integer = '0', fraction = ''] = match;
    const units = BigInt(`${integer}${fraction}`);
    return Decimal.of(sign === '-' ? -units : units, fraction.length);
  }

  private static of(units: bigint, scale: number): Decimal {
    let normalized = units;
    let normalizedScale = scale;
    while (normalizedScale > 0 && normalized % 10n === 0n) {
      normalized /= 10n;
      normalizedScale -= 1;
    }
    return new Decimal(normalized, normalizedScale);
  }

  add(other: Decimal): Decimal {
    const scale = Math.max(this.scale, other.scale);
    return Decimal.of(this.rescaled(scale) + other.rescaled(scale), scale);
  }

  mul(other: Decimal): Decimal {
    return Decimal.of(this.units * other.units, this.scale + other.scale);
  }

  /** Rounds half away from zero to `scale` fraction digits. */
  roundHalfUp(scale: number): Decimal {
    if (this.scale <= scale) return this;
    const divisor = 10n ** BigInt(this.scale - scale);
    const magnitude = this.units < 0n ? -this.units : this.units;
    const rounded = (magnitude + divisor / 2n) / divisor;
    return Decimal.of(this.units < 0n ? -rounded : rounded, scale);
  }

  compare(other: Decimal): -1 | 0 | 1 {
    const scale = Math.max(this.scale, other.scale);
    const difference = this.rescaled(scale) - other.rescaled(scale);
    return difference === 0n ? 0 : difference < 0n ? -1 : 1;
  }

  equals(other: Decimal): boolean {
    return this.compare(other) === 0;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  /** Shortest exact form: "12.5", "0", "-3.25". */
  toString(): string {
    const negative = this.units < 0n;
    const digits = (negative ? -this.units : this.units).toString().padStart(this.scale + 1, '0');
    const integer = digits.slice(0, digits.length - this.scale);
    const fraction = digits.slice(digits.length - this.scale);
    return `${negative ? '-' : ''}${integer}${this.scale > 0 ? `.${fraction}` : ''}`;
  }

  private rescaled(scale: number): bigint {
    return this.units * 10n ** BigInt(scale - this.scale);
  }
}

export function sumDecimals(values: Iterable<Decimal>): Decimal {
  let total = Decimal.zero;
  for (const value of values) total = total.add(value);
  return total;
}
