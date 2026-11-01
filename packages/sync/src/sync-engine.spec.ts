import { createHash, randomUUID } from 'node:crypto';
import type {
  AsBuiltEdit,
  ExecutionUpdate,
  OpResult,
  PhotoUploadStatus,
  SyncChangesResponse,
  SyncOp,
  SyncPushRequest,
  SyncPushResponse,
} from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { backoffDelayMs, BACKOFF_CAP_MS } from './backoff.js';
import { InMemorySyncStore } from './in-memory-store.js';
import { TransportError, type SyncTransport } from './ports.js';
import { SyncEngine } from './sync-engine.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function jpeg(size: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(size).fill(seed);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

function makeOp(photo: Uint8Array, photoId = randomUUID()): SyncOp {
  const at = '2026-10-30T10:00:00Z';
  return {
    kind: 'execution_update.record',
    clientOpId: randomUUID(),
    capturedAt: at,
    payload: {
      featureId: randomUUID(),
      designRevisionId: randomUUID(),
      workType: 'civil',
      lines: [{ workOrderItemId: randomUUID(), quantity: '1', role: 'work' }],
      label: null,
      note: null,
      gps: null,
      photos: [
        {
          photoId,
          requirementKey: 'general',
          sha256: sha(photo),
          sizeBytes: photo.length,
          contentType: 'image/jpeg',
          takenAt: at,
          gps: null,
        },
      ],
      acknowledgedWarnings: [],
    },
  };
}

function makeAsBuiltOp(): SyncOp {
  return {
    kind: 'asbuilt_edit.record',
    clientOpId: randomUUID(),
    capturedAt: '2026-11-01T10:00:00Z',
    payload: {
      kind: 'reshape',
      featureId: randomUUID(),
      designRevisionId: randomUUID(),
      baseVersion: 0,
      note: null,
      gps: null,
      geometry: {
        type: 'LineString',
        coordinates: [
          [330000, 3340000],
          [330012, 3340009],
        ],
      },
    },
  };
}

function asBuiltEditFrom(
  op: Extract<SyncOp, { kind: 'asbuilt_edit.record' }>,
  id: string,
  deviceId: string,
): AsBuiltEdit {
  const { payload } = op;
  return {
    id,
    clientOpId: op.clientOpId,
    featureId: payload.featureId,
    kind: payload.kind,
    featureType: 'route',
    designRevisionId: payload.designRevisionId,
    baseVersion: 'baseVersion' in payload ? payload.baseVersion : null,
    geometry: 'geometry' in payload ? payload.geometry : null,
    label: 'label' in payload ? payload.label : null,
    lengthM: '15',
    note: null,
    userId: randomUUID(),
    userName: 'Supervisor',
    deviceId,
    capturedAt: op.capturedAt,
    receivedAt: op.capturedAt,
    flags: [],
    status: 'pending',
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    approvedVersion: null,
  };
}

/** Server semantics of ADR-024 in memory: idempotent ops, offset-checked uploads, cursor. */
class FakeServer implements SyncTransport {
  readonly applied = new Map<string, { updateId: string; json: string }>();
  readonly photos = new Map<
    string,
    { size: number; sha: string; received: Uint8Array[]; stored: boolean }
  >();
  readonly updates: ExecutionUpdate[] = [];
  readonly asBuiltEdits: AsBuiltEdit[] = [];
  pushCalls = 0;
  /** Hooks to simulate failures; return true to swallow the response after the server acted. */
  failNext: (() => TransportError | null) | null = null;
  dropResponseAfterPush = false;
  dropResponseAfterChunk = false;
  rejectFeature: string | null = null;
  invalidOp: string | null = null;

