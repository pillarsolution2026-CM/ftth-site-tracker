import type { ByteRange } from '../object-storage.port.js';

export type RangeRequest =
  /** No (usable) Range header: serve the whole object with 200. */
  | { kind: 'full' }
  | { kind: 'partial'; range: ByteRange }
  /** Syntactically valid but outside the object: 416. */
  | { kind: 'unsatisfiable' };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/i;

/**
 * Parses a `Range` header against an object of `size` bytes (RFC 9110 section 14). Only a single
 * `bytes` range is served; anything else (other units, several ranges, malformed) is ignored, which
 * the RFC allows, and the full object is returned.
 */
export function parseRangeHeader(header: string | undefined, size: number): RangeRequest {
  if (header === undefined) return { kind: 'full' };
  const match = SINGLE_RANGE.exec(header.trim());
  if (!match) return { kind: 'full' };
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return { kind: 'full' };

  if (first === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) {
      return { kind: 'unsatisfiable' };
    }
    return { kind: 'partial', range: { start: Math.max(0, size - suffix), end: size - 1 } };
  }

  const start = Number(first);
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' };
  if (last === '') return { kind: 'partial', range: { start, end: size - 1 } };
  const end = Number(last);
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'full' }; // invalid: ignored (RFC 9110)
  return { kind: 'partial', range: { start, end: Math.min(end, size - 1) } };
}
