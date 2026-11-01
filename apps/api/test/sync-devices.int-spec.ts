import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { RecordUpdateOp } from '@ftth/shared';
import { createHttpTransport, InMemorySyncStore, SyncEngine, type SyncReport } from '@ftth/sync';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createExecutionFixture,
  E0,
  N0,
  toWgs84,
  type ExecutionFixture,
} from './support/execution-fixtures.js';
import { createTestContext, type TestContext } from './support/test-app.js';

/**
 * Phase 3 sync tests (roadmap: "3 devices, network loss, wrong clock") with the real device sync
 * engine (`@ftth/sync`) talking HTTP to the real API on real PostGIS. The phone's network and
 * clock are simulated; WatermelonDB is replaced by the reference in-memory store.
 */

let ctx: TestContext;
let fx: ExecutionFixture;
let baseUrl: string;
let nearBox: [number, number];

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  fx = await createExecutionFixture(ctx);
  await ctx.app.listen(0, '127.0.0.1');
  const address = ctx.app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  nearBox = await toWgs84(ctx.pool, E0 + 50, N0 + 8);
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

/** Deterministic PRNG so a failing run can be replayed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

type NetworkMode = 'online' | 'airplane';

/** The phone's network: airplane mode, or flaky (requests lost before or after the server acts). */
class SimulatedNetwork {
  mode: NetworkMode = 'online';
  lostRequests = 0;
  lostResponses = 0;

  constructor(
    private readonly random: () => number = () => 1,
    private readonly lossBefore = 0,
    private readonly lossAfter = 0,
  ) {}

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (this.mode === 'airplane') throw new TypeError('Network request failed');
    if (this.random() < this.lossBefore) {
      this.lostRequests += 1;
      throw new TypeError('Network request failed');
    }
    const response = await fetch(url, init);
    if (this.random() < this.lossAfter) {
      // The server did the work; the phone never hears back.
      await response.arrayBuffer();
      this.lostResponses += 1;
      throw new TypeError('Network request failed');
    }
    return response;
  };
}

