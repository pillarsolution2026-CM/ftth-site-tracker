import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import {
  type AsBuiltEdit,
  type OpResult,
  type RecordAsBuiltEditOp,
  type SyncPushRequest,
} from '@ftth/shared';
import { SyncEngine, TransportError, type SyncTransport } from '@ftth/sync';
import { testRandom } from '../../../shared/crypto/test-random';
import { createVault } from '../../../shared/crypto/vault';
import {
  BOX,
  E,
  N,
  PROJECT,
  REVISION,
  remoteEdit,
  ROUTE,
  USER,
  uuid,
} from '../../asbuilt/model/test-fixtures';
import { createLocalDatabase } from './database';
import { localMigrations, localSchema, LOCAL_SCHEMA_VERSION, TABLES } from './schema';
import { WatermelonSyncStore } from './watermelon-sync-store';

const OTHER = '00000000-0000-4000-8000-0000000000bb';
const vault = createVault(async () => new Uint8Array(32).fill(9), testRandom);

function makeDb() {
  return createLocalDatabase(
    new LokiJSAdapter({
      schema: localSchema,
      migrations: localMigrations,
      useWebWorker: false,
      useIncrementalIndexedDB: false,
      dbName: `asbuilt-${uuid()}`,
    }),
  );
}

function makeStore(userId = USER, db = makeDb()) {
  const store = new WatermelonSyncStore(db, PROJECT, userId, async () => new Uint8Array(), vault);
  return { db, store };
}

function moveOp(x = E + 1): RecordAsBuiltEditOp {
  return {
    kind: 'asbuilt_edit.record',
    clientOpId: uuid(),
    capturedAt: '2026-10-31T09:00:00.000Z',
    payload: {
      kind: 'move',
      featureId: BOX,
      designRevisionId: REVISION,
      baseVersion: 0,
      geometry: { type: 'Point', coordinates: [x, N] },
      note: 'ملاحظة سرية',
      gps: null,
    },
  };
}

describe('local schema migration', () => {
  it('bumps the version and the migration creates exactly the table of the new schema', () => {
    expect(LOCAL_SCHEMA_VERSION).toBe(2);
    expect(localSchema.version).toBe(2);
    expect(localMigrations.minVersion).toBe(1);
    expect(localMigrations.maxVersion).toBe(2);
    const step = localMigrations.sortedMigrations[0]?.steps[0];
    expect(step).toMatchObject({ type: 'create_table' });
    const created = (step as unknown as { schema: { name: string; columns: unknown } }).schema;
    expect(created.name).toBe(TABLES.remoteAsBuilt);
    expect(created.columns).toEqual(localSchema.tables[TABLES.remoteAsBuilt]?.columns);
  });
});

describe('remote As-Built edits in WatermelonDB', () => {
  const approved = (partial: Partial<AsBuiltEdit> = {}): AsBuiltEdit =>
    remoteEdit({
      featureId: BOX,
      kind: 'move',
      geometry: { type: 'Point', coordinates: [E + 4, N] },
      userId: USER,
      status: 'pending',
      ...partial,
    });

  it('stores server copies sealed, updates them in place, and reads them back validated', async () => {
    const { db, store } = makeStore();
    const edit = approved();
    await store.applyRemoteAsBuiltEdits([]);
    await store.applyRemoteAsBuiltEdits([edit]);
    const [raw] = await db.get(TABLES.remoteAsBuilt).query().fetch();
    const sealed = String(raw?._getRaw('json'));
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain(BOX);
    expect(raw?._getRaw('status')).toBe('pending');

    await store.applyRemoteAsBuiltEdits([
      { ...edit, status: 'approved', approvedVersion: 1 },
      approved({ featureId: ROUTE, kind: 'label', geometry: null, label: 'R' }),
    ]);
    expect(await db.get(TABLES.remoteAsBuilt).query().fetchCount()).toBe(2);
    const edits = await store.remoteAsBuiltEdits();
    expect(edits.find((e) => e.id === edit.id)).toMatchObject({
      status: 'approved',
      approvedVersion: 1,
    });
  });

  it('keeps users and projects apart on a shared phone', async () => {
    const { db, store } = makeStore();
    await store.applyRemoteAsBuiltEdits([approved()]);
    const other = makeStore(OTHER, db).store;
    expect(await other.remoteAsBuiltEdits()).toEqual([]);
    await other.applyRemoteAsBuiltEdits([approved()]);
    expect(await store.remoteAsBuiltEdits()).toHaveLength(1);
    const otherProject = new WatermelonSyncStore(
      db,
      '00000000-0000-4000-8000-0000000000cc',
      USER,
      async () => new Uint8Array(),
      vault,
    );
    expect(await otherProject.remoteAsBuiltEdits()).toEqual([]);
  });
});

