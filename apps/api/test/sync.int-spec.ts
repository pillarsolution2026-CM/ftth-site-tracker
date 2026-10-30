import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OfflineBundleSchema,
  PhotoUploadStatusSchema,
  SyncChangesResponseSchema,
  SyncPushResponseSchema,
  type OpResult,
} from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createExecutionFixture,
  E0,
  N0,
  publishRevision,
  toWgs84,
  type ExecutionFixture,
} from './support/execution-fixtures.js';
import { createTestContext, type TestContext } from './support/test-app.js';

let ctx: TestContext;
let fx: ExecutionFixture;
/** WGS 84 of a point 5 m from boxA, and of one 500 m away. */
let near: [number, number];
let far: [number, number];

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  fx = await createExecutionFixture(ctx);
  near = await toWgs84(ctx.pool, E0 + 50, N0 + 10);
  far = await toWgs84(ctx.pool, E0 + 50, N0 + 505);
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

const http = () => request(ctx.app.getHttpServer());
const pushUrl = (project = fx.projectId) => `/projects/${project}/sync/push`;

/** A tiny but valid JPEG body: SOI, APP0 marker, payload, EOI. */
function jpeg(size = 3000, seed = 1): Buffer {
  const bytes = Buffer.alloc(size, seed);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface OpOptions {
  clientOpId?: string;
  featureId?: string;
  revisionId?: string;
  workType?: string;
  lines?: { workOrderItemId: string; quantity: string; role: string }[];
  gps?: [number, number] | null;
  capturedAt?: string;
  photo?: Buffer;
  photoId?: string;
}

function op(o: OpOptions = {}) {
  const photo = o.photo ?? jpeg();
  const gps = o.gps === undefined ? near : o.gps;
  const now = new Date().toISOString();
  return {
    kind: 'execution_update.record',
    clientOpId: o.clientOpId ?? randomUUID(),
    capturedAt: o.capturedAt ?? now,
    payload: {
      featureId: o.featureId ?? fx.boxA,
      designRevisionId: o.revisionId ?? fx.revisionId,
      workType: o.workType ?? 'civil',
      lines: o.lines ?? [{ workOrderItemId: fx.items.civilPieces, quantity: '1', role: 'work' }],
      label: null,
      note: null,
      gps: gps ? { lon: gps[0], lat: gps[1], accuracyM: 5, at: now } : null,
      photos: [
        {
          photoId: o.photoId ?? randomUUID(),
          requirementKey: 'general',
          sha256: sha(photo),
          sizeBytes: photo.length,
          contentType: 'image/jpeg',
          takenAt: now,
          gps: null,
        },
      ],
      acknowledgedWarnings: [],
    },
  };
}

async function push(token: string, ops: unknown[], deviceId = DEVICE, project = fx.projectId) {
  return http()
    .post(pushUrl(project))
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId, ops });
}

