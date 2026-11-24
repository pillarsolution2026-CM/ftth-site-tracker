import { describe, expect, it } from 'vitest';
import {
  OfflineBundleSchema,
  RecordUpdateOpSchema,
  SyncChangesQuerySchema,
  SyncPushRequestSchema,
} from '../index.js';

const SELF = { kind: 'self' } as const;
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

function op(overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    kind: 'execution_update.record',
    clientOpId: uuid(1),
    capturedAt: '2026-10-30T10:00:00+02:00',
    payload: {
      featureId: uuid(2),
      designRevisionId: uuid(3),
      workType: 'civil',
      lines: [
        { workOrderItemId: uuid(4), quantity: '12.5', role: 'work', performer: { kind: 'self' } },
      ],
      label: null,
      note: null,
      gps: { lon: 31.2, lat: 30.2, accuracyM: 4, at: '2026-10-30T08:00:00Z' },
      photos: [
        {
          photoId: uuid(5),
          requirementKey: 'general',
          sha256: 'a'.repeat(64),
          sizeBytes: 1000,
          contentType: 'image/jpeg',
          takenAt: '2026-10-30T08:00:00Z',
          gps: null,
        },
      ],
      acknowledgedWarnings: [],
      ...payload,
    },
    ...overrides,
  };
}

describe('RecordUpdateOpSchema', () => {
  it('accepts a complete update', () => {
    expect(RecordUpdateOpSchema.safeParse(op()).success).toBe(true);
  });

  it('rejects float quantities, zero quantities and numbers', () => {
    for (const quantity of ['0', '0.0000', '1.23456', '-1', 12]) {
      const parsed = RecordUpdateOpSchema.safeParse(
        op({}, { lines: [{ workOrderItemId: uuid(4), quantity, role: 'work', performer: SELF }] }),
      );
      expect(parsed.success, String(quantity)).toBe(false);
    }
  });

  it('requires at least one photo and one line', () => {
    expect(RecordUpdateOpSchema.safeParse(op({}, { photos: [] })).success).toBe(false);
    expect(RecordUpdateOpSchema.safeParse(op({}, { lines: [] })).success).toBe(false);
  });

  it('rejects duplicate photo ids and the same item twice in one step', () => {
    const photo = op().payload.photos[0];
    expect(RecordUpdateOpSchema.safeParse(op({}, { photos: [photo, photo] })).success).toBe(false);
    const line = { workOrderItemId: uuid(4), quantity: '1', role: 'work', performer: SELF };
    expect(RecordUpdateOpSchema.safeParse(op({}, { lines: [line, line] })).success).toBe(false);
    expect(
      RecordUpdateOpSchema.safeParse(
        op({}, { lines: [line, { ...line, role: 'material', performer: null }] }),
      ).success,
    ).toBe(true);
  });

  describe('performer of a line (ADR-052)', () => {
    const work = { workOrderItemId: uuid(4), quantity: '1', role: 'work' };
    const contractor = (n: number) => ({ kind: 'contractor', contractorLineId: uuid(n) });
    const parse = (lines: unknown[]) => RecordUpdateOpSchema.safeParse(op({}, { lines })).success;

    it('requires a performer on a work line', () => {
      expect(parse([work])).toBe(false);
      expect(parse([{ ...work, performer: null }])).toBe(false);
      expect(parse([{ ...work, performer: SELF }])).toBe(true);
      expect(parse([{ ...work, performer: contractor(9) }])).toBe(true);
    });

    it('refuses a performer on a material line, and defaults it to null', () => {
      const material = { ...work, role: 'material' };
      expect(parse([{ ...material, performer: SELF }])).toBe(false);
      expect(parse([{ ...material, performer: contractor(9) }])).toBe(false);
      const parsed = RecordUpdateOpSchema.parse(op({}, { lines: [material] }));
      expect(parsed.payload.lines[0]?.performer).toBeNull();
    });

    it('splits one line between contractors and «self», never the same performer twice', () => {
      expect(
        parse([
          { ...work, performer: contractor(9) },
          { ...work, performer: contractor(10) },
          { ...work, performer: SELF },
        ]),
      ).toBe(true);
      expect(
        parse([
          { ...work, performer: contractor(9) },
          { ...work, performer: contractor(9) },
        ]),
      ).toBe(false);
      expect(
        parse([
          { ...work, performer: SELF },
          { ...work, performer: SELF },
        ]),
      ).toBe(false);
    });

    it('refuses a malformed performer', () => {
      expect(parse([{ ...work, performer: { kind: 'contractor' } }])).toBe(false);
      expect(parse([{ ...work, performer: { kind: 'company' } }])).toBe(false);
    });
  });

  it('rejects upper-case or short digests and non-JPEG photos', () => {
    const photo = op().payload.photos[0];
    for (const bad of [
      { ...photo, sha256: 'A'.repeat(64) },
      { ...photo, sha256: 'a'.repeat(63) },
      { ...photo, contentType: 'image/png' },
      { ...photo, sizeBytes: 9 * 1024 * 1024 },
    ]) {
      expect(RecordUpdateOpSchema.safeParse(op({}, { photos: [bad] })).success).toBe(false);
    }
  });

  it('rejects impossible GPS coordinates', () => {
    const gps = { lon: 213, lat: 30, accuracyM: 1, at: '2026-10-30T08:00:00Z' };
    expect(RecordUpdateOpSchema.safeParse(op({}, { gps })).success).toBe(false);
  });
});

describe('SyncPushRequestSchema', () => {
  it('rejects the same clientOpId twice in one batch and empty or oversized batches', () => {
    const deviceId = uuid(9);
    expect(SyncPushRequestSchema.safeParse({ deviceId, ops: [op(), op()] }).success).toBe(false);
    expect(SyncPushRequestSchema.safeParse({ deviceId, ops: [] }).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => op({ clientOpId: uuid(100 + i) }));
    expect(SyncPushRequestSchema.safeParse({ deviceId, ops: many }).success).toBe(false);
    expect(SyncPushRequestSchema.safeParse({ deviceId, ops: many.slice(0, 50) }).success).toBe(
      true,
    );
  });
});

describe('SyncChangesQuerySchema', () => {
  it('defaults the cursor and rejects non-numeric cursors', () => {
    expect(SyncChangesQuerySchema.parse({})).toEqual({ cursor: '0', limit: 200 });
    expect(SyncChangesQuerySchema.safeParse({ cursor: '-1' }).success).toBe(false);
    expect(SyncChangesQuerySchema.safeParse({ cursor: '1; DROP' }).success).toBe(false);
  });
});

describe('OfflineBundleSchema', () => {
  it('keeps project-CRS coordinates and marks Phase 2 capabilities unavailable', () => {
    const bundle = OfflineBundleSchema.parse({
      serverTime: '2026-10-30T08:00:00Z',
      project: { id: uuid(1), name: 'Q', crsEpsg: 32636 },
      scope: { kind: 'sites', siteIds: [uuid(2)] },
      revision: null,
      features: [
        {
          id: uuid(3),
          type: 'route',
          code: null,
          layer: 'N_DUC_CBL',
          geometry: {
            type: 'LineString',
            coordinates: [
              [320000, 3340000],
              [320010, 3340000],
            ],
          },
          lengthM: '10',
        },
      ],
      catalog: [],
      settings: {
        gpsWarningDistanceM: 50,
        suggestedQuantity: 'unavailable',
        photoRequirements: {
          status: 'unavailable',
          byWorkType: {},
          fallback: [{ key: 'general', minCount: 1 }],
        },
      },
    });
    expect(bundle.features[0]?.geometry.type).toBe('LineString');
  });
});
