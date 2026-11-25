import { describe, expect, it } from 'vitest';
import { canonicalJson, operationHash } from './op-hash.js';
import { decideChunk, looksLikeJpeg } from './photo-upload.js';
import { computeUpdateFlags, type FlagFacts } from './update-flags.js';

describe('canonicalJson / operationHash', () => {
  it('hashes a line without a performer as before ADR-052, so an old resend stays a duplicate', () => {
    const line = { workOrderItemId: 'i', quantity: '1', role: 'material' };
    const before = operationHash({ kind: 'k', capturedAt: 't', payload: { lines: [line] } });
    const now = operationHash({
      kind: 'k',
      capturedAt: 't',
      payload: { lines: [{ ...line, performer: null }] },
    });
    expect(now).toBe(before);
    const self = operationHash({
      kind: 'k',
      capturedAt: 't',
      payload: { lines: [{ ...line, role: 'work', performer: { kind: 'self' } }] },
    });
    expect(self).not.toBe(
      operationHash({
        kind: 'k',
        capturedAt: 't',
        payload: { lines: [{ ...line, role: 'work' }] },
      }),
    );
  });

  it('hashes a payload without dimensions and drawing as before ADR-056 (old resend stays a duplicate)', () => {
    const line = { workOrderItemId: 'i', quantity: '1', role: 'work', performer: { kind: 'self' } };
    const before = operationHash({
      kind: 'k',
      capturedAt: 't',
      payload: { featureId: 'f', lines: [line] },
    });
    const now = operationHash({
      kind: 'k',
      capturedAt: 't',
      payload: { featureId: 'f', drawingId: null, lines: [{ ...line, dimensions: null }] },
    });
    expect(now).toBe(before);
  });

  it('hashes different dimensions or a different drawing differently (OP_ID_REUSED on resend)', () => {
    const dims = { lengthM: '10', widthM: '0.35', depthM: '0.9' };
    const line = { workOrderItemId: 'i', quantity: '3.15', role: 'work', performer: null };
    const hash = (lineDims: unknown, drawingId: unknown) =>
      operationHash({
        kind: 'k',
        capturedAt: 't',
        payload: { featureId: null, drawingId, lines: [{ ...line, dimensions: lineDims }] },
      });
    const base = hash(dims, 'd1');
    expect(hash({ ...dims, depthM: '0.91' }, 'd1')).not.toBe(base);
    expect(hash(null, 'd1')).not.toBe(base);
    expect(hash(dims, 'd2')).not.toBe(base);
    expect(hash(dims, 'd1')).toBe(base);
  });

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

  it('a planning update on a drawing has no GPS flags and no removed feature (ADR-056)', () => {
    const planning = { ...base, onDrawing: true, featureInLatestRevision: false };
    expect(computeUpdateFlags({ ...planning, gpsDistanceM: null })).toEqual([]);
    expect(computeUpdateFlags({ ...planning, gpsDistanceM: 500 })).toEqual([]);
    expect(computeUpdateFlags({ ...planning, itemOverrun: true, revisionIsLatest: false })).toEqual(
      ['ITEM_OVERRUN', 'REVISION_OUTDATED'],
    );
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
