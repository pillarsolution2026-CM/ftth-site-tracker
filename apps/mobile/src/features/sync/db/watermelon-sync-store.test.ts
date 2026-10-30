import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import type { ExecutionUpdate, SyncOp } from '@ftth/shared';
import { SyncEngine, type SyncTransport } from '@ftth/sync';
import { createLocalDatabase } from './database';
import { localSchema } from './schema';
import { WatermelonSyncStore } from './watermelon-sync-store';

const PROJECT = '00000000-0000-4000-8000-0000000000aa';
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${(++counter).toString().padStart(12, '0')}`;

const USER_A = '00000000-0000-4000-8000-0000000000ab';
const USER_B = '00000000-0000-4000-8000-0000000000bb';

function makeStore(files = new Map<string, Uint8Array>()) {
  const adapter = new LokiJSAdapter({
    schema: localSchema,
    useWebWorker: false,
    useIncrementalIndexedDB: false,
    dbName: `test-${uuid()}`,
  });
  const db = createLocalDatabase(adapter);
  const read = async (uri: string) => {
    const bytes = files.get(uri);
    if (!bytes) throw new Error(`no file ${uri}`);
    return bytes;
  };
  const store = new WatermelonSyncStore(db, PROJECT, USER_A, read);
  const storeOf = (userId: string) => new WatermelonSyncStore(db, PROJECT, userId, read);
  return { db, store, files, storeOf };
}

function op(photoId: string, size = 4): SyncOp {
  return {
    kind: 'execution_update.record',
    clientOpId: uuid(),
    capturedAt: '2026-10-30T10:00:00Z',
    payload: {
      featureId: uuid(),
      designRevisionId: uuid(),
      workType: 'civil',
      lines: [{ workOrderItemId: uuid(), quantity: '2', role: 'work' }],
      label: null,
      note: null,
      gps: null,
      photos: [
        {
          photoId,
          requirementKey: 'general',
          sha256: 'a'.repeat(64),
          sizeBytes: size,
          contentType: 'image/jpeg',
          takenAt: '2026-10-30T10:00:00Z',
          gps: null,
        },
      ],
      acknowledgedWarnings: [],
    },
  };
}

describe('WatermelonSyncStore', () => {
  it('keeps the outbox in creation order and tracks results, attempts and photos', async () => {
    const { store } = makeStore();
    const photos = [uuid(), uuid(), uuid()];
    const ops = photos.map((photoId) => op(photoId));
    for (const [i, o] of ops.entries()) {
      await store.enqueue(o, [{ photoId: photos[i] ?? '', fileUri: `file://${i}`, sizeBytes: 4 }]);
    }
    expect((await store.pendingOps(10)).map((e) => e.clientOpId)).toEqual(
      ops.map((o) => o.clientOpId),
    );
    expect((await store.pendingOps(2)).length).toBe(2);
    expect(await store.photosToUpload()).toEqual([]);

    await store.markAttemptFailed([ops[0]?.clientOpId ?? '']);
    await store.markApplied(ops[0]?.clientOpId ?? '', uuid());
    await store.markRejected(ops[1]?.clientOpId ?? '', 'FEATURE_OUT_OF_SCOPE');
    const entries = await store.entries();
    expect(entries.map((e) => e.state)).toEqual(['pending', 'rejected', 'applied']);
    expect(entries[2]?.attempts).toBe(1);
    expect(entries[1]?.rejection).toBe('FEATURE_OUT_OF_SCOPE');

    const toUpload = await store.photosToUpload();
    expect(toUpload.map((p) => p.photoId)).toEqual([photos[0]]);
    await store.setPhotoProgress(photos[0] ?? '', {
      uploadedBytes: 4,
      state: 'stored',
      checksumFailures: 0,
    });
    expect(await store.photosToUpload()).toEqual([]);
    expect(await store.storedPhotoUris()).toEqual(['file://0']);
    expect(await store.summary()).toEqual({
      pending: 1,
      rejected: 1,
      photosWaiting: 2,
      photosFailed: 0,
    });
  });

  it("keeps each user's work apart on a shared phone", async () => {
    const { store, storeOf } = makeStore();
    const photoId = uuid();
    const o = op(photoId);
    await store.enqueue(o, [{ photoId, fileUri: 'file://a', sizeBytes: 4 }]);
    await store.markApplied(o.clientOpId, uuid());
    await store.setCursor('7');
    const other = storeOf(USER_B);
    expect(await other.pendingOps(10)).toEqual([]);
    expect(await other.entries()).toEqual([]);
    expect(await other.photosToUpload()).toEqual([]);
    expect(await other.getCursor()).toBe('0');
    await expect(other.read(photoId)).rejects.toThrow(/Unknown photo/);
    await expect(other.markApplied(o.clientOpId, uuid())).rejects.toThrow(/Unknown outbox entry/);
    expect(await other.summary()).toEqual({
      pending: 0,
      rejected: 0,
      photosWaiting: 0,
      photosFailed: 0,
    });
    // The first user finds everything again after signing back in.
    expect((await storeOf(USER_A).photosToUpload()).map((p) => p.photoId)).toEqual([photoId]);
  });

  it('refuses an operation whose photo files do not match', async () => {
    const { store } = makeStore();
    await expect(store.enqueue(op(uuid()), [])).rejects.toThrow(/do not match/);
    await expect(
      store.enqueue(op(uuid()), [{ photoId: uuid(), fileUri: 'x', sizeBytes: 1 }]),
    ).rejects.toThrow(/do not match/);
    expect(await store.pendingOps(10)).toEqual([]);
  });

  it('persists the cursor and the server copies of updates', async () => {
    const { store } = makeStore();
    expect(await store.getCursor()).toBe('0');
    await store.setCursor('42');
    await store.setCursor('43');
    expect(await store.getCursor()).toBe('43');
    await store.setLastSyncAt('2026-10-30T10:00:00.000Z');
    expect(await store.getLastSyncAt()).toBe('2026-10-30T10:00:00.000Z');

    const featureId = uuid();
    const update: ExecutionUpdate = {
      id: uuid(),
      clientOpId: uuid(),
      featureId,
      featureType: 'box',
      designRevisionId: uuid(),
      userId: uuid(),
      deviceId: uuid(),
      workType: 'civil',
      status: 'pending',
      lines: [],
      label: null,
      note: null,
      capturedAt: '2026-10-30T10:00:00Z',
      receivedAt: '2026-10-30T10:00:00Z',
      gpsDistanceM: null,
      flags: [],
      reviewReason: null,
      photos: [],
    };
    await store.applyRemoteUpdates([update]);
    await store.applyRemoteUpdates([
      { ...update, status: 'rejected', reviewReason: 'صورة غير واضحة' },
    ]);
    const history = await store.remoteUpdatesFor(featureId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'rejected', reviewReason: 'صورة غير واضحة' });
  });

  it('drives the shared sync engine end to end', async () => {
    const { store, files } = makeStore();
    const photoId = uuid();
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    files.set('file://p', bytes);
    const o = op(photoId, 4);
    await store.enqueue(o, [{ photoId, fileUri: 'file://p', sizeBytes: 4 }]);
    const received: Uint8Array[] = [];
    const transport: SyncTransport = {
      push: async (request) => ({
        serverTime: '2026-10-30T10:00:00Z',
        results: request.ops.map((x) => ({
          clientOpId: x.clientOpId,
          outcome: 'applied' as const,
          updateId: uuid(),
        })),
      }),
      changes: async () => ({
        serverTime: '2026-10-30T10:00:00Z',
        cursor: '1',
        hasMore: false,
        updates: [],
      }),
      photoStatus: async (id) => ({
        photoId: id,
        sizeBytes: 4,
        receivedBytes: 0,
        state: 'receiving',
      }),
      putPhotoChunk: async (id, _offset, chunk) => {
        received.push(chunk);
        return { photoId: id, sizeBytes: 4, receivedBytes: 4, state: 'stored' };
      },
    };
    const engine = new SyncEngine({ store, transport, photos: store, deviceId: uuid() });
    expect(await engine.syncOnce()).toMatchObject({ outcome: 'ok', applied: 1, photosStored: 1 });
    expect(received).toEqual([bytes]);
    expect(await store.getCursor()).toBe('1');
    expect(await store.summary()).toMatchObject({ pending: 0, photosWaiting: 0 });
  });
});
