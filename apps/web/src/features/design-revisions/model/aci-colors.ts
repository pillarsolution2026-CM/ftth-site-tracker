import { ACI_COLORS } from './cad-commands';

/**
 * AutoCAD's Index Color palette (ACI 1-255) for the Select Color dialog and colour names (owner
 * 2026-11-26, item 34). 1-9 are the standard colours, 10-249 are 24 hues every 15° with five
 * shades each, full (even numbers) and mixed half with white (odd numbers), 250-255 are greys.
 */

const hex2 = (v: number) =>
  Math.round(Math.min(255, Math.max(0, v)))
    .toString(16)
    .padStart(2, '0');
export const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** Full-saturation colour of a hue (degrees). */
function hue(deg: number): [number, number, number] {
  const h = (((deg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const table: [number, number, number][] = [
    [1, x, 0],
    [x, 1, 0],
    [0, 1, x],
    [0, x, 1],
    [x, 0, 1],
    [1, 0, x],
  ];
  return table[Math.floor(h) % 6] as [number, number, number];
}

const SHADES = [1, 0.8, 0.6, 0.5, 0.3];
const GREYS = ['#333333', '#505050', '#696969', '#828282', '#bebebe', '#ffffff'];

/** `#rrggbb` of an ACI number (1-255); null outside. */
export function aciHex(aci: number): string | null {
  if (!Number.isInteger(aci) || aci < 1 || aci > 255) return null;
  if (aci <= 9) return (ACI_COLORS.find((c) => c.aci === aci) as { hex: string }).hex;
  if (aci >= 250) return GREYS[aci - 250] as string;
  const [r, g, b] = hue((Math.floor(aci / 10) - 1) * 15);
  const shade = SHADES[Math.floor((aci % 10) / 2)] as number;
  const pale = aci % 2 === 1;
  const c = (v: number) => (pale ? (v + 1) / 2 : v) * 255 * shade;
  return rgbHex(c(r), c(g), c(b));
}

/** Every ACI colour, 1-255. */
export const ACI_PALETTE: readonly { aci: number; hex: string }[] = Array.from(
  { length: 255 },
  (_, i) => ({ aci: i + 1, hex: aciHex(i + 1) as string }),
);

/** The ACI number of a colour, when it is one. */
export const aciOf = (hex: string): number | null =>
  ACI_PALETTE.find((c) => c.hex === hex.toLowerCase())?.aci ?? null;

/** `r,g,b` as AutoCAD writes a True Color. */
export function rgbText(hex: string): string {
  const v = Number.parseInt(hex.slice(1), 16);
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}

/** A True Color typed as `r,g,b` (0-255 each) or `#rrggbb`; null when it is not one. */
export function parseColor(text: string): string | null {
  const value = text.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const parts = value.split(',').map((s) => s.trim());
  if (parts.length !== 3 || parts.some((s) => !/^\d{1,3}$/.test(s))) return null;
  const [r, g, b] = parts.map(Number) as [number, number, number];
  if ([r, g, b].some((v) => v > 255)) return null;
  return rgbHex(r, g, b);
}

/**
 * How AutoCAD names a colour in its drop-downs: ByLayer, the name of 1-7 (Red…White), «Color n»
 * for another index colour, else the True Color `r,g,b`.
 */
export function colorLabel(hex: string | null): string {
  if (hex === null) return 'ByLayer';
  const aci = aciOf(hex);
  if (aci !== null && aci <= 7) return (ACI_COLORS[aci - 1] as { name: string }).name;
  if (aci !== null) return `Color ${aci}`;
  return rgbText(hex);
}