function jpeg(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 0xff;
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

class Device {
  readonly id = randomUUID();
  readonly store = new InMemorySyncStore();
  readonly engine: SyncEngine;
  private seq = 0;

  constructor(
    token: string,
    readonly network: SimulatedNetwork,
    /** Device clock error in milliseconds (positive: ahead of the real time). */
    private readonly clockSkewMs = 0,
    chunkBytes = 64 * 1024,
  ) {
    this.engine = new SyncEngine({
      store: this.store,
      photos: this.store,
      deviceId: this.id,
      chunkBytes,
      transport: createHttpTransport({
        baseUrl,
        projectId: fx.projectId,
        getAccessToken: async () => token,
        fetch: this.network.fetch,
      }),
    });
  }

  private now(): string {
    return new Date(Date.now() + this.clockSkewMs).toISOString();
  }

  /** What the update tool saves: one operation with its compressed photo, offline. */
  record(featureId: string, itemId: string, quantity: string, photoSize = 20_000): RecordUpdateOp {
    this.seq += 1;
    const photo = jpeg(photoSize, this.seq);
    const photoId = randomUUID();
    const at = this.now();
    const op: RecordUpdateOp = {
      kind: 'execution_update.record',
      clientOpId: randomUUID(),
      capturedAt: at,
      payload: {
        featureId,
        designRevisionId: fx.revisionId,
        workType: 'civil',
        lines: [{ workOrderItemId: itemId, quantity, role: 'work' }],
        label: null,
        note: `device ${this.id.slice(0, 4)} #${this.seq}`,
        gps: { lon: nearBox[0], lat: nearBox[1], accuracyM: 4, at },
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
    this.store.enqueue(op, new Map([[photoId, photo]]));
    return op;
  }

  /** Retries like the app does (no real waiting) until a round ends `ok`. */
  async syncUntilDone(maxRounds = 200): Promise<SyncReport[]> {
    const reports: SyncReport[] = [];
    for (let round = 0; round < maxRounds; round++) {
      const report = await this.engine.syncOnce();
      reports.push(report);
      const pendingPhotos = await this.store.photosToUpload();
      const pendingOps = await this.store.pendingOps(1);
      if (report.outcome === 'ok' && pendingOps.length === 0 && pendingPhotos.length === 0) {
        return reports;
      }
      if (report.outcome === 'forbidden' || report.outcome === 'unauthorized') break;
    }
    throw new Error(`device ${this.id} did not finish: ${JSON.stringify(reports.at(-1))}`);
  }
}

async function serverRowsFor(deviceIds: readonly string[]) {
  const { rows } = await ctx.pool.query<{
    client_op_id: string;
    device_id: string;
    flags: string[];
    stored: number;
  }>(
    `SELECT u.client_op_id, u.device_id, u.flags,
            (SELECT count(*)::int FROM execution_photos p
             WHERE p.update_id = u.id AND p.stored_at IS NOT NULL) AS stored
     FROM execution_updates u WHERE u.device_id = ANY($1::uuid[]) ORDER BY u.sync_seq`,
    [deviceIds],
  );
  return rows;
}

describe('Phase 3 acceptance (simulated): 20 updates in airplane mode', () => {
  it('syncs all 20 updates and photos exactly once when the network returns', async () => {
    const network = new SimulatedNetwork();
    const phone = new Device(fx.tokens.supervisorA, network);
    network.mode = 'airplane';
    const features = [fx.boxA, fx.routeA];
    const ops = Array.from({ length: 20 }, (_, i) =>
      phone.record(features[i % 2] ?? fx.boxA, fx.items.civilMetres, '1.5'),
    );

    const offline = await phone.engine.syncOnce();
    expect(offline.outcome).toBe('offline');
    expect(await serverRowsFor([phone.id])).toHaveLength(0);
    // Several retries while still in airplane mode change nothing.
    for (let i = 0; i < 3; i++) expect((await phone.engine.syncOnce()).outcome).toBe('offline');

    network.mode = 'online';
    const reports = await phone.syncUntilDone();
    expect(reports.at(-1)?.outcome).toBe('ok');

    const rows = await serverRowsFor([phone.id]);
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((row) => row.client_op_id))).toEqual(
      new Set(ops.map((op) => op.clientOpId)),
    );
    expect(rows.every((row) => row.stored === 1)).toBe(true);
    expect(phone.store.all().every((entry) => entry.state === 'applied')).toBe(true);
    // The phone now sees its own 20 updates from the server.
    const mine = [...phone.store.remote.values()].filter((u) => u.deviceId === phone.id);
    expect(mine).toHaveLength(20);

    // Syncing again sends nothing new.
    const again = await phone.engine.syncOnce();
    expect(again).toMatchObject({ outcome: 'ok', applied: 0, duplicates: 0, photosStored: 0 });
    expect(await serverRowsFor([phone.id])).toHaveLength(20);
  });
});

describe('three devices on the same zone with a flaky network', () => {
  it('ends with every update once, quantities added up and everyone seeing everything', async () => {
    const random = rng(20261030);
    const devices = [
      new Device(fx.tokens.supervisorA, new SimulatedNetwork(random, 0.2, 0.25)),
      // Same supervisor on a second phone.
      new Device(fx.tokens.supervisorA, new SimulatedNetwork(random, 0.2, 0.25)),
      new Device(fx.tokens.supervisorA2, new SimulatedNetwork(random, 0.2, 0.25)),
    ];
    // All three record on the same box and the same item while offline.
    const ops = devices.flatMap((device) =>
      Array.from({ length: 10 }, () => device.record(fx.boxA, fx.items.civilPieces, '0.25')),
    );
    const before = await ctx.pool.query<{ s: string | null }>(
      `SELECT sum(quantity)::text AS s FROM execution_update_lines WHERE work_order_item_id = $1`,
      [fx.items.civilPieces],
    );

    await Promise.all(devices.map((device) => device.syncUntilDone()));
    // A last round on a good network so every device pulls the others' work.
    const clean = devices.map(
      (device) =>
        new SyncEngine({
          store: device.store,
          photos: device.store,
          deviceId: device.id,
          transport: createHttpTransport({
            baseUrl,
            projectId: fx.projectId,
            getAccessToken: async () =>
              device === devices[2] ? fx.tokens.supervisorA2 : fx.tokens.supervisorA,
          }),
        }),
    );
    for (const engine of clean) expect((await engine.syncOnce()).outcome).toBe('ok');

    const lost = devices.reduce(
      (n, device) => n + device.network.lostRequests + device.network.lostResponses,
      0,
    );
    expect(lost).toBeGreaterThan(5); // the network really was flaky

    const rows = await serverRowsFor(devices.map((device) => device.id));
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((row) => row.client_op_id)).size).toBe(30);
    expect(new Set(rows.map((row) => row.client_op_id))).toEqual(
      new Set(ops.map((op) => op.clientOpId)),
    );
    expect(rows.every((row) => row.stored === 1)).toBe(true);

    const after = await ctx.pool.query<{ s: string }>(
      `SELECT sum(quantity)::text AS s FROM execution_update_lines WHERE work_order_item_id = $1`,
      [fx.items.civilPieces],
    );
    // Additive rule: 30 × 0.25 more, exactly (numeric, no float).
    const delta = Number(after.rows[0]?.s) - Number(before.rows[0]?.s ?? 0);
    expect(delta).toBe(7.5);

    for (const device of devices) {
      const seen = new Set(
        [...device.store.remote.values()]
          .filter((update) => devices.some((d) => d.id === update.deviceId))
          .map((update) => update.clientOpId),
      );
      expect(seen.size).toBe(30);
    }
  });
});