  async push(request: SyncPushRequest): Promise<SyncPushResponse> {
    this.pushCalls += 1;
    this.maybeFail();
    if (this.invalidOp && request.ops.some((op) => op.clientOpId === this.invalidOp)) {
      throw new TransportError('http', 400, 'VALIDATION_FAILED');
    }
    const results: OpResult[] = request.ops.map((op) => {
      const json = JSON.stringify(op);
      const known = this.applied.get(op.clientOpId);
      if (known) {
        return known.json === json
          ? { clientOpId: op.clientOpId, outcome: 'duplicate', updateId: known.updateId }
          : { clientOpId: op.clientOpId, outcome: 'rejected', code: 'OP_ID_REUSED' };
      }
      if (op.payload.featureId === this.rejectFeature) {
        return { clientOpId: op.clientOpId, outcome: 'rejected', code: 'FEATURE_OUT_OF_SCOPE' };
      }
      const updateId = randomUUID();
      this.applied.set(op.clientOpId, { updateId, json });
      if (op.kind === 'asbuilt_edit.record') {
        this.asBuiltEdits.push(asBuiltEditFrom(op, updateId, request.deviceId));
        return { clientOpId: op.clientOpId, outcome: 'applied', updateId };
      }
      for (const photo of op.payload.photos) {
        this.photos.set(photo.photoId, {
          size: photo.sizeBytes,
          sha: photo.sha256,
          received: [],
          stored: false,
        });
      }
      this.updates.push({
        id: updateId,
        clientOpId: op.clientOpId,
        featureId: op.payload.featureId,
        featureType: 'box',
        designRevisionId: op.payload.designRevisionId,
        userId: randomUUID(),
        deviceId: request.deviceId,
        workType: op.payload.workType,
        status: 'pending',
        lines: op.payload.lines,
        label: null,
        note: null,
        capturedAt: op.capturedAt,
        receivedAt: op.capturedAt,
        gpsDistanceM: null,
        flags: [],
        reviewReason: null,
        photos: [],
      });
      return { clientOpId: op.clientOpId, outcome: 'applied', updateId };
    });
    if (this.dropResponseAfterPush) {
      this.dropResponseAfterPush = false;
      throw new TransportError('network');
    }
    return { serverTime: new Date().toISOString(), results };
  }

  async changes(cursor: string, limit: number): Promise<SyncChangesResponse> {
    this.maybeFail();
    // One server sequence over both record kinds (ADR-030): updates first, then As-Built edits.
    const all: (ExecutionUpdate | AsBuiltEdit)[] = [...this.updates, ...this.asBuiltEdits];
    const from = Number(cursor);
    const page = all.slice(from, from + limit);
    return {
      serverTime: new Date().toISOString(),
      cursor: String(from + page.length),
      hasMore: from + page.length < all.length,
      updates: page.filter((item): item is ExecutionUpdate => 'lines' in item),
      asBuiltEdits: page.filter((item): item is AsBuiltEdit => 'kind' in item),
    };
  }

  private status(photoId: string): PhotoUploadStatus {
    const photo = this.photos.get(photoId);
    if (!photo) throw new TransportError('http', 404, 'NOT_FOUND');
    const received = photo.received.reduce((n, part) => n + part.length, 0);
    return {
      photoId,
      sizeBytes: photo.size,
      receivedBytes: received,
      state: photo.stored ? 'stored' : 'receiving',
    };
  }

  async photoStatus(photoId: string): Promise<PhotoUploadStatus> {
    this.maybeFail();
    return this.status(photoId);
  }

