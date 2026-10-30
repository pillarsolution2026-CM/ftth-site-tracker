import { PHOTO_JPEG_QUALITY, PHOTO_MAX_DIMENSION_PX, type GpsFix } from '@ftth/shared';

/** Target size keeping the aspect ratio, long side ≤ 1600 px (plan); never upscales. */
export function targetSize(
  width: number,
  height: number,
  maxDimension = PHOTO_MAX_DIMENSION_PX,
): { width: number; height: number } {
  const longSide = Math.max(width, height);
  if (longSide <= maxDimension) return { width, height };
  const scale = maxDimension / longSide;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export const JPEG_QUALITY = PHOTO_JPEG_QUALITY;

export interface WatermarkInput {
  featureCode: string | null;
  featureType: string;
  takenAt: Date;
  gps: GpsFix | null;
  /** Supervisor's display name. */
  author: string;
}

/**
 * The text burnt into every photo (plan: GPS, time, watermark). Latin digits and ISO-like time so
 * it reads the same in every language and cannot be mistaken (codes and numbers stay LTR).
 */
export function watermarkLines(input: WatermarkInput): string[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const t = input.takenAt;
  const time = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(
    t.getHours(),
  )}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
  const gps = input.gps
    ? `${input.gps.lat.toFixed(6)}, ${input.gps.lon.toFixed(6)}${
        input.gps.accuracyM === null ? '' : ` ±${Math.round(input.gps.accuracyM)} m`
      }`
    : 'GPS —';
  return [
    `${input.featureType.toUpperCase()} ${input.featureCode ?? ''}`.trim(),
    time,
    gps,
    input.author,
  ];
}

/** Lower-case hex of a digest (expo-crypto returns an ArrayBuffer). */
export function toHex(digest: ArrayBuffer | Uint8Array): string {
  const bytes = digest instanceof Uint8Array ? digest : new Uint8Array(digest);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decodes standard base64 (expo-file-system reads binary files as base64). */
export function base64ToBytes(base64: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}