describe('wrong device clocks', () => {
  it('accepts the updates, flags the clocks and orders by the server, not the device', async () => {
    const network = new SimulatedNetwork();
    const ahead = new Device(fx.tokens.supervisorA, network, 3 * 86_400_000);
    const behind = new Device(fx.tokens.supervisorA, network, -Date.now()); // 1970
    const correct = new Device(fx.tokens.supervisorA, network);
    const a = ahead.record(fx.boxA, fx.items.civilMetres, '1');
    await ahead.syncUntilDone();
    const b = behind.record(fx.boxA, fx.items.civilMetres, '1');
    await behind.syncUntilDone();
    const c = correct.record(fx.boxA, fx.items.civilMetres, '1');
    await correct.syncUntilDone();

    const rows = await serverRowsFor([ahead.id, behind.id, correct.id]);
    expect(rows.map((row) => row.client_op_id)).toEqual([a.clientOpId, b.clientOpId, c.clientOpId]);
    expect(rows.map((row) => row.flags.filter((flag) => flag.startsWith('CLOCK')))).toEqual([
      ['CLOCK_AHEAD'],
      ['CLOCK_BEHIND'],
      [],
    ]);
    // The device clock is kept as evidence, the server time is what QC sorts by.
    const { rows: times } = await ctx.pool.query<{ captured: Date; received: Date }>(
      `SELECT captured_at AS captured, received_at AS received FROM execution_updates
       WHERE client_op_id = $1`,
      [b.clientOpId],
    );
    expect(times[0]?.captured.getUTCFullYear()).toBe(1970);
    expect(Math.abs((times[0]?.received.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);
  });
});

describe('network loss in the middle of a photo upload', () => {
  it('resumes from the server offset and stores a byte-identical photo', async () => {
    let chunkCalls = 0;
    const network = new SimulatedNetwork();
    const original = network.fetch;
    const flaky = async (url: string, init: RequestInit): Promise<Response> => {
      if (url.endsWith('/content')) {
        chunkCalls += 1;
        // Second chunk: delivered to the server, response lost. Fourth: never sent.
        if (chunkCalls === 2) {
          const response = await original(url, init);
          await response.arrayBuffer();
          throw new TypeError('Network request failed');
        }
        if (chunkCalls === 4) throw new TypeError('Network request failed');
      }
      return original(url, init);
    };
    Object.assign(network, { fetch: flaky });
    const phone = new Device(fx.tokens.supervisorA, network, 0, 10_000);
    const op = phone.record(fx.boxA, fx.items.civilMetres, '1', 45_000);
    const photoId = op.payload.photos[0]?.photoId ?? '';

    const reports = await phone.syncUntilDone();
    expect(reports.filter((report) => report.outcome === 'offline')).toHaveLength(2);
    const { rows } = await ctx.pool.query<{ storage_key: string }>(
      'SELECT storage_key FROM execution_photos WHERE id = $1',
      [photoId],
    );
    const stored = await readFile(join(ctx.storageRoot, rows[0]?.storage_key ?? ''));
    expect(sha(stored)).toBe(op.payload.photos[0]?.sha256);
    // 45 kB in 10 kB chunks = 5 chunks; one lost before sending is retried, the one whose
    // response was lost is not resent (the status call tells the phone where to resume).
    expect(chunkCalls).toBe(6);
  });
});
