/** AutoCAD Color Index → CSS colour (the standard 256-colour palette; data, not a design token). */

const BASIC: Record<number, string> = {
  1: '#FF0000',
  2: '#FFFF00',
  3: '#00FF00',
  4: '#00FFFF',
  5: '#0000FF',
  6: '#FF00FF',
  7: '#FFFFFF',
  8: '#414141',
  9: '#808080',
};
const GREYS = ['#333333', '#505050', '#696969', '#828282', '#BEBEBE', '#FFFFFF'];
const VALUE = [255, 255, 165, 165, 127, 127, 76, 76, 38, 38];
const SATURATION = [1, 0.5, 1, 0.5, 1, 0.5, 1, 0.5, 1, 0.5];

function hsvToHex(hue: number, saturation: number, value: number): string {
  const channel = (n: number) => {
    const k = (n + hue / 60) % 6;
    const v = value - value * saturation * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.floor(v + 1e-9)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`.toUpperCase();
}

export function aciToCss(aci: number): string {
  const basic = BASIC[aci];
  if (basic) return basic;
  if (aci >= 250 && aci <= 255) return GREYS[aci - 250] ?? '#FFFFFF';
  if (aci >= 10 && aci <= 249) {
    const offset = aci - 10;
    const hue = Math.floor(offset / 10) * 15;
    const k = offset % 10;
    return hsvToHex(hue, SATURATION[k] ?? 1, VALUE[k] ?? 255);
  }
  return '#808080';
}

/** 0xRRGGBB → "#RRGGBB". */
export function trueColorToCss(value: number): string {
  return `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
}
