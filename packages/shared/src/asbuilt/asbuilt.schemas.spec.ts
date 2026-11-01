import { describe, expect, it } from 'vitest';
import {
  AsBuiltEditPayloadSchema,
  AsBuiltLabelSchema,
  AsBuiltLineStringSchema,
  RecordAsBuiltEditOpSchema,
  RejectAsBuiltEditRequestSchema,
} from './asbuilt.schemas.js';
import { SyncChangesResponseSchema, SyncPushRequestSchema } from '../execution/sync.schemas.js';

const FEATURE = '11111111-1111-4111-8111-111111111111';
const REVISION = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';
const DEVICE = '44444444-4444-4444-8444-444444444444';

const reshape = {
  kind: 'reshape',
  featureId: FEATURE,
  designRevisionId: REVISION,
  baseVersion: 0,
  note: null,
  gps: null,
  geometry: {
    type: 'LineString',
    coordinates: [
      [330000, 3340000],
      [330010, 3340005],
    ],
  },
} as const;

describe('As-Built edit contracts (ADR-030)', () => {
  it('accepts each of the five tools', () => {
    const point = { type: 'Point', coordinates: [330000.5, 3340000.25] };
    const payloads = [
      { ...reshape },
      { ...reshape, kind: 'move', geometry: point },
      { ...reshape, kind: 'add_route', baseVersion: undefined, label: 'C-12' },
      {
        kind: 'add_symbol',
        featureId: FEATURE,
        designRevisionId: REVISION,
        featureType: 'hhi',
        geometry: point,
        label: null,
        note: null,
        gps: null,
      },
      { ...reshape, kind: 'label', geometry: undefined, label: 'صندوق ١٢' },
    ];
    for (const payload of payloads) {
      expect(AsBuiltEditPayloadSchema.safeParse(payload).success).toBe(true);
    }
  });

  it('rejects a move with a line, a reshape with a point, and add_symbol of a route', () => {
    expect(AsBuiltEditPayloadSchema.safeParse({ ...reshape, kind: 'move' }).success).toBe(false);
    expect(
      AsBuiltEditPayloadSchema.safeParse({
        ...reshape,
        geometry: { type: 'Point', coordinates: [1, 2] },
      }).success,
    ).toBe(false);
    expect(
      AsBuiltEditPayloadSchema.safeParse({
        kind: 'add_symbol',
        featureId: FEATURE,
        designRevisionId: REVISION,
        featureType: 'route',
        geometry: { type: 'Point', coordinates: [1, 2] },
        label: null,
        note: null,
        gps: null,
      }).success,
    ).toBe(false);
  });

  it('rejects non-finite, huge and repeated coordinates and one-vertex routes', () => {
    const bad = [
      [
        [Number.NaN, 0],
        [1, 1],
      ],
      [
        [Number.POSITIVE_INFINITY, 0],
        [1, 1],
      ],
      [
        [1e9, 0],
        [1, 1],
      ],
      [
        [5, 5],
        [5, 5],
      ],
      [[5, 5]],
    ];
    for (const coordinates of bad) {
      expect(AsBuiltLineStringSchema.safeParse({ type: 'LineString', coordinates }).success).toBe(
        false,
      );
    }
  });

  it('labels: trimmed, ≤ 200, no control characters (DXF injection)', () => {
    expect(AsBuiltLabelSchema.parse('  B-07  ')).toBe('B-07');
    expect(AsBuiltLabelSchema.safeParse('').success).toBe(false);
    expect(AsBuiltLabelSchema.safeParse('x'.repeat(201)).success).toBe(false);
    expect(AsBuiltLabelSchema.safeParse('A\n0\nLINE').success).toBe(false);
    expect(AsBuiltLabelSchema.safeParse('A\r\nB').success).toBe(false);
    expect(AsBuiltLabelSchema.safeParse('A\u0000B').success).toBe(false);
    expect(AsBuiltLabelSchema.safeParse('A\u2028B').success).toBe(false);
    expect(AsBuiltLabelSchema.safeParse('مسار ٣ – C-12').success).toBe(true);
    // Security review L4: bidi overrides and isolates could show a code reversed.
    expect(AsBuiltLabelSchema.safeParse('C-12\u202E21').success).toBe(false);
    expect(AsBuiltLabelSchema.safeParse('C-12\u202A21').success).toBe(false);
    expect(AsBuiltLabelSchema.safeParse('C-12\u206621').success).toBe(false);
    expect(AsBuiltLabelSchema.safeParse('C-12\u206921').success).toBe(false);
  });

  it('travels in a push batch next to execution updates', () => {
    const op = {
      kind: 'asbuilt_edit.record',
      clientOpId: OP,
      capturedAt: '2026-11-01T10:00:00+02:00',
      payload: reshape,
    };
    expect(RecordAsBuiltEditOpSchema.safeParse(op).success).toBe(true);
    expect(SyncPushRequestSchema.safeParse({ deviceId: DEVICE, ops: [op] }).success).toBe(true);
  });

  it('keeps Phase 3 pull answers valid (asBuiltEdits defaults to [])', () => {
    const parsed = SyncChangesResponseSchema.parse({
      serverTime: '2026-11-01T10:00:00Z',
      cursor: '5',
      hasMore: false,
      updates: [],
    });
    expect(parsed.asBuiltEdits).toEqual([]);
  });

  it('a rejection needs a reason', () => {
    expect(RejectAsBuiltEditRequestSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(RejectAsBuiltEditRequestSchema.safeParse({ reason: 'المسار مش مطابق' }).success).toBe(
      true,
    );
  });
});
