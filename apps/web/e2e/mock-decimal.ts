/** Exact decimals for the mock API (BigInt on a common scale). Erasable TypeScript only. */

interface Dec {
  int: bigint;
  scale: number;
}

function parseDec(text: string): Dec {
  const [whole = '0', fraction = ''] = text.split('.');
  return { int: BigInt(whole + fraction), scale: fraction.length };
}

function formatDec(value: Dec): string {
  const negative = value.int < 0n;
  const digits = (negative ? -value.int : value.int).toString().padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = digits.slice(digits.length - value.scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function mulDec(a: string, b: string): string {
  const x = parseDec(a);
  const y = parseDec(b);
  return formatDec({ int: x.int * y.int, scale: x.scale + y.scale });
}

export function sumDec(values: string[]): string {
  const parsed = values.map(parseDec);
  const scale = parsed.reduce((max, v) => Math.max(max, v.scale), 0);
  const total = parsed.reduce((sum, v) => sum + v.int * 10n ** BigInt(scale - v.scale), 0n);
  return formatDec({ int: total, scale });
}
