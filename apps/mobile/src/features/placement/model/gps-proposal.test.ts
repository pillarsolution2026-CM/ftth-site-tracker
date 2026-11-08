import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import { translate } from '@ftth/i18n';
import {
  GPS_PROPOSAL_FEATURE_TYPES,
  FEATURE_TYPES,
  OP_REJECTION_CODES,
  ProposePlacementPointOpSchema,
  SyncOpSchema,
  type GpsFix,
} from '@ftth/shared';
import type { OutboxEntry } from '@ftth/sync';
import { testRandom } from '../../../shared/crypto/test-random';
import { createVault } from '../../../shared/crypto/vault';
import { rejectionKey } from '../../asbuilt/model/own-edits';
import { createLocalDatabase } from '../../sync/db/database';
import { localSchema, localMigrations } from '../../sync/db/schema';
import { WatermelonSyncStore } from '../../sync/db/watermelon-sync-store';
import { pendingRows } from '../../sync/model/pending-rows';
import type { CapturedPhoto } from '../../update/model/update-wizard';
import {
  accuracyGate,
  buildProposeOp,
  canProposePoint,
  canSendProposal,
  formatAccuracy,
} from './gps-proposal';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000e1';
const REVISION = '00000000-0000-4000-8000-0000000000a2';
const FEATURE = '00000000-0000-4000-8000-0000000000a3';
const OP = '00000000-0000-4000-8000-0000000000c1';
const PHOTO_ID = '00000000-0000-4000-8000-0000000000d1';

const fix = (accuracyM: number | null): GpsFix => ({
  lat: 30.1,
  lon: 31.3,
  accuracyM,
  at: '2026-11-08T08:00:00.000Z',
});

const photo: CapturedPhoto = {
  photoId: PHOTO_ID,
  requirementKey: 'whatever',
  fileUri: 'file:///p.jpg',
  sha256: 'a'.repeat(64),
  sizeBytes: 1234,
  takenAt: '2026-11-08T08:00:01.000Z',
  gps: fix(3),
};

function input(overrides: Partial<Parameters<typeof buildProposeOp>[0]> = {}) {
  return {
    clientOpId: OP,
    capturedAt: '2026-11-08T08:00:05.000Z',
    designRevisionId: REVISION,
    featureId: FEATURE,
    fix: { ...fix(4.2), accuracyM: 4.2 },
    photo: null,
    note: '',
    ...overrides,
  };
}

describe('accuracy gate (owner 2026-11-08: refuse worse than ±5 m)', () => {
  it('refuses a missing accuracy', () => {
    expect(accuracyGate(null)).toBe('no_fix');
    expect(accuracyGate(undefined)).toBe('no_fix');
    expect(canSendProposal(null)).toBe(false);
    expect(canSendProposal(fix(null))).toBe(false);
  });

  it('allows exactly 5.0 and refuses 5.1', () => {
    expect(accuracyGate(5)).toBe('ok');
    expect(accuracyGate(5.0)).toBe('ok');
    expect(accuracyGate(0)).toBe('ok');
    expect(accuracyGate(5.1)).toBe('too_low');
    expect(canSendProposal(fix(5))).toBe(true);
    expect(canSendProposal(fix(5.1))).toBe(false);
  });

  it('shows one decimal', () => {
    expect(formatAccuracy(3.456)).toBe('3.5');
    expect(formatAccuracy(5)).toBe('5.0');
  });
});

describe('feature type filter', () => {
  it('offers the button for the five point types only', () => {
    for (const type of GPS_PROPOSAL_FEATURE_TYPES) expect(canProposePoint(type)).toBe(true);
    expect([...GPS_PROPOSAL_FEATURE_TYPES].sort()).toEqual([
      'box',
      'cabinet',
      'hhi',
      'joint',
      'mh',
    ]);
    for (const type of FEATURE_TYPES.filter((t) => !canProposePoint(t))) {
      expect(['cabinet', 'hhi', 'mh', 'joint', 'box']).not.toContain(type);
    }
    expect(canProposePoint('route')).toBe(false);
    expect(canProposePoint('unknown')).toBe(false);
  });
});