describe('enqueueAsBuiltEdits', () => {
  it('writes every op of a session in one local transaction, sealed, in order', async () => {
    const { db, store } = makeStore();
    const ops = [moveOp(E + 1), moveOp(E + 2), moveOp(E + 3)];
    await store.enqueueAsBuiltEdits(ops);
    const rows = await db.get(TABLES.outbox).query().fetch();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const sealed = String(row._getRaw('op_json'));
      expect(sealed.startsWith('v1:')).toBe(true);
      expect(sealed).not.toContain('ملاحظة');
      expect(sealed).not.toContain('asbuilt_edit');
    }
    expect((await store.pendingOps(10)).map((e) => e.clientOpId)).toEqual(
      ops.map((o) => o.clientOpId),
    );
    expect((await store.pendingOps(10))[0]?.op).toEqual(ops[0]);
    expect(await store.summary()).toMatchObject({ pending: 3, photosWaiting: 0 });
  });

  it('writes nothing when one op is invalid, and nothing for an empty session', async () => {
    const { store } = makeStore();
    const broken = {
      ...moveOp(),
      payload: { ...moveOp().payload, geometry: { type: 'Point', coordinates: [NaN, 0] } },
    } as unknown as RecordAsBuiltEditOp;
    await expect(store.enqueueAsBuiltEdits([moveOp(), broken])).rejects.toThrow();
    await store.enqueueAsBuiltEdits([]);
    expect(await store.pendingOps(10)).toEqual([]);
  });

  it('keeps ids of two sessions strictly increasing', async () => {
    const { store } = makeStore();
    await store.enqueueAsBuiltEdits([moveOp(), moveOp()]);
    await store.enqueueAsBuiltEdits([moveOp()]);
    expect((await store.entries()).length).toBe(3);
  });
});

describe('an edit saved offline through the real SyncEngine', () => {
  function transport(sink: SyncPushRequest[], mode: { online: boolean; lostResponse: boolean }) {
    const known = new Map<string, string>();
    const approvedEdit = remoteEdit({
      featureId: BOX,
      kind: 'move',
      geometry: { type: 'Point', coordinates: [E + 1, N] },
      userId: USER,
      status: 'approved',
      approvedVersion: 1,
    });
    const t: SyncTransport = {
      push: async (request) => {
        sink.push(request);
        if (!mode.online) throw new TransportError('network');
        const results: OpResult[] = request.ops.map((op) => {
          const seen = known.get(op.clientOpId);
          if (seen) return { clientOpId: op.clientOpId, outcome: 'duplicate', updateId: seen };
          const id = uuid();
          known.set(op.clientOpId, id);
          return { clientOpId: op.clientOpId, outcome: 'applied', updateId: id };
        });
        if (mode.lostResponse) {
          mode.lostResponse = false;
          throw new TransportError('network');
        }
        return { serverTime: '2026-10-31T09:00:00Z', results };
      },
      changes: async () => ({
        serverTime: '2026-10-31T09:00:00Z',
        cursor: '5',
        hasMore: false,
        updates: [],
        asBuiltEdits: [approvedEdit],
      }),
      photoStatus: async () => {
        throw new Error('As-Built edits have no photos');
      },
      putPhotoChunk: async () => {
        throw new Error('As-Built edits have no photos');
      },
    };
    return t;
  }

  it('is sent once; a resend after a lost response is a duplicate, not a second record', async () => {
    const { store } = makeStore();
    const op = moveOp();
    await store.enqueueAsBuiltEdits([op]);
    const sink: SyncPushRequest[] = [];
    const mode = { online: false, lostResponse: false };
    const engine = new SyncEngine({
      store,
      photos: store,
      transport: transport(sink, mode),
      deviceId: uuid(),
    });

    // Offline: kept, attempt counted, nothing lost.
    expect((await engine.syncOnce()).outcome).toBe('offline');
    expect((await store.entries())[0]).toMatchObject({ state: 'pending', attempts: 1 });

    // Online but the answer is lost: the server applied it, the device does not know.
    mode.online = true;
    mode.lostResponse = true;
    expect((await engine.syncOnce()).outcome).toBe('offline');
    expect((await store.entries())[0]?.state).toBe('pending');

    // Resend: same clientOpId, answered as duplicate.
    const report = await engine.syncOnce();
    expect(report).toMatchObject({ outcome: 'ok', applied: 0, duplicates: 1, pulled: 1 });
    expect((await store.entries())[0]).toMatchObject({ state: 'applied' });

    // Nothing more is sent, and the same clientOpId was the only one ever on the wire.
    const pushesBefore = sink.length;
    await engine.syncOnce();
    expect(sink.length).toBe(pushesBefore);
    expect(new Set(sink.flatMap((r) => r.ops.map((o) => o.clientOpId)))).toEqual(
      new Set([op.clientOpId]),
    );
    expect(sink.every((r) => r.ops.every((o) => o.kind === 'asbuilt_edit.record'))).toBe(true);

    // The pulled approval was stored for the next base version.
    const pulled = await store.remoteAsBuiltEdits();
    expect(pulled).toHaveLength(1);
    expect(pulled[0]).toMatchObject({ status: 'approved', approvedVersion: 1 });
    expect(await store.getCursor()).toBe('5');
  });
});
