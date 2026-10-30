import { describe, expect, it } from 'vitest';
import { canonicalJson, operationHash } from './op-hash.js';
import { decideChunk, looksLikeJpeg } from './photo-upload.js';
import { computeUpdateFlags, type FlagFacts } from './update-flags.js';

describe('canonicalJson / operationHash', () => {
  it('ignores key order and undefined fields', () => {
    expect(canonicalJson({ b: 1, a: [{ e: null, c: undefined, d: 2 }] })).toBe(
      '{"a":[{"d":2,"e":null}],"b":1}',
    );
    const a = operationHash({ kind: 'k', capturedAt: 't', payload: { x: 1, y: 2 } });
    const b = operationHash({ payload: { y: 2, x: 1 }, capturedAt: 't', kind: 'k' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any value changes', () => {
    const a = operationHash({ kind: 'k', capturedAt: 't', payload: { q: '1' } });
    expect(operationHash({ kind: 'k', capturedAt: 't', payload: { q: '1.0' } })).not.toBe(a);
    expect(operationHash({ kind: 'k', capturedAt: 'u', payload: { q: '1' } })).not.toBe(a);
  });
});

describe('computeUpdateFlags', () => {
  const base: FlagFacts = {
    capturedAt: new Date('2026-10-30T10:00:00Z'),
    receivedAt: new Date('2026-10-30T12:00:00Z'),
    revisionPublishedAt: new Date('2026-10-29T10:00:00Z'),
    gpsDistanceM: 10,
    gpsWarningDistanceM: 50,
    itemOverrun: false,
    revisionIsLatest: true,
    featureInLatestRevision: true,
  };

  it('has no flags for a normal update', () => {
    expect(computeUpdateFlags(base)).toEqual([]);
  });

  it('flags a device clock ahead of the server beyond the tolerance only', () => {
    const at = (iso: string) => computeUpdateFlags({ ...base, capturedAt: new Date(iso) });
    expect(at('2026-10-30T12:04:59Z')).toEqual([]);
    expect(at('2026-10-30T12:05:01Z')).toEqual(['CLOCK_AHEAD']);
  });

  it('flags a device clock behind the revision publication (e.g. reset to 1970)', () => {
    expect(computeUpdateFlags({ ...base, capturedAt: new Date(0) })).toEqual(['CLOCK_BEHIND']);
  });

  it('flags GPS far and missing', () => {
    expect(computeUpdateFlags({ ...base, gpsDistanceM: 50 })).toEqual([]);
    expect(computeUpdateFlags({ ...base, gpsDistanceM: 50.001 })).toEqual(['GPS_FAR']);
    expect(computeUpdateFlags({ ...base, gpsDistanceM: null })).toEqual(['GPS_MISSING']);
  });

  it('flags overrun, outdated revision and removed feature', () => {
    expect(
      computeUpdateFlags({
        ...base,
        itemOverrun: true,
        revisionIsLatest: false,
        featureInLatestRevision: false,
      }),
    ).toEqual(['ITEM_OVERRUN', 'REVISION_OUTDATED', 'FEATURE_REMOVED']);
  });
});

describe('looksLikeJpeg', () => {
  it('accepts SOI…EOI and rejects anything else', () => {
    expect(looksLikeJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]))).toBe(true);
    expect(looksLikeJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd9]))).toBe(false);
    expect(looksLikeJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toBe(false);
    expect(looksLikeJpeg(Uint8Array.from([0xff, 0xd8]))).toBe(false);
  });
});

describe('decideChunk', () => {
  it('appends at the right offset and detects completion', () => {
    expect(decideChunk({ sizeBytes: 10, receivedBytes: 0, offset: 0, length: 4 })).toEqual({
      kind: 'append',
      receivedAfter: 4,
      complete: false,
    });
    expect(decideChunk({ sizeBytes: 10, receivedBytes: 4, offset: 4, length: 6 })).toEqual({
      kind: 'append',
      receivedAfter: 10,
      complete: true,
    });
  });

  it('refuses wrong offsets, empty chunks and bytes beyond the declared size', () => {
    expect(decideChunk({ sizeBytes: 10, receivedBytes: 4, offset: 0, length: 4 }).kind).toBe(
      'offset_mismatch',
    );
    expect(decideChunk({ sizeBytes: 10, receivedBytes: 4, offset: 4, length: 0 }).kind).toBe(
      'empty',
    );
    expect(decideChunk({ sizeBytes: 10, receivedBytes: 4, offset: 4, length: 7 }).kind).toBe(
      'too_large',
    );
  });
});