async function pushOne(token: string, operation: unknown, deviceId = DEVICE): Promise<OpResult> {
  const res = await push(token, [operation], deviceId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const [result] = SyncPushResponseSchema.parse(res.body).results;
  if (!result) throw new Error('no result');
  return result;
}

async function flagsOf(updateId: string): Promise<string[]> {
  const { rows } = await ctx.pool.query<{ flags: string[] }>(
    'SELECT flags FROM execution_updates WHERE id = $1',
    [updateId],
  );
  return rows[0]?.flags ?? [];
}

const DEVICE = randomUUID();

describe('POST /projects/:projectId/sync/push', () => {
  it('records an update with its lines, photos and event, and answers a resend as duplicate', async () => {
    const operation = op();
    const first = await pushOne(fx.tokens.supervisorA, operation);
    expect(first.outcome).toBe('applied');
    if (first.outcome !== 'applied') return;

    const second = await pushOne(fx.tokens.supervisorA, operation);
    expect(second).toEqual({
      clientOpId: operation.clientOpId,
      outcome: 'duplicate',
      updateId: first.updateId,
    });

    const updates = await ctx.pool.query(
      'SELECT status, feature_type, gps_distance_m::text AS d, flags FROM execution_updates WHERE client_op_id = $1',
      [operation.clientOpId],
    );
    expect(updates.rows).toEqual([
      { status: 'pending', feature_type: 'box', d: '5.000', flags: [] },
    ]);
    const lines = await ctx.pool.query(
      'SELECT role, quantity::text AS q FROM execution_update_lines WHERE update_id = $1',
      [first.updateId],
    );
    expect(lines.rows).toEqual([{ role: 'work', q: '1.0000' }]);
    const photos = await ctx.pool.query(
      'SELECT received_bytes, stored_at FROM execution_photos WHERE update_id = $1',
      [first.updateId],
    );
    expect(photos.rows).toEqual([{ received_bytes: 0, stored_at: null }]);
    const events = await ctx.pool.query(
      `SELECT type, actor_id, payload->>'clientOpId' AS op FROM events WHERE entity_id = $1`,
      [first.updateId],
    );
    expect(events.rows).toEqual([
      {
        type: 'execution_update.recorded',
        actor_id: fx.userIds.supervisorA,
        op: operation.clientOpId,
      },
    ]);
  });

  it('treats ten concurrent resends of one operation as a single update', async () => {
    const operation = op();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => pushOne(fx.tokens.supervisorA, operation)),
    );
    expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(9);
    const ids = new Set(results.map((r) => (r.outcome === 'rejected' ? null : r.updateId)));
    expect(ids.size).toBe(1);
    const { rows } = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM execution_updates WHERE client_op_id = $1',
      [operation.clientOpId],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('refuses a reused clientOpId with another payload, user, device or project', async () => {
    const operation = op();
    expect((await pushOne(fx.tokens.supervisorA, operation)).outcome).toBe('applied');
    const changed = {
      ...operation,
      payload: {
        ...operation.payload,
        lines: [{ workOrderItemId: fx.items.civilPieces, quantity: '2', role: 'work' }],
      },
    };
    const reused = { clientOpId: operation.clientOpId, outcome: 'rejected', code: 'OP_ID_REUSED' };
    expect(await pushOne(fx.tokens.supervisorA, changed)).toEqual(reused);
    expect(await pushOne(fx.tokens.supervisorA2, operation)).toEqual(reused);
    expect(await pushOne(fx.tokens.supervisorA, operation, randomUUID())).toEqual(reused);
    // The admin may act in any project; the id is still taken.
    const other = await push(fx.tokens.admin, [operation], DEVICE, fx.otherProjectId);
    expect(other.body.results[0]).toEqual(reused);
  });

  it('applies the valid operations of a batch and rejects the others', async () => {
    const good = op();
    const outOfScope = op({ featureId: fx.boxB });
    const res = await push(fx.tokens.supervisorA, [good, outOfScope]);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: OpResult) => r.outcome)).toEqual(['applied', 'rejected']);
    expect(res.body.results[1].code).toBe('FEATURE_OUT_OF_SCOPE');
    // Supervisor B owns zone B.
    expect((await pushOne(fx.tokens.supervisorB, op({ featureId: fx.boxB }))).outcome).toBe(
      'applied',
    );
  });

  it('rejects unknown features, foreign or mismatched items, unpublished revisions and reused photo ids', async () => {
    const reject = async (operation: unknown, code: string) => {
      const result = await pushOne(fx.tokens.supervisorA, operation);
      expect(result, code).toMatchObject({ outcome: 'rejected', code });
    };
    await reject(op({ featureId: randomUUID() }), 'FEATURE_NOT_FOUND');
    await reject(op({ revisionId: randomUUID() }), 'REVISION_NOT_PUBLISHED');
    await reject(
      op({ lines: [{ workOrderItemId: fx.foreignItem, quantity: '1', role: 'work' }] }),
      'ITEM_NOT_FOUND',
    );
    await reject(
      op({ lines: [{ workOrderItemId: fx.items.installation, quantity: '1', role: 'work' }] }),
      'ITEM_WORK_TYPE_MISMATCH',
    );
    const photoId = randomUUID();
    expect((await pushOne(fx.tokens.supervisorA, op({ photoId }))).outcome).toBe('applied');
    await reject(op({ photoId }), 'PHOTO_ID_REUSED');
    // Nothing of the rejected operations was stored: they can be fixed and sent again.
    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM sync_operations WHERE result->>'outcome' = 'rejected'`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('flags GPS distance, missing GPS, wrong clocks and overruns without rejecting', async () => {
    const applied = async (operation: unknown) => {
      const result = await pushOne(fx.tokens.supervisorA, operation);
      if (result.outcome !== 'applied') throw new Error(JSON.stringify(result));
      return flagsOf(result.updateId);
    };
    expect(await applied(op({ gps: far }))).toEqual(['GPS_FAR']);
    expect(await applied(op({ gps: null }))).toEqual(['GPS_MISSING']);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect(await applied(op({ capturedAt: tomorrow }))).toEqual(['CLOCK_AHEAD']);
    expect(await applied(op({ capturedAt: '1970-01-01T00:00:00Z' }))).toEqual(['CLOCK_BEHIND']);
    const overrun = op({
      featureId: fx.routeA,
      lines: [{ workOrderItemId: fx.items.civilMetres, quantity: '100.0001', role: 'work' }],
    });
    expect(await applied(overrun)).toEqual(['ITEM_OVERRUN']);
  });

  it('answers 403 to roles without execution:write and to other projects, 401 without a token', async () => {
    for (const token of [fx.tokens.qc, fx.tokens.contractor]) {
      expect((await push(token, [op()])).status).toBe(403);
    }
    expect((await push(fx.tokens.supervisorA, [op()], DEVICE, fx.otherProjectId)).status).toBe(403);
    expect(
      (
        await http()
          .post(pushUrl())
          .send({ deviceId: DEVICE, ops: [op()] })
      ).status,
    ).toBe(401);
  });

  it('validates the batch: float quantities and oversized batches are 400', async () => {
    const floaty = op({
      lines: [
        { workOrderItemId: fx.items.civilPieces, quantity: 1 as unknown as string, role: 'work' },
      ],
    });
    expect((await push(fx.tokens.supervisorA, [floaty])).status).toBe(400);
    const many = Array.from({ length: 51 }, () => op());
    expect((await push(fx.tokens.supervisorA, many)).status).toBe(400);
  });

  it('keeps updates immutable in the database', async () => {
    const result = await pushOne(fx.tokens.supervisorA, op());
    if (result.outcome !== 'applied') throw new Error('not applied');
    await expect(
      ctx.pool.query(`UPDATE execution_updates SET label = 'x' WHERE id = $1`, [result.updateId]),
    ).rejects.toThrow(/only the review fields/);
    await expect(
      ctx.pool.query('DELETE FROM execution_updates WHERE id = $1', [result.updateId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.pool.query('UPDATE execution_update_lines SET quantity = 2 WHERE update_id = $1', [
        result.updateId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query('TRUNCATE sync_operations CASCADE')).rejects.toThrow(/append-only/);
  });

  it('answers 409 instead of 500 when a work order with recorded execution is deleted', async () => {
    await pushOne(fx.tokens.supervisorA, op());
    const { rows } = await ctx.pool.query<{ work_order_id: string }>(
      'SELECT work_order_id FROM work_order_items WHERE id = $1',
      [fx.items.civilPieces],
    );
    const res = await http()
      .delete(`/projects/${fx.projectId}/work-orders/${rows[0]?.work_order_id}`)
      .set('Authorization', `Bearer ${fx.tokens.pm}`);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });
});

describe('GET /projects/:projectId/sync/bootstrap', () => {
  const bootstrap = (token: string, project = fx.projectId) =>
    http().get(`/projects/${project}/sync/bootstrap`).set('Authorization', `Bearer ${token}`);

  it('gives a supervisor the features of their zones in the project CRS, the catalog without prices, and Phase 2 capabilities as unavailable', async () => {
    const res = await bootstrap(fx.tokens.supervisorA);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bundle = OfflineBundleSchema.parse(res.body);
    expect(bundle.scope).toEqual({ kind: 'zones', zoneIds: [fx.zoneA] });
    expect(bundle.features.map((f) => f.id).sort()).toEqual([fx.boxA, fx.routeA].sort());
    const route = bundle.features.find((f) => f.id === fx.routeA);
    expect(route?.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [E0, N0],
        [E0 + 100, N0],
      ],
    });
    expect(route?.lengthM).toBe('100');
    expect(bundle.catalog).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toMatch(/price/i);
    expect(bundle.settings).toEqual({
      gpsWarningDistanceM: 50,
      suggestedQuantity: 'unavailable',
      photoRequirements: {
        status: 'unavailable',
        byWorkType: {},
        fallback: [{ key: 'general', minCount: 1 }],
      },
    });
  });

  it('gives project-wide roles every feature and refuses other projects', async () => {
    const bundle = OfflineBundleSchema.parse((await bootstrap(fx.tokens.pm)).body);
    expect(bundle.features).toHaveLength(3);
    expect((await bootstrap(fx.tokens.supervisorA, fx.otherProjectId)).status).toBe(403);
    expect((await bootstrap(fx.tokens.contractor)).status).toBe(403);
  });

  it('reports the recorded quantity of each item from non-rejected updates', async () => {
    const bundle = OfflineBundleSchema.parse((await bootstrap(fx.tokens.supervisorA)).body);
    const item = bundle.catalog.find((i) => i.id === fx.items.civilMetres);
    const { rows } = await ctx.pool.query<{ s: string }>(
      `SELECT COALESCE(sum(quantity), 0)::text AS s FROM execution_update_lines WHERE work_order_item_id = $1`,
      [fx.items.civilMetres],
    );
    expect(Number(item?.recordedQuantity)).toBe(Number(rows[0]?.s));
  });
});

describe('GET /projects/:projectId/sync/changes', () => {
  const changes = (token: string, cursor = '0', limit = 500) =>
    http()
      .get(`/projects/${fx.projectId}/sync/changes`)
      .query({ cursor, limit })
      .set('Authorization', `Bearer ${token}`);

  it('pages with a server cursor and only shows updates in the caller zones', async () => {
    const b = await pushOne(fx.tokens.supervisorB, op({ featureId: fx.boxB }));
    const all = SyncChangesResponseSchema.parse((await changes(fx.tokens.pm)).body);
    const forA = SyncChangesResponseSchema.parse((await changes(fx.tokens.supervisorA)).body);
    const forB = SyncChangesResponseSchema.parse((await changes(fx.tokens.supervisorB)).body);
    expect(forA.updates.every((u) => u.featureId !== fx.boxB)).toBe(true);
    expect(forB.updates.every((u) => u.featureId === fx.boxB)).toBe(true);
    expect(forB.updates.map((u) => u.id)).toContain(b.outcome === 'applied' ? b.updateId : '');
    expect(all.updates.length).toBe(forA.updates.length + forB.updates.length);

    // Two-by-two paging returns every update once, in server order.
    const seen: string[] = [];
    let cursor = '0';
    for (;;) {
      const page = SyncChangesResponseSchema.parse((await changes(fx.tokens.pm, cursor, 2)).body);
      seen.push(...page.updates.map((u) => u.id));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(all.updates.map((u) => u.id));
    const last = SyncChangesResponseSchema.parse((await changes(fx.tokens.pm, cursor)).body);
    expect(last.updates).toEqual([]);
    expect(last.cursor).toBe(cursor);
  });

  it('rejects a malformed cursor', async () => {
    expect((await changes(fx.tokens.pm, 'abc')).status).toBe(400);
  });
});

describe('newer revisions', () => {
  it('flags updates made on an outdated revision and on a removed feature', async () => {
    // Rev 2 keeps the route and box B and drops box A.
    const rev2 = await publishRevision(
      ctx.pool,
      fx.projectId,
      [
        {
          id: fx.routeA,
          type: 'route',
          wkt: `LINESTRING(${E0} ${N0}, ${E0 + 100} ${N0})`,
          isNew: false,
        },
        { id: fx.boxB, type: 'box', wkt: `POINT(${E0 + 1000} ${N0 + 1000})`, isNew: false },
      ],
      2,
    );
    const onOld = await pushOne(
      fx.tokens.supervisorA,
      op({
        workType: 'installation',
        lines: [{ workOrderItemId: fx.items.installation, quantity: '0.5', role: 'material' }],
      }),
    );
    if (onOld.outcome !== 'applied') throw new Error('not applied');
    expect(await flagsOf(onOld.updateId)).toEqual(['REVISION_OUTDATED', 'FEATURE_REMOVED']);
    const onNew = await pushOne(
      fx.tokens.supervisorA,
      op({
        featureId: fx.routeA,
        revisionId: rev2,
        gps: null,
        workType: 'installation',
        lines: [{ workOrderItemId: fx.items.installation, quantity: '0.5', role: 'material' }],
      }),
    );
    if (onNew.outcome !== 'applied') throw new Error('not applied');
    expect(await flagsOf(onNew.updateId)).toEqual(['GPS_MISSING']);
  });
});

describe('resumable photo upload', () => {
  const statusUrl = (photoId: string, project = fx.projectId) =>
    `/projects/${project}/sync/photos/${photoId}`;
  const putChunk = (token: string, photoId: string, offset: number | string, body: Buffer) =>
    http()
      .put(`${statusUrl(photoId)}/content`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/octet-stream')
      .set('Upload-Offset', String(offset))
      .send(body);

  async function recordWithPhoto(photo: Buffer, declared = photo) {
    const photoId = randomUUID();
    const operation = op({ photoId, photo: declared });
    expect((await pushOne(fx.tokens.supervisorA, operation)).outcome).toBe('applied');
    return photoId;
  }

  it('resumes after an interruption, checks the offset and stores the verified JPEG once', async () => {
    const photo = jpeg(5000, 7);
    const photoId = await recordWithPhoto(photo);
    const token = fx.tokens.supervisorA;

    expect((await putChunk(token, photoId, 0, photo.subarray(0, 2000))).body).toMatchObject({
      receivedBytes: 2000,
      state: 'receiving',
    });
    // The device lost the response and resends from 0: 409 tells it where to resume.
    const conflict = await putChunk(token, photoId, 0, photo.subarray(0, 2000));
    expect(conflict.status).toBe(409);
    expect(conflict.body.details).toMatchObject({ receivedBytes: 2000 });
    const status = await http().get(statusUrl(photoId)).set('Authorization', `Bearer ${token}`);
    expect(PhotoUploadStatusSchema.parse(status.body).receivedBytes).toBe(2000);

    const done = await putChunk(token, photoId, 2000, photo.subarray(2000));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ receivedBytes: 5000, state: 'stored' });
    // Resending the last chunk after a lost response is answered the same way.
    expect((await putChunk(token, photoId, 2000, photo.subarray(2000))).body.state).toBe('stored');

    const { rows } = await ctx.pool.query<{ storage_key: string }>(
      'SELECT storage_key FROM execution_photos WHERE id = $1',
      [photoId],
    );
    const stored = await readFile(join(ctx.storageRoot, rows[0]?.storage_key ?? ''));
    expect(sha(stored)).toBe(sha(photo));
    const chunks = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM execution_photo_chunks WHERE photo_id = $1',
      [photoId],
    );
    expect(chunks.rows[0]).toEqual({ n: 0 });
    const events = await ctx.pool.query(`SELECT type FROM events WHERE entity_id = $1`, [photoId]);
    expect(events.rows).toEqual([{ type: 'execution_photo.stored' }]);
  });

  it('discards bytes that do not match the sha256 and lets the device start again', async () => {
    const photo = jpeg(3000, 3);
    const photoId = await recordWithPhoto(photo);
    const corrupted = Buffer.from(photo);
    corrupted[100] = 0;
    const bad = await putChunk(fx.tokens.supervisorA, photoId, 0, corrupted);
    expect(bad.status).toBe(422);
    expect(bad.body.details).toMatchObject({ receivedBytes: 0 });
    const good = await putChunk(fx.tokens.supervisorA, photoId, 0, photo);
    expect(good.body.state).toBe('stored');
  });

  it('refuses bytes that are not a JPEG even when the declared sha256 matches', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500, 1)]);
    const photoId = await recordWithPhoto(png);
    expect((await putChunk(fx.tokens.supervisorA, photoId, 0, png)).status).toBe(422);
  });

  it('answers 404 to anyone but the uploader, even admins, and in other projects', async () => {
    const photo = jpeg();
    const photoId = await recordWithPhoto(photo);
    for (const token of [fx.tokens.supervisorA2, fx.tokens.supervisorB, fx.tokens.admin]) {
      expect((await putChunk(token, photoId, 0, photo)).status).toBe(404);
      expect(
        (await http().get(statusUrl(photoId)).set('Authorization', `Bearer ${token}`)).status,
      ).toBe(404);
    }
    const other = await http()
      .get(statusUrl(photoId, fx.otherProjectId))
      .set('Authorization', `Bearer ${fx.tokens.admin}`);
    expect(other.status).toBe(404);
    expect((await putChunk(fx.tokens.qc, photoId, 0, photo)).status).toBe(403);
  });

  it('validates content type, offset header, chunk size and declared size', async () => {
    const photo = jpeg(2000);
    const photoId = await recordWithPhoto(photo);
    const token = fx.tokens.supervisorA;
    const wrongType = await http()
      .put(`${statusUrl(photoId)}/content`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'image/jpeg')
      .set('Upload-Offset', '0')
      .send(photo);
    expect(wrongType.status).toBe(415);
    expect((await putChunk(token, photoId, '-1', photo)).status).toBe(400);
    expect((await putChunk(token, photoId, 0, Buffer.alloc(1024 * 1024 + 1))).status).toBe(413);
    expect((await putChunk(token, photoId, 0, Buffer.concat([photo, photo]))).status).toBe(413);
    expect((await putChunk(token, randomUUID(), 0, photo)).status).toBe(404);
  });
});