describe('proposal op builder', () => {
  it('builds a schema-valid op without a photo', () => {
    const op = buildProposeOp(input());
    expect(ProposePlacementPointOpSchema.safeParse(op).success).toBe(true);
    expect(SyncOpSchema.safeParse(op).success).toBe(true);
    expect(op.kind).toBe('placement_point.propose');
    expect(op.clientOpId).toBe(OP);
    expect(op.payload.photo).toBeNull();
    expect(op.payload.note).toBeNull();
    expect(op.payload.fix).toEqual({
      lat: 30.1,
      lon: 31.3,
      accuracyM: 4.2,
      at: '2026-11-08T08:00:00.000Z',
    });
  });

  it('carries the photo with the general requirement key, and a trimmed note', () => {
    const op = buildProposeOp(input({ photo, note: '  عند الكابينة  ' }));
    expect(op.payload.photo).toEqual({
      photoId: PHOTO_ID,
      requirementKey: 'general',
      sha256: 'a'.repeat(64),
      sizeBytes: 1234,
      contentType: 'image/jpeg',
      takenAt: '2026-11-08T08:00:01.000Z',
      gps: fix(3),
    });
    expect(op.payload.note).toBe('عند الكابينة');
  });

  it('refuses a fix worse than 5 m (the contract is the last gate)', () => {
    expect(() => buildProposeOp(input({ fix: { ...fix(5.1), accuracyM: 5.1 } }))).toThrow();
  });
});

describe('pending list and rejections', () => {
  const entry = (op: OutboxEntry['op']): OutboxEntry => ({
    clientOpId: op.clientOpId,
    op,
    state: 'pending',
    attempts: 0,
    updateId: null,
    rejection: null,
  });

  it('lists GPS proposals and keeps As-Built edits out', () => {
    const proposal = buildProposeOp(input());
    const asBuilt: OutboxEntry['op'] = {
      kind: 'asbuilt_edit.record',
      clientOpId: '00000000-0000-4000-8000-0000000000c2',
      capturedAt: '2026-11-08T08:00:00.000Z',
      payload: {
        kind: 'label',
        featureId: FEATURE,
        designRevisionId: REVISION,
        baseVersion: 0,
        label: 'x',
        note: null,
        gps: null,
      },
    };
    const rows = pendingRows([entry(proposal), entry(asBuilt)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('gps_point');
  });

  it.each(['ar', 'en', 'fr'] as const)('has messages for the new rejection codes (%s)', (lang) => {
    for (const code of ['FEATURE_TYPE_NOT_ALLOWED', 'GPS_ACCURACY_TOO_LOW'] as const) {
      expect(OP_REJECTION_CODES).toContain(code);
      const key = rejectionKey(code);
      expect(key).toBe(`field.pending.rejections.${code}`);
      expect(translate(lang, key)).not.toBe(key);
    }
    expect(translate(lang, 'field.pending.kinds.placementPoint')).not.toContain('field.');
  });
});

describe('outbox handling of the new kind', () => {
  const vault = createVault(async () => new Uint8Array(32).fill(9), testRandom);
  const makeStore = () => {
    const db = createLocalDatabase(
      new LokiJSAdapter({
        schema: localSchema,
        migrations: localMigrations,
        useWebWorker: false,
        useIncrementalIndexedDB: false,
        dbName: `placement-${Math.random()}`,
      }),
    );
    return new WatermelonSyncStore(db, PROJECT, USER, async () => new Uint8Array(), vault);
  };

  it('queues a proposal without a photo', async () => {
    const store = makeStore();
    await store.enqueue(buildProposeOp(input()), []);
    const entries = await store.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.op.kind).toBe('placement_point.propose');
    expect(entries[0]?.state).toBe('pending');
  });

  it('queues the photo of a proposal and rejects mismatched files', async () => {
    const store = makeStore();
    const op = buildProposeOp(input({ photo }));
    await expect(store.enqueue(op, [])).rejects.toThrow('Photo files do not match');
    await store.enqueue(op, [{ photoId: PHOTO_ID, fileUri: photo.fileUri, sizeBytes: 1234 }]);
    expect((await store.entries())[0]?.clientOpId).toBe(OP);
    expect((await store.summary()).photosWaiting).toBe(1);
  });
});