  async putPhotoChunk(
    photoId: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<PhotoUploadStatus> {
    this.maybeFail();
    const photo = this.photos.get(photoId);
    if (!photo) throw new TransportError('http', 404, 'NOT_FOUND');
    const current = this.status(photoId);
    if (offset !== current.receivedBytes || photo.stored) {
      throw new TransportError('http', 409, 'CONFLICT', current);
    }
    photo.received.push(Uint8Array.from(bytes));
    const after = this.status(photoId);
    if (after.receivedBytes === photo.size) {
      const all = new Uint8Array(photo.size);
      let at = 0;
      for (const part of photo.received) {
        all.set(part, at);
        at += part.length;
      }
      if (sha(all) !== photo.sha) {
        photo.received = [];
        throw new TransportError('http', 422, 'VALIDATION_FAILED', this.status(photoId));
      }
      photo.stored = true;
    }
    if (this.dropResponseAfterChunk) {
      this.dropResponseAfterChunk = false;
      throw new TransportError('network');
    }
    return this.status(photoId);
  }

  private maybeFail(): void {
    const error = this.failNext?.();
    if (error) throw error;
  }
}

function setup(options: { batchSize?: number; chunkBytes?: number } = {}) {
  const server = new FakeServer();
  const store = new InMemorySyncStore();
  const engine = new SyncEngine({
    store,
    transport: server,
    photos: store,
    deviceId: randomUUID(),
    batchSize: options.batchSize ?? 50,
    chunkBytes: options.chunkBytes ?? 1000,
  });
  const record = (size = 2500, seed = 1) => {
    const bytes = jpeg(size, seed);
    const op = makeOp(bytes);
    const photoId =
      (op.kind === 'execution_update.record' ? op.payload.photos[0]?.photoId : undefined) ?? '';
    store.enqueue(op, new Map([[photoId, bytes]]));
    return { op, photoId };
  };
  return { server, store, engine, record };
}

describe('SyncEngine', () => {
  it('drains the outbox in batches, uploads photos in chunks and pulls changes', async () => {
    const { server, store, engine, record } = setup({ batchSize: 3 });
    const recorded = Array.from({ length: 7 }, (_, i) => record(2500, i + 1));
    const report = await engine.syncOnce();
    expect(report).toEqual({
      outcome: 'ok',
      applied: 7,
      duplicates: 0,
      rejected: 0,
      photosStored: 7,
      photosFailed: 0,
      pulled: 7,
    });
    expect(server.pushCalls).toBe(3);
    expect(store.all().every((entry) => entry.state === 'applied' && entry.updateId)).toBe(true);
    for (const { photoId } of recorded) {
      expect(server.photos.get(photoId)?.stored).toBe(true);
      expect(server.photos.get(photoId)?.received).toHaveLength(3);
      expect(store.photo(photoId)?.state).toBe('stored');
    }
    expect(await store.getCursor()).toBe('7');
    // Nothing left to do: a second round sends nothing.
    const again = await engine.syncOnce();
    expect(again).toMatchObject({ outcome: 'ok', applied: 0, photosStored: 0, pulled: 0 });
    expect(server.pushCalls).toBe(3);
  });

  it('keeps everything while offline and sends it once the network is back', async () => {
    const { server, store, engine, record } = setup();
    for (let i = 0; i < 20; i++) record();
    server.failNext = () => new TransportError('network');
    const offline = await engine.syncOnce();
    expect(offline.outcome).toBe('offline');
    expect(store.all().every((entry) => entry.state === 'pending' && entry.attempts === 1)).toBe(
      true,
    );
    server.failNext = null;
    const online = await engine.syncOnce();
    expect(online).toMatchObject({ outcome: 'ok', applied: 20, photosStored: 20 });
    expect(server.applied.size).toBe(20);
  });

  it('turns a lost push response into duplicates, never into a second copy', async () => {
    const { server, store, engine, record } = setup();
    for (let i = 0; i < 5; i++) record();
    server.dropResponseAfterPush = true;
    expect((await engine.syncOnce()).outcome).toBe('offline');
    expect(server.applied.size).toBe(5);
    const retry = await engine.syncOnce();
    expect(retry).toMatchObject({ outcome: 'ok', applied: 0, duplicates: 5 });
    expect(server.updates).toHaveLength(5);
    expect(store.all().every((entry) => entry.state === 'applied')).toBe(true);
  });

  it('marks rejected entries and does not upload their photos', async () => {
    const { server, store, engine, record } = setup();
    const { op, photoId } = record();
    server.rejectFeature = op.payload.featureId;
    const report = await engine.syncOnce();
    expect(report).toMatchObject({ outcome: 'ok', rejected: 1, photosStored: 0 });
    expect(store.all()[0]).toMatchObject({ state: 'rejected', rejection: 'FEATURE_OUT_OF_SCOPE' });
    expect(store.photo(photoId)?.state).toBe('waiting');
  });

  it('isolates an entry the server refuses as invalid so the rest still syncs', async () => {
    const { server, store, engine, record } = setup();
    const entries = [record(), record(), record()];
    server.invalidOp = entries[1]?.op.clientOpId ?? null;
    const report = await engine.syncOnce();
    expect(report).toMatchObject({ outcome: 'ok', applied: 2, rejected: 1 });
    expect(store.all().map((entry) => entry.state)).toEqual(['applied', 'rejected', 'applied']);
    expect(store.all()[1]?.rejection).toBe('VALIDATION_FAILED');
  });

  it('resumes a photo upload from the server offset after a lost chunk response', async () => {
    const { server, store, engine, record } = setup({ chunkBytes: 1000 });
    const { photoId } = record(2500);
    server.dropResponseAfterChunk = true;
    expect((await engine.syncOnce()).outcome).toBe('offline');
    expect(server.photos.get(photoId)?.received).toHaveLength(1);
    expect(store.photo(photoId)?.state).toBe('waiting');
    const report = await engine.syncOnce();
    expect(report).toMatchObject({ outcome: 'ok', photosStored: 1 });
    // 2,500 bytes in three chunks; the first was not sent twice.
    expect(server.photos.get(photoId)?.received.map((part) => part.length)).toEqual([
      1000, 1000, 500,
    ]);
  });

  it('recovers from a 409 by resuming at the offset the server reports', async () => {
    const { server, engine, record } = setup({ chunkBytes: 1000 });
    const { photoId } = record(2500);
    let calls = 0;
    const original = server.putPhotoChunk.bind(server);
    server.putPhotoChunk = async (id, offset, bytes) => {
      calls += 1;
      // Another attempt already delivered the first chunk.
      if (calls === 1) {
        await original(id, offset, bytes);
        throw new TransportError('http', 409, 'CONFLICT', {
          photoId: id,
          sizeBytes: 2500,
          receivedBytes: 1000,
          state: 'receiving',
        });
      }
      return original(id, offset, bytes);
    };
    expect((await engine.syncOnce()).photosStored).toBe(1);
    expect(server.photos.get(photoId)?.stored).toBe(true);
  });

  it('retries a photo that fails its checksum and gives up after three complete attempts', async () => {
    const { server, store, engine, record } = setup({ chunkBytes: 5000 });
    const { photoId } = record(2500);
    const photo = server.photos;
    // The device copy is corrupted after the sha256 was taken.
    const bytes = await store.read(photoId);
    bytes[10] = 0;
    const report = await engine.syncOnce();
    expect(report).toMatchObject({ outcome: 'ok', photosStored: 0, photosFailed: 1 });
    expect(store.photo(photoId)).toMatchObject({ state: 'failed', checksumFailures: 3 });
    expect(photo.get(photoId)?.stored).toBe(false);
  });

  it('reports unauthorized, forbidden and server errors without losing anything', async () => {
    for (const [status, outcome] of [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [500, 'server_error'],
      [429, 'server_error'],
    ] as const) {
      const { server, store, engine, record } = setup();
      record();
      server.failNext = () => new TransportError('http', status);
      expect((await engine.syncOnce()).outcome).toBe(outcome);
      expect(store.all()[0]?.state).toBe('pending');
    }
  });

  it('joins a round that is already running instead of starting a second one', async () => {
    const { server, engine, record } = setup();
    record();
    const [a, b] = await Promise.all([engine.syncOnce(), engine.syncOnce()]);
    expect(a).toBe(b);
    expect(server.pushCalls).toBe(1);
  });

  it('stops on errors during the pull and keeps the cursor of the last good page', async () => {
    const { server, store, engine, record } = setup();
    record();
    let pulls = 0;
    const original = server.changes.bind(server);
    server.changes = async (cursor, limit) => {
      pulls += 1;
      if (pulls === 1) throw new TransportError('network');
      return original(cursor, limit);
    };
    expect((await engine.syncOnce()).outcome).toBe('offline');
    expect(await store.getCursor()).toBe('0');
    expect((await engine.syncOnce()).pulled).toBe(1);
    expect(await store.getCursor()).toBe('1');
  });
});

describe('SyncEngine with As-Built edits (ADR-030)', () => {
  it('sends an As-Built edit through the same outbox, once, and pulls its server record', async () => {
    const { server, store, engine, record } = setup();
    record();
    const edit = makeAsBuiltOp();
    store.enqueue(edit, new Map());
    const report = await engine.syncOnce();
    expect(report).toMatchObject({ outcome: 'ok', applied: 2, photosStored: 1, pulled: 2 });
    expect(server.asBuiltEdits).toHaveLength(1);
    const entry = store.all().find((e) => e.clientOpId === edit.clientOpId);
    expect(entry?.state).toBe('applied');
    expect(store.remoteAsBuilt.get(entry?.updateId ?? '')?.clientOpId).toBe(edit.clientOpId);
    // A lost response then a resend: still one record on the server.
    const again = makeAsBuiltOp();
    store.enqueue(again, new Map());
    server.dropResponseAfterPush = true;
    expect((await engine.syncOnce()).outcome).toBe('offline');
    expect(await engine.syncOnce()).toMatchObject({ outcome: 'ok', duplicates: 1 });
    expect(server.asBuiltEdits).toHaveLength(2);
  });
});

describe('backoffDelayMs', () => {
  it('doubles from 2 s up to the 5 min cap with full jitter', () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1, 0.999)).toBeLessThanOrEqual(2000);
    expect(backoffDelayMs(3, 0.999)).toBeLessThanOrEqual(8000);
    expect(backoffDelayMs(3, 0.999)).toBeGreaterThan(7000);
    expect(backoffDelayMs(50, 0.999)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(backoffDelayMs(50, 0.999)).toBeGreaterThan(BACKOFF_CAP_MS - 1000);
    // Never a busy loop, even with random = 0.
    expect(backoffDelayMs(1, 0)).toBe(1000);
  });
});
