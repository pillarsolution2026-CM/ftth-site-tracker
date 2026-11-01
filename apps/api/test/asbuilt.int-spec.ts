import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AsBuiltEditDetailSchema,
  AsBuiltEditListResponseSchema,
  AsBuiltEditSchema,
  AsBuiltExportListResponseSchema,
  AsBuiltExportSchema,
  AsBuiltLengthsResponseSchema,
  AsBuiltStateResponseSchema,
  CAD_QUEUE_KEYS,
  CadExportAsBuiltJobSchema,
  OfflineBundleSchema,
  SyncChangesResponseSchema,
  SyncPushResponseSchema,
  type OpResult,
} from '@ftth/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PushSyncUseCase } from '../src/modules/execution/application/push-sync.use-case.js';
import { Phase2UnavailableCapabilities } from '../src/modules/execution/application/phase2-capabilities.js';
import { DrizzleExecutionUnitOfWork } from '../src/modules/execution/infrastructure/drizzle-execution.repository.js';
import { ASBUILT_LENGTHS_PORT } from '../src/modules/asbuilt/asbuilt.tokens.js';
import type { AsBuiltLengthsPort } from '../src/modules/asbuilt/application/ports.js';
import { schema } from '../src/db/schema.js';
import { createApprovedContract, createProjectIn } from './support/contract-fixtures.js';
import {
  createExecutionFixture,
  E0,
  N0,
  publishRevision,
  type ExecutionFixture,
} from './support/execution-fixtures.js';
import { eventTypes, ensureMember, loginAs, SEED_LOGINS } from './support/helpers.js';
import { startRedis, type TestRedis } from './support/redis.js';
import { createTestContext, type TestContext } from './support/test-app.js';

let ctx: TestContext;
let testRedis: TestRedis;
let redis: Redis;

beforeAll(async () => {
  testRedis = await startRedis();
  redis = new Redis(testRedis.url);
  ctx = await createTestContext(inject('databaseUrl'), { REDIS_URL: testRedis.url });
}, 180_000);

afterAll(async () => {
  redis?.disconnect();
  await ctx?.close();
  await testRedis?.stop();
});

const http = () => request(ctx.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const DEVICE = randomUUID();

type Pt = [number, number];
const line = (...coordinates: Pt[]) => ({ type: 'LineString', coordinates });
const point = (e: number, n: number) => ({ type: 'Point', coordinates: [e, n] });

/** Builds one `asbuilt_edit.record` op on `revisionId` (default: the fixture's first revision). */
function edit(
  f: ExecutionFixture,
  fields: Record<string, unknown>,
  o: { clientOpId?: string; capturedAt?: string; revisionId?: string } = {},
): { kind: string; clientOpId: string; capturedAt: string; payload: Record<string, unknown> } {
  return {
    kind: 'asbuilt_edit.record',
    clientOpId: o.clientOpId ?? randomUUID(),
    capturedAt: o.capturedAt ?? new Date().toISOString(),
    payload: {
      designRevisionId: o.revisionId ?? f.revisionId,
      note: null,
      gps: null,
      ...fields,
    },
  };
}

const reshape = (f: ExecutionFixture, geometry: unknown, base = 0, o = {}) =>
  edit(f, { kind: 'reshape', featureId: f.routeA, baseVersion: base, geometry }, o);
const move = (f: ExecutionFixture, featureId: string, e: number, n: number, base = 0, o = {}) =>
  edit(f, { kind: 'move', featureId, baseVersion: base, geometry: point(e, n) }, o);
const label = (f: ExecutionFixture, featureId: string, text: string, base = 0, o = {}) =>
  edit(f, { kind: 'label', featureId, baseVersion: base, label: text }, o);
const addSymbol = (f: ExecutionFixture, e: number, n: number, text: string | null = null, o = {}) =>
  edit(
    f,
    {
      kind: 'add_symbol',
      featureId: randomUUID(),
      featureType: 'hhi',
      geometry: point(e, n),
      label: text,
    },
    o,
  );
const addRoute = (f: ExecutionFixture, geometry: unknown, featureId = randomUUID(), o = {}) =>
  edit(f, { kind: 'add_route', featureId, geometry, label: null }, o);

async function push(f: ExecutionFixture, token: string, ops: unknown[], deviceId = DEVICE) {
  return http().post(`/projects/${f.projectId}/sync/push`).set(auth(token)).send({ deviceId, ops });
}

async function pushOne(
  f: ExecutionFixture,
  token: string,
  operation: unknown,
  deviceId = DEVICE,
): Promise<OpResult> {
  const res = await push(f, token, [operation], deviceId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const [result] = SyncPushResponseSchema.parse(res.body).results;
  if (!result) throw new Error('no result');
  return result;
}

/** Pushes and returns the new edit id (fails the test when the op was not applied). */
async function record(f: ExecutionFixture, token: string, operation: unknown): Promise<string> {
  const result = await pushOne(f, token, operation);
  if (result.outcome !== 'applied') throw new Error(`not applied: ${JSON.stringify(result)}`);
  return result.updateId;
}

const rejectedWith = (result: OpResult) => (result.outcome === 'rejected' ? result.code : null);

const editsUrl = (f: ExecutionFixture, suffix = '') =>
  `/projects/${f.projectId}/asbuilt/edits${suffix}`;
const approve = (f: ExecutionFixture, token: string, id: string) =>
  http()
    .post(editsUrl(f, `/${id}/approve`))
    .set(auth(token))
    .send({});
const reject = (f: ExecutionFixture, token: string, id: string, body: object = { reason: 'no' }) =>
  http()
    .post(editsUrl(f, `/${id}/reject`))
    .set(auth(token))
    .send(body);

async function getChanges(f: ExecutionFixture, token: string, cursor = '0', limit = 200) {
  const res = await http()
    .get(`/projects/${f.projectId}/sync/changes?cursor=${cursor}&limit=${limit}`)
    .set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return SyncChangesResponseSchema.parse(res.body);
}

async function listEdits(f: ExecutionFixture, token: string, query = '') {
  const res = await http().get(editsUrl(f, query)).set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return AsBuiltEditListResponseSchema.parse(res.body);
}

async function getLengths(f: ExecutionFixture, token: string) {
  const res = await http().get(`/projects/${f.projectId}/asbuilt/lengths`).set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return AsBuiltLengthsResponseSchema.parse(res.body);
}

/** ST_Length (3 dp) of a project-CRS line, computed independently by PostGIS. */
async function pgLength(...points: Pt[]): Promise<string> {
  const wkt = `LINESTRING(${points.map(([e, n]) => `${e} ${n}`).join(', ')})`;
  const { rows } = await ctx.pool.query<{ len: string }>(
    `SELECT round(ST_Length(ST_GeomFromText($1, 32636))::numeric, 3)::text AS len`,
    [wkt],
  );
  // The API sends the shortest exact decimal ("100.000" -> "100").
  return String(Number(rows[0]?.len));
}

async function editRow(id: string) {
  const { rows } = await ctx.pool.query<{
    kind: string;
    status: string;
    feature_type: string;
    base_version: number | null;
    srid: number | null;
    wkt: string | null;
    length_m: string | null;
    label: string | null;
    flags: string[];
    approved_version: number | null;
  }>(
    `SELECT kind, status, feature_type, base_version, ST_SRID(geom) AS srid, ST_AsText(geom) AS wkt,
            length_m::text AS length_m, label, flags, approved_version
     FROM asbuilt_edits WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function countEdits(f: ExecutionFixture): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM asbuilt_edits WHERE project_id = $1',
    [f.projectId],
  );
  return Number(rows[0]?.n);
}

// ---------------------------------------------------------------------------------------------

describe('recording As-Built edits through sync push', () => {
  let f: ExecutionFixture;
  beforeAll(async () => {
    f = await createExecutionFixture(ctx);
  }, 180_000);

  it('applies every tool kind and stores project-CRS geometry with its SRID, length and event', async () => {
    const t = f.tokens.supervisorA;
    const moveId = await record(f, t, move(f, f.boxA, E0 + 52, N0 + 5));
    expect(await editRow(moveId)).toMatchObject({
      kind: 'move',
      status: 'pending',
      feature_type: 'box',
      base_version: 0,
      srid: 32636,
      wkt: `POINT(${E0 + 52} ${N0 + 5})`,
      length_m: null,
      flags: [],
      approved_version: null,
    });
    expect(await eventTypes(ctx.pool, moveId)).toEqual(['asbuilt_edit.recorded']);

    const pts: Pt[] = [
      [E0, N0],
      [E0 + 50, N0 + 10],
      [E0 + 100, N0],
    ];
    const reshapeId = await record(f, t, reshape(f, line(...pts)));
    const row = await editRow(reshapeId);
    expect(row).toMatchObject({ kind: 'reshape', feature_type: 'route', srid: 32636 });
    expect(String(Number(row?.length_m))).toBe(await pgLength(...pts));

    const symbolId = await record(f, t, addSymbol(f, E0 + 20, N0 + 3, 'HHI-NEW'));
    expect(await editRow(symbolId)).toMatchObject({
      kind: 'add_symbol',
      feature_type: 'hhi',
      base_version: null,
      label: 'HHI-NEW',
      srid: 32636,
    });

    const routeId = await record(f, t, addRoute(f, line([E0 + 10, N0 + 20], [E0 + 40, N0 + 20])));
    expect(await editRow(routeId)).toMatchObject({
      kind: 'add_route',
      feature_type: 'route',
      base_version: null,
      length_m: '30.000',
    });

    const labelId = await record(f, t, label(f, f.boxA, 'Box 1-1 AB'));
    expect(await editRow(labelId)).toMatchObject({
      kind: 'label',
      label: 'Box 1-1 AB',
      wkt: null,
      base_version: 0,
    });
  });

  it('answers a resend as duplicate with the first edit id, also when sent concurrently', async () => {
    const operation = move(f, f.boxA, E0 + 53, N0 + 5);
    const first = await pushOne(f, f.tokens.supervisorA, operation);
    expect(first.outcome).toBe('applied');
    const again = await pushOne(f, f.tokens.supervisorA, operation);
    expect(again).toEqual({
      clientOpId: operation.clientOpId,
      outcome: 'duplicate',
      updateId: first.outcome === 'applied' ? first.updateId : '',
    });

    const before = await countEdits(f);
    const racing = move(f, f.boxA, E0 + 54, N0 + 5);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => pushOne(f, f.tokens.supervisorA, racing)),
    );
    expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(5);
    expect(await countEdits(f)).toBe(before + 1);
    const { rows } = await ctx.pool.query(
      'SELECT 1 FROM events WHERE type = $1 AND payload->>$2 = $3',
      ['asbuilt_edit.recorded', 'clientOpId', racing.clientOpId],
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a reused operation id: other payload, other user, other device', async () => {
    const operation = move(f, f.boxA, E0 + 55, N0 + 5);
    await pushOne(f, f.tokens.supervisorA, operation);
    const otherPayload = { ...operation, payload: { ...operation.payload, note: 'changed' } };
    expect(rejectedWith(await pushOne(f, f.tokens.supervisorA, otherPayload))).toBe('OP_ID_REUSED');
    expect(rejectedWith(await pushOne(f, f.tokens.supervisorA2, operation))).toBe('OP_ID_REUSED');
    expect(rejectedWith(await pushOne(f, f.tokens.supervisorA, operation, randomUUID()))).toBe(
      'OP_ID_REUSED',
    );
  });

  it('answers the contract rejection codes and stores nothing for a rejection', async () => {
    const t = f.tokens.supervisorA;
    const before = await countEdits(f);
    const code = async (operation: unknown, token = t) =>
      rejectedWith(await pushOne(f, token, operation));

    expect(await code(move(f, f.boxA, E0, N0, 0, { revisionId: randomUUID() }))).toBe(
      'REVISION_NOT_PUBLISHED',
    );
    // Revision of another project.
    const foreign = await publishRevision(ctx.pool, f.otherProjectId, [], 1);
    expect(await code(move(f, f.boxA, E0, N0, 0, { revisionId: foreign }))).toBe(
      'REVISION_NOT_PUBLISHED',
    );
    expect(await code(label(f, randomUUID(), 'x'))).toBe('FEATURE_NOT_FOUND');
    expect(await code(addSymbol(f, E0, N0))).toBeNull(); // sanity: a valid add applies
    expect(
      await code(
        edit(f, {
          kind: 'add_symbol',
          featureId: f.boxA,
          featureType: 'box',
          geometry: point(E0 + 1, N0 + 1),
          label: null,
        }),
      ),
    ).toBe('FEATURE_ID_REUSED');
    const reused = randomUUID();
    await record(f, t, addRoute(f, line([E0 + 5, N0 + 30], [E0 + 25, N0 + 30]), reused));
    expect(await code(addRoute(f, line([E0 + 6, N0 + 31], [E0 + 26, N0 + 31]), reused))).toBe(
      'FEATURE_ID_REUSED',
    );
    expect(await code(move(f, f.routeA, E0, N0))).toBe('GEOMETRY_KIND_MISMATCH');
    expect(
      await code(
        edit(f, {
          kind: 'reshape',
          featureId: f.boxA,
          baseVersion: 0,
          geometry: line([E0, N0], [E0 + 5, N0]),
        }),
      ),
    ).toBe('GEOMETRY_KIND_MISMATCH');
    // Added but not yet approved: not a target (FEATURE_NOT_FOUND).
    expect(await code(label(f, reused, 'pending add'))).toBe('FEATURE_NOT_FOUND');
    expect(await countEdits(f)).toBe(before + 2);
  });

  it('refuses a geometry PostGIS finds invalid (bypassing the schema, real PostGIS)', async () => {
    const useCase = new PushSyncUseCase(
      new DrizzleExecutionUnitOfWork(drizzle(ctx.pool, { schema }), 5000),
      new Phase2UnavailableCapabilities(),
      { now: () => new Date() },
      { next: () => randomUUID() },
    );
    const bad = {
      ...reshape(f, line([E0, N0], [E0, N0])),
    } as unknown as Parameters<PushSyncUseCase['execute']>[0]['ops'][number];
    const [result] = await useCase.execute({
      projectId: f.projectId,
      userId: f.userIds.supervisorA,
      deviceId: DEVICE,
      scope: { kind: 'project' },
      asBuiltScope: { kind: 'project' },
      ops: [bad],
    });
    expect(result && rejectedWith(result)).toBe('GEOMETRY_INVALID');

    // The shared schema already refuses repeated vertices at the door.
    const res = await push(f, f.tokens.supervisorA, [reshape(f, line([E0, N0], [E0, N0]))]);
    expect(res.status).toBe(400);
  });

  it('keeps a supervisor inside the zones: other zone, moving out, adding out', async () => {
    const before = await countEdits(f);
    const code = async (operation: unknown, token: string) =>
      rejectedWith(await pushOne(f, token, operation));
    // Supervisor B cannot touch zone A features.
    expect(await code(reshape(f, line([E0, N0], [E0 + 90, N0 + 5])), f.tokens.supervisorB)).toBe(
      'FEATURE_OUT_OF_SCOPE',
    );
    expect(await code(label(f, f.boxA, 'x'), f.tokens.supervisorB)).toBe('FEATURE_OUT_OF_SCOPE');
    // Supervisor A cannot touch zone B or move a feature from A into B.
    expect(await code(move(f, f.boxB, E0 + 1001, N0 + 1000), f.tokens.supervisorA)).toBe(
      'FEATURE_OUT_OF_SCOPE',
    );
    expect(await code(move(f, f.boxA, E0 + 1000, N0 + 1000), f.tokens.supervisorA)).toBe(
      'FEATURE_OUT_OF_SCOPE',
    );
    expect(
      await code(
        reshape(f, line([E0 + 900, N0 + 950], [E0 + 1000, N0 + 950])),
        f.tokens.supervisorA,
      ),
    ).toBe('FEATURE_OUT_OF_SCOPE');
    expect(await code(addSymbol(f, E0 + 1000, N0 + 1000), f.tokens.supervisorA)).toBe(
      'FEATURE_OUT_OF_SCOPE',
    );
    expect(await countEdits(f)).toBe(before);
    // Inside its own zone supervisor B can still work.
    expect(
      (await pushOne(f, f.tokens.supervisorB, move(f, f.boxB, E0 + 1002, N0 + 1000))).outcome,
    ).toBe('applied');
  });

  it('takes the write scope only from assignments that grant asbuilt:write (H1 rule)', async () => {
    // A QC member of the project who is also a supervisor of zone B: QC is project-wide but cannot write.
    const email = `qc-sup-${randomUUID().slice(0, 8)}@ftth.local`;
    await ensureMember(ctx.pool, {
      email,
      password: 'Qc#Sup12345',
      role: 'qc',
      projectId: f.projectId,
    });
    await ensureMember(ctx.pool, {
      email,
      password: 'Qc#Sup12345',
      role: 'supervisor',
      projectId: f.projectId,
      zoneId: f.zoneB,
    });
    const token = await loginAs(ctx, email, 'Qc#Sup12345');
    expect(
      rejectedWith(await pushOne(f, token, reshape(f, line([E0, N0], [E0 + 90, N0 + 5])))),
    ).toBe('FEATURE_OUT_OF_SCOPE');
    expect((await pushOne(f, token, label(f, f.boxB, 'ok'))).outcome).toBe('applied');
  });

  it('lets pm and admin write project-wide; refuses qc and contractor at the route', async () => {
    expect((await pushOne(f, f.tokens.pm, label(f, f.boxB, 'pm label'))).outcome).toBe('applied');
    expect((await pushOne(f, f.tokens.admin, label(f, f.boxA, 'admin label'))).outcome).toBe(
      'applied',
    );
    for (const token of [f.tokens.qc, f.tokens.contractor]) {
      const res = await push(f, token, [label(f, f.boxA, 'nope')]);
      expect(res.status).toBe(403);
    }
  });

  it('validates the batch envelope as a whole: a malformed As-Built op is a 400', async () => {
    const status = (
      await push(f, f.tokens.supervisorA, [
        label(f, f.boxA, 'in batch'),
        { kind: 'asbuilt_edit.record', clientOpId: 'not-a-uuid' },
      ])
    ).status;
    expect(status).toBe(400);
  });
});

describe('flags', () => {
  let f: ExecutionFixture;
  let rev2: string;
  beforeAll(async () => {
    f = await createExecutionFixture(ctx);
    // Rev 2 keeps the route and box B and drops box A.
    rev2 = await publishRevision(
      ctx.pool,
      f.projectId,
      [
        {
          id: f.routeA,
          type: 'route',
          wkt: `LINESTRING(${E0} ${N0}, ${E0 + 100} ${N0})`,
          isNew: false,
        },
        { id: f.boxB, type: 'box', wkt: `POINT(${E0 + 1000} ${N0 + 1000})`, isNew: false },
      ],
      2,
    );
  }, 180_000);

  it('flags REVISION_OUTDATED and FEATURE_REMOVED, never rejecting; names a feature missing from the revision', async () => {
    const id = await record(f, f.tokens.supervisorA, move(f, f.boxA, E0 + 51, N0 + 5));
    expect((await editRow(id))?.flags).toEqual(['REVISION_OUTDATED', 'FEATURE_REMOVED']);
    const add = await record(f, f.tokens.supervisorA, addSymbol(f, E0 + 70, N0 + 20));
    expect((await editRow(add))?.flags).toEqual(['REVISION_OUTDATED']);
    // Box A is not in revision 2: naming revision 2 is refused.
    expect(
      rejectedWith(
        await pushOne(
          f,
          f.tokens.supervisorA,
          move(f, f.boxA, E0 + 51, N0 + 5, 0, { revisionId: rev2 }),
        ),
      ),
    ).toBe('REVISION_NOT_PUBLISHED');
    const current = await record(
      f,
      f.tokens.supervisorA,
      reshape(f, line([E0, N0], [E0 + 100, N0 + 1]), 0, { revisionId: rev2 }),
    );
    expect((await editRow(current))?.flags).toEqual([]);
  });

  it('flags CLOCK_AHEAD only beyond the tolerance', async () => {
    const ahead = new Date(Date.now() + 10 * 60_000).toISOString();
    const id = await record(
      f,
      f.tokens.supervisorA,
      label(f, f.routeA, 'future', 0, { capturedAt: ahead, revisionId: rev2 }),
    );
    expect((await editRow(id))?.flags).toEqual(['CLOCK_AHEAD']);
    const small = new Date(Date.now() + 60_000).toISOString();
    const ok = await record(
      f,
      f.tokens.supervisorA,
      label(f, f.routeA, 'near', 0, { capturedAt: small, revisionId: rev2 }),
    );
    expect((await editRow(ok))?.flags).toEqual([]);
  });

  it('flags BASE_OUTDATED when the approved version moved on after the edit was drawn', async () => {
    const first = await record(
      f,
      f.tokens.supervisorA,
      reshape(f, line([E0, N0], [E0 + 50, N0 + 5], [E0 + 100, N0]), 0, { revisionId: rev2 }),
    );
    expect((await approve(f, f.tokens.qc, first)).status).toBe(200);
    const stale = await record(
      f,
      f.tokens.supervisorA,
      reshape(f, line([E0, N0], [E0 + 50, N0 + 9], [E0 + 100, N0]), 0, { revisionId: rev2 }),
    );
    expect((await editRow(stale))?.flags).toEqual(['BASE_OUTDATED']);
    const fresh = await record(
      f,
      f.tokens.supervisorA,
      reshape(f, line([E0, N0], [E0 + 50, N0 + 9], [E0 + 100, N0]), 1, { revisionId: rev2 }),
    );
    expect((await editRow(fresh))?.flags).toEqual([]);
    // A label edit is versioned separately: the shape approval does not stale it.
    const labelEdit = await record(
      f,
      f.tokens.supervisorA,
      label(f, f.routeA, 'cable 7', 0, { revisionId: rev2 }),
    );
    expect((await editRow(labelEdit))?.flags).toEqual([]);
  });
});

describe('review (web)', () => {
  let f: ExecutionFixture;
  let otherQc: string;
  beforeAll(async () => {
    f = await createExecutionFixture(ctx);
    const email = `other-qc-${randomUUID().slice(0, 8)}@ftth.local`;
    await ensureMember(ctx.pool, {
      email,
      password: 'Other#Qc1234',
      role: 'qc',
      projectId: f.otherProjectId,
    });
    otherQc = await loginAs(ctx, email, 'Other#Qc1234');
  }, 180_000);

  it('lets qc approve, and supervisor cannot (403); approval writes the projection and an event', async () => {
    const id = await record(f, f.tokens.supervisorA, move(f, f.boxA, E0 + 60, N0 + 4));
    expect((await approve(f, f.tokens.supervisorA, id)).status).toBe(403);
    expect((await approve(f, f.tokens.contractor, id)).status).toBe(403);
    expect((await editRow(id))?.status).toBe('pending');

    const res = await approve(f, f.tokens.qc, id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const approved = AsBuiltEditSchema.parse(res.body);
    expect(approved).toMatchObject({ status: 'approved', approvedVersion: 1 });
    expect(approved.reviewedBy).not.toBeNull();
    const { rows } = await ctx.pool.query<{
      wkt: string;
      geometry_version: number;
      added: boolean;
    }>(
      `SELECT ST_AsText(geom) AS wkt, geometry_version, added FROM asbuilt_features
       WHERE project_id = $1 AND feature_id = $2`,
      [f.projectId, f.boxA],
    );
    expect(rows[0]).toEqual({
      wkt: `POINT(${E0 + 60} ${N0 + 4})`,
      geometry_version: 1,
      added: false,
    });
    expect(await eventTypes(ctx.pool, id)).toEqual([
      'asbuilt_edit.recorded',
      'asbuilt_edit.approved',
    ]);
  });

  it('keeps a review final: not pending -> 409 NOT_PENDING; the database refuses edits of a reviewed row', async () => {
    const id = await record(f, f.tokens.supervisorA, label(f, f.boxA, 'final'));
    expect((await approve(f, f.tokens.qc, id)).status).toBe(200);
    for (const attempt of [() => approve(f, f.tokens.qc, id), () => reject(f, f.tokens.qc, id)]) {
      const res = await attempt();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      expect(res.body.details).toMatchObject({ reason: 'NOT_PENDING' });
    }
    await expect(
      ctx.pool.query(
        `UPDATE asbuilt_edits SET status = 'rejected', review_reason = 'x' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/final/);
  });

  it('serialises concurrent reviews of one edit: exactly one wins', async () => {
    const id = await record(f, f.tokens.supervisorA, label(f, f.boxA, 'race'));
    const statuses = await Promise.all([
      (async () => (await approve(f, f.tokens.qc, id)).status)(),
      (async () => (await approve(f, f.tokens.admin, id)).status)(),
      (async () => (await reject(f, f.tokens.pm, id)).status)(),
    ]);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);
  });

  it('forbids reviewing one’s own edit (403 SELF_REVIEW) and a project-wide user can still review others', async () => {
    const id = await record(f, f.tokens.pm, label(f, f.boxB, 'pm own'));
    for (const attempt of [() => approve(f, f.tokens.pm, id), () => reject(f, f.tokens.pm, id)]) {
      const res = await attempt();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(res.body.details).toMatchObject({ reason: 'SELF_REVIEW' });
    }
    expect((await approve(f, f.tokens.qc, id)).status).toBe(200);
    expect((await editRow(id))?.status).toBe('approved');
  });

  it('refuses approval of a stale base (409 STALE_BASE) but allows rejecting it', async () => {
    const a = await record(
      f,
      f.tokens.supervisorA,
      reshape(f, line([E0, N0], [E0 + 50, N0 + 2], [E0 + 100, N0])),
    );
    const b = await record(
      f,
      f.tokens.supervisorA2,
      reshape(f, line([E0, N0], [E0 + 50, N0 + 3], [E0 + 100, N0])),
    );
    expect((await approve(f, f.tokens.qc, a)).status).toBe(200);
    const stale = await approve(f, f.tokens.qc, b);
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({ reason: 'STALE_BASE' });
    expect((await editRow(b))?.status).toBe('pending');
    const detail = AsBuiltEditDetailSchema.parse(
      (
        await http()
          .get(editsUrl(f, `/${b}`))
          .set(auth(f.tokens.qc))
      ).body,
    );
    expect(detail.approvable).toBe(false);
    expect(detail.current?.geometryVersion).toBe(1);
    expect((await reject(f, f.tokens.qc, b, { reason: 'drawn on an old shape' })).status).toBe(200);
  });

  it('needs a reason to reject; a rejected edit is final and changes no state', async () => {
    const id = await record(f, f.tokens.supervisorA, label(f, f.boxA, 'to reject'));
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      expect((await reject(f, f.tokens.qc, id, body)).status).toBe(400);
    }
    const res = await reject(f, f.tokens.qc, id, { reason: 'wrong box' });
    expect(res.status).toBe(200);
    expect(AsBuiltEditSchema.parse(res.body)).toMatchObject({
      status: 'rejected',
      reviewReason: 'wrong box',
      approvedVersion: null,
    });
    expect((await approve(f, f.tokens.qc, id)).status).toBe(409);
    const { rows } = await ctx.pool.query(
      `SELECT 1 FROM asbuilt_features WHERE project_id = $1 AND label = 'to reject'`,
      [f.projectId],
    );
    expect(rows).toHaveLength(0);
    expect(await eventTypes(ctx.pool, id)).toEqual([
      'asbuilt_edit.recorded',
      'asbuilt_edit.rejected',
    ]);
  });

  it('approves added features (symbol with a label, route) and then accepts later edits of them', async () => {
    const symbol = addSymbol(f, E0 + 30, N0 + 30, 'HHI-9');
    const symbolId = symbol.payload.featureId as string;
    const editId = await record(f, f.tokens.supervisorA, symbol);
    // Not approved yet: a label edit has no target.
    expect(rejectedWith(await pushOne(f, f.tokens.supervisorA, label(f, symbolId, 'early')))).toBe(
      'FEATURE_NOT_FOUND',
    );
    expect((await approve(f, f.tokens.qc, editId)).status).toBe(200);
    const { rows } = await ctx.pool.query(
      `SELECT added, label, geometry_version, label_version FROM asbuilt_features WHERE feature_id = $1`,
      [symbolId],
    );
    expect(rows[0]).toEqual({ added: true, label: 'HHI-9', geometry_version: 1, label_version: 1 });
    // Moves and labels of the added feature are now possible (base = approved version).
    const moveId = await record(f, f.tokens.supervisorA, move(f, symbolId, E0 + 31, N0 + 30, 1));
    expect((await approve(f, f.tokens.qc, moveId)).status).toBe(200);
    const again = await record(f, f.tokens.supervisorA, label(f, symbolId, 'HHI-9b', 1));
    expect((await approve(f, f.tokens.qc, again)).status).toBe(200);
    const { rows: after } = await ctx.pool.query(
      `SELECT label, geometry_version, label_version FROM asbuilt_features WHERE feature_id = $1`,
      [symbolId],
    );
    expect(after[0]).toEqual({ label: 'HHI-9b', geometry_version: 2, label_version: 2 });
  });

  it('is zone and project scoped: reading, detail and reviewing are 404 outside the caller scope', async () => {
    const inA = await record(f, f.tokens.supervisorA, label(f, f.boxA, 'zone A edit'));
    const inB = await record(f, f.tokens.supervisorB, label(f, f.boxB, 'zone B edit'));

    const seenByA = (await listEdits(f, f.tokens.supervisorA)).items.map((e) => e.id);
    expect(seenByA).toContain(inA);
    expect(seenByA).not.toContain(inB);
    const seenByB = (await listEdits(f, f.tokens.supervisorB)).items.map((e) => e.id);
    expect(seenByB).toContain(inB);
    expect(seenByB).not.toContain(inA);
    const total = await listEdits(f, f.tokens.qc);
    expect(total.items.map((e) => e.id)).toEqual(expect.arrayContaining([inA, inB]));

    const detailOfB = await http()
      .get(editsUrl(f, `/${inB}`))
      .set(auth(f.tokens.supervisorA));
    expect(detailOfB.status).toBe(404);
    expect(
      (
        await http()
          .get(editsUrl(f, `/${inA}`))
          .set(auth(f.tokens.supervisorA))
      ).status,
    ).toBe(200);
    // Approval of zone B by supervisor A is a 403 (no review right) and nothing changed.
    expect((await approve(f, f.tokens.supervisorA, inB)).status).toBe(403);

    // Another project: its qc cannot see or review this project's edits (no access at all) and
    // asking for the edit through its own project path is 404.
    expect((await approve(f, otherQc, inA)).status).toBe(403);
    const crossPath = await http()
      .get(`/projects/${f.otherProjectId}/asbuilt/edits/${inA}`)
      .set(auth(otherQc));
    expect(crossPath.status).toBe(404);
    const crossApprove = await http()
      .post(`/projects/${f.otherProjectId}/asbuilt/edits/${inA}/approve`)
      .set(auth(otherQc))
      .send({});
    expect(crossApprove.status).toBe(404);
    expect((await editRow(inA))?.status).toBe('pending');
    const crossList = await http()
      .get(`/projects/${f.otherProjectId}/asbuilt/edits`)
      .set(auth(otherQc));
    expect(AsBuiltEditListResponseSchema.parse(crossList.body).total).toBe(0);
  });

  it('filters and pages the list, newest first', async () => {
    const all = await listEdits(f, f.tokens.pm, '?limit=200');
    const times = all.items.map((e) => Date.parse(e.receivedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const pending = await listEdits(f, f.tokens.pm, '?status=pending&limit=200');
    expect(pending.items.every((e) => e.status === 'pending')).toBe(true);
    const page = await listEdits(f, f.tokens.pm, '?limit=2&offset=1');
    expect(page.items).toHaveLength(2);
    expect(page.items.map((e) => e.id)).toEqual(all.items.slice(1, 3).map((e) => e.id));
    expect(page.total).toBe(all.total);
    const byFeature = await listEdits(f, f.tokens.pm, `?featureId=${f.routeA}`);
    expect(byFeature.items.every((e) => e.featureId === f.routeA)).toBe(true);
    expect((await http().get(editsUrl(f, '?limit=9999')).set(auth(f.tokens.pm))).status).toBe(400);
  });

  it('shows the comparison data in the detail', async () => {
    const id = await record(
      f,
      f.tokens.supervisorA,
      reshape(f, line([E0, N0], [E0 + 100, N0 + 4]), 1),
    );
    const detail = AsBuiltEditDetailSchema.parse(
      (
        await http()
          .get(editsUrl(f, `/${id}`))
          .set(auth(f.tokens.qc))
      ).body,
    );
    expect(detail.crsEpsg).toBe(32636);
    expect(detail.design).toMatchObject({
      revisionId: f.revisionId,
      layer: 'N_DUC_CBL',
      lengthM: '100',
    });
    expect(detail.current?.geometryVersion).toBe(1);
    expect(detail.approvable).toBe(true);
  });
});

describe('pull and bootstrap', () => {
  let f: ExecutionFixture;
  beforeAll(async () => {
    f = await createExecutionFixture(ctx);
  }, 180_000);

  it('returns As-Built edits in changes, and approval bumps the cursor so the device sees the status', async () => {
    const id = await record(f, f.tokens.supervisorA, label(f, f.boxA, 'device edit'));
    const first = await getChanges(f, f.tokens.supervisorA);
    const mine = first.asBuiltEdits.find((e) => e.id === id);
    expect(mine).toMatchObject({ status: 'pending', label: 'device edit' });
    expect(first.updates).toEqual([]);
    // Zone B's supervisor does not see it.
    expect((await getChanges(f, f.tokens.supervisorB)).asBuiltEdits.map((e) => e.id)).not.toContain(
      id,
    );

    expect((await approve(f, f.tokens.qc, id)).status).toBe(200);
    const next = await getChanges(f, f.tokens.supervisorA, first.cursor);
    expect(next.asBuiltEdits.map((e) => e.id)).toEqual([id]);
    expect(next.asBuiltEdits[0]).toMatchObject({ status: 'approved', approvedVersion: 1 });
    expect(BigInt(next.cursor)).toBeGreaterThan(BigInt(first.cursor));
    expect((await getChanges(f, f.tokens.supervisorA, next.cursor)).asBuiltEdits).toEqual([]);
    // The reviewer's decision also reaches a different cursor position of the same sequence.
    const rejectedId = await record(f, f.tokens.supervisorB, label(f, f.boxB, 'x'));
    expect(rejectedId).toBeTruthy();
  });

  it('pages updates and edits on one sequence: limit counts both, cursor is the max, hasMore is right', async () => {
    const start = (await getChanges(f, f.tokens.supervisorA)).cursor;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await record(f, f.tokens.supervisorA, label(f, f.boxA, `page ${i}`, 1)));
      const update = await pushOne(f, f.tokens.supervisorA, {
        kind: 'execution_update.record',
        clientOpId: randomUUID(),
        capturedAt: new Date().toISOString(),
        payload: {
          featureId: f.boxA,
          designRevisionId: f.revisionId,
          workType: 'civil',
          lines: [{ workOrderItemId: f.items.civilPieces, quantity: '1', role: 'work' }],
          label: null,
          note: null,
          gps: null,
          photos: [
            {
              photoId: randomUUID(),
              requirementKey: 'general',
              sha256: 'a'.repeat(64),
              sizeBytes: 100,
              contentType: 'image/jpeg',
              takenAt: new Date().toISOString(),
              gps: null,
            },
          ],
          acknowledgedWarnings: [],
        },
      });
      expect(update.outcome).toBe('applied');
    }
    const seenEdits: string[] = [];
    const seenUpdates: string[] = [];
    let cursor = start;
    let pages = 0;
    for (;;) {
      const page = await getChanges(f, f.tokens.supervisorA, cursor, 2);
      pages += 1;
      expect(page.asBuiltEdits.length + page.updates.length).toBeLessThanOrEqual(2);
      seenEdits.push(...page.asBuiltEdits.map((e) => e.id));
      seenUpdates.push(...page.updates.map((u) => u.id));
      expect(BigInt(page.cursor)).toBeGreaterThanOrEqual(BigInt(cursor));
      cursor = page.cursor;
      if (!page.hasMore) break;
      expect(pages).toBeLessThan(10);
    }
    expect(seenEdits).toEqual(ids);
    expect(seenUpdates).toHaveLength(3);
    expect(pages).toBe(3);
  });

  it('puts the approved As-Built state in the bootstrap, in scope, label-only filled from the design', async () => {
    const f2 = await createExecutionFixture(ctx);
    const pending = await record(f2, f2.tokens.supervisorA, move(f2, f2.boxA, E0 + 49, N0 + 5));
    const bootstrap = async (token: string) => {
      const res = await http().get(`/projects/${f2.projectId}/sync/bootstrap`).set(auth(token));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return OfflineBundleSchema.parse(res.body);
    };
    expect((await bootstrap(f2.tokens.supervisorA)).asBuilt).toEqual([]);

    const labelId = await record(f2, f2.tokens.supervisorA, label(f2, f2.boxA, 'only label'));
    const routePts: Pt[] = [
      [E0, N0],
      [E0 + 60, N0 + 20],
      [E0 + 100, N0],
    ];
    const reshapeId = await record(f2, f2.tokens.supervisorA, reshape(f2, line(...routePts)));
    const symbol = addSymbol(f2, E0 + 70, N0 + 70, 'S');
    const symbolEdit = await record(f2, f2.tokens.supervisorA, symbol);
    const inB = await record(f2, f2.tokens.supervisorB, label(f2, f2.boxB, 'zone B label'));
    for (const id of [labelId, reshapeId, symbolEdit, inB]) {
      expect((await approve(f2, f2.tokens.qc, id)).status).toBe(200);
    }
    expect((await editRow(pending))?.status).toBe('pending');

    const forA = (await bootstrap(f2.tokens.supervisorA)).asBuilt;
    expect(forA.map((s) => s.featureId).sort()).toEqual(
      [f2.boxA, f2.routeA, symbol.payload.featureId as string].sort(),
    );
    const labelOnly = forA.find((s) => s.featureId === f2.boxA);
    expect(labelOnly).toMatchObject({
      added: false,
      label: 'only label',
      geometryVersion: 0,
      labelVersion: 1,
      lengthM: null,
      // The design position: the pending move does not count.
      geometry: point(E0 + 50, N0 + 5),
    });
    const route = forA.find((s) => s.featureId === f2.routeA);
    expect(route).toMatchObject({ geometry: line(...routePts), geometryVersion: 1, label: null });
    expect(route?.lengthM).toBe(await pgLength(...routePts));
    expect(forA.find((s) => s.added)).toMatchObject({ label: 'S', featureType: 'hhi' });

    const forB = (await bootstrap(f2.tokens.supervisorB)).asBuilt;
    expect(forB.map((s) => s.featureId)).toEqual([f2.boxB]);
    expect((await bootstrap(f2.tokens.pm)).asBuilt).toHaveLength(4);

    // GET state is the same read model.
    const state = AsBuiltStateResponseSchema.parse(
      (await http().get(`/projects/${f2.projectId}/asbuilt/state`).set(auth(f2.tokens.qc))).body,
    );
    expect(state.crsEpsg).toBe(32636);
    expect(state.revisionId).toBe(f2.revisionId);
    expect(state.features).toHaveLength(4);
    const stateForB = AsBuiltStateResponseSchema.parse(
      (await http().get(`/projects/${f2.projectId}/asbuilt/state`).set(auth(f2.tokens.supervisorB)))
        .body,
    );
    expect(stateForB.features.map((s) => s.featureId)).toEqual([f2.boxB]);
    expect(
      (await http().get(`/projects/${f2.projectId}/asbuilt/state`).set(auth(f2.tokens.contractor)))
        .status,
    ).toBe(403);
  });
});

describe('acceptance: a reshape reaches the web and, once approved, the approved length', () => {
  let f: ExecutionFixture;
  let rev2: string;
  let route2: string;
  beforeAll(async () => {
    f = await createExecutionFixture(ctx);
    route2 = randomUUID();
    rev2 = await publishRevision(
      ctx.pool,
      f.projectId,
      [
        {
          id: f.routeA,
          type: 'route',
          wkt: `LINESTRING(${E0} ${N0}, ${E0 + 100} ${N0})`,
          isNew: false,
        },
        {
          id: route2,
          type: 'route',
          wkt: `LINESTRING(${E0} ${N0 + 20}, ${E0 + 30} ${N0 + 20})`,
          isNew: true,
        },
        { id: f.boxA, type: 'box', wkt: `POINT(${E0 + 50} ${N0 + 5})`, isNew: false },
      ],
      2,
    );
  }, 180_000);

  it('goes sync -> changes -> review list -> approval -> lengths exactly as ST_Length', async () => {
    const pts: Pt[] = [
      [E0, N0],
      [E0 + 40, N0 + 35],
      [E0 + 100, N0],
    ];
    const id = await record(
      f,
      f.tokens.supervisorA,
      reshape(f, line(...pts), 0, { revisionId: rev2 }),
    );

    expect((await getChanges(f, f.tokens.supervisorA)).asBuiltEdits.map((e) => e.id)).toContain(id);
    const listed = (await listEdits(f, f.tokens.pm)).items.find((e) => e.id === id);
    expect(listed).toMatchObject({ kind: 'reshape', status: 'pending', featureId: f.routeA });
    expect(listed?.lengthM).toBe(await pgLength(...pts));

    // Pending edits never change lengths.
    const before = await getLengths(f, f.tokens.pm);
    expect(before.revisionId).toBe(rev2);
    const byIdBefore = new Map(before.routes.map((r) => [r.featureId, r]));
    expect(byIdBefore.get(f.routeA)).toMatchObject({
      lengthM: '100',
      source: 'design',
      geometryVersion: 0,
    });
    expect(byIdBefore.get(route2)).toMatchObject({
      lengthM: '30',
      source: 'design',
      designLengthM: '30',
    });

    expect((await approve(f, f.tokens.qc, id)).status).toBe(200);

    const expected = await pgLength(...pts);
    const after = await getLengths(f, f.tokens.pm);
    const byId = new Map(after.routes.map((r) => [r.featureId, r]));
    expect(byId.get(f.routeA)).toEqual({
      featureId: f.routeA,
      code: null,
      added: false,
      designLengthM: '100',
      lengthM: expected,
      source: 'asbuilt',
      geometryVersion: 1,
    });
    // Untouched routes keep the design length.
    expect(byId.get(route2)).toMatchObject({ lengthM: '30', source: 'design', geometryVersion: 0 });
    expect(after.routes).toHaveLength(2);

    // The application port gives the same answer (what Phase 5 will read).
    const port = ctx.app.get<AsBuiltLengthsPort>(ASBUILT_LENGTHS_PORT, { strict: false });
    expect(await port.routeLengths(f.projectId)).toEqual(after);
  });

  it('counts an approved added route once; a pending add and a rejected add never count', async () => {
    const pendingAdd = await record(
      f,
      f.tokens.supervisorA,
      addRoute(f, line([E0 + 5, N0 + 40], [E0 + 25, N0 + 40]), randomUUID(), { revisionId: rev2 }),
    );
    expect(pendingAdd).toBeTruthy();
    const before = await getLengths(f, f.tokens.pm);
    expect(before.routes.filter((r) => r.added)).toHaveLength(0);

    const pts: Pt[] = [
      [E0 + 5, N0 + 50],
      [E0 + 45, N0 + 80],
    ];
    const featureId = randomUUID();
    const addId = await record(
      f,
      f.tokens.supervisorA,
      addRoute(f, line(...pts), featureId, { revisionId: rev2 }),
    );
    expect((await approve(f, f.tokens.qc, addId)).status).toBe(200);
    expect((await reject(f, f.tokens.qc, pendingAdd, { reason: 'duplicate' })).status).toBe(200);

    const after = await getLengths(f, f.tokens.pm);
    const added = after.routes.filter((r) => r.added);
    expect(added).toEqual([
      {
        featureId,
        code: null,
        added: true,
        designLengthM: null,
        lengthM: await pgLength(...pts),
        source: 'asbuilt',
        geometryVersion: 1,
      },
    ]);
  });

  it('reads lengths in the caller scope (supervisor of zone B sees no zone A route) and needs asbuilt:read', async () => {
    const forB = await getLengths(f, f.tokens.supervisorB);
    expect(forB.routes).toEqual([]);
    const forA = await getLengths(f, f.tokens.supervisorA);
    expect(forA.routes.length).toBeGreaterThanOrEqual(2);
    expect(
      (await http().get(`/projects/${f.projectId}/asbuilt/lengths`).set(auth(f.tokens.contractor)))
        .status,
    ).toBe(403);
  });
});

describe('As-Built DXF export', () => {
  let f: ExecutionFixture;
  beforeAll(async () => {
    f = await createExecutionFixture(ctx);
  }, 180_000);

  const exportsUrl = (suffix = '') => `/projects/${f.projectId}/asbuilt/exports${suffix}`;

  it('queues an export row and a validated job on the CAD queue', async () => {
    await redis.del(CAD_QUEUE_KEYS.jobs);
    const res = await http().post(exportsUrl()).set(auth(f.tokens.pm)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const created = AsBuiltExportSchema.parse(res.body);
    expect(created).toMatchObject({
      status: 'queued',
      revisionId: f.revisionId,
      stats: null,
      sizeBytes: null,
      finishedAt: null,
      error: null,
    });
    const { rows } = await ctx.pool.query<{
      current_job_id: string;
      status: string;
      requested_by: string;
    }>('SELECT current_job_id, status, requested_by FROM asbuilt_exports WHERE id = $1', [
      created.id,
    ]);
    expect(rows[0]?.status).toBe('queued');
    const raw = await redis.lrange(CAD_QUEUE_KEYS.jobs, 0, -1);
    expect(raw).toHaveLength(1);
    const job = CadExportAsBuiltJobSchema.parse(JSON.parse(raw[0] ?? '{}'));
    expect(job).toMatchObject({
      type: 'cad.export_asbuilt',
      exportId: created.id,
      projectId: f.projectId,
      attempt: 1,
      id: rows[0]?.current_job_id,
    });
    expect(await eventTypes(ctx.pool, created.id)).toEqual(['asbuilt_export.requested']);
    // The same admin path works too, and the list shows newest first.
    const second = await http().post(exportsUrl()).set(auth(f.tokens.admin)).send();
    expect(second.status).toBe(202);
    const list = AsBuiltExportListResponseSchema.parse(
      (await http().get(exportsUrl()).set(auth(f.tokens.pm))).body,
    );
    expect(list.items.map((e) => e.id)).toEqual([
      AsBuiltExportSchema.parse(second.body).id,
      created.id,
    ]);
    const one = await http()
      .get(exportsUrl(`/${created.id}`))
      .set(auth(f.tokens.pm));
    expect(AsBuiltExportSchema.parse(one.body).id).toBe(created.id);
  });

  it('answers 409 until done, then streams the stored DXF with the contract headers', async () => {
    const created = AsBuiltExportSchema.parse(
      (await http().post(exportsUrl()).set(auth(f.tokens.pm)).send({})).body,
    );
    const before = await http()
      .get(exportsUrl(`/${created.id}/file`))
      .set(auth(f.tokens.pm));
    expect(before.status).toBe(409);
    expect(before.body.code).toBe('CONFLICT');

    const bytes = Buffer.from('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n', 'utf8');
    const key = `projects/${f.projectId}/asbuilt/${created.id}.dxf`;
    await mkdir(dirname(join(ctx.storageRoot, key)), { recursive: true });
    await writeFile(join(ctx.storageRoot, key), bytes);
    await ctx.pool.query(
      `UPDATE asbuilt_exports
       SET status = 'done', storage_key = $2, size_bytes = $3, sha256 = $4, finished_at = now(),
           stats = '{"designFeatures":3,"editedFeatures":1,"addedFeatures":0}'::jsonb
       WHERE id = $1`,
      [created.id, key, bytes.length, createHash('sha256').update(bytes).digest('hex')],
    );

    const done = await http()
      .get(exportsUrl(`/${created.id}`))
      .set(auth(f.tokens.pm));
    expect(AsBuiltExportSchema.parse(done.body)).toMatchObject({
      status: 'done',
      sizeBytes: bytes.length,
      stats: { designFeatures: 3, editedFeatures: 1, addedFeatures: 0 },
    });
    const file = await http()
      .get(exportsUrl(`/${created.id}/file`))
      .set(auth(f.tokens.pm))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect(Buffer.from(file.body as Buffer).equals(bytes)).toBe(true);
    expect(file.headers['content-type']).toBe('application/dxf');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="asbuilt-r1-${created.id.slice(0, 8)}.dxf"`,
    );
    expect(file.headers['content-length']).toBe(String(bytes.length));
  });

  it('is pm/admin only: qc, supervisor and contractor get 403 on every export route', async () => {
    const created = AsBuiltExportSchema.parse(
      (await http().post(exportsUrl()).set(auth(f.tokens.pm)).send({})).body,
    );
    for (const token of [f.tokens.qc, f.tokens.supervisorA, f.tokens.contractor]) {
      expect((await http().post(exportsUrl()).set(auth(token)).send({})).status).toBe(403);
      expect((await http().get(exportsUrl()).set(auth(token))).status).toBe(403);
      expect(
        (
          await http()
            .get(exportsUrl(`/${created.id}`))
            .set(auth(token))
        ).status,
      ).toBe(403);
      expect(
        (
          await http()
            .get(exportsUrl(`/${created.id}/file`))
            .set(auth(token))
        ).status,
      ).toBe(403);
    }
    expect((await http().post(exportsUrl())).status).toBe(401);
  });

  it('does not leak exports across projects (404) and refuses without a published revision', async () => {
    const created = AsBuiltExportSchema.parse(
      (await http().post(exportsUrl()).set(auth(f.tokens.pm)).send({})).body,
    );
    const viaOther = await http()
      .get(`/projects/${f.otherProjectId}/asbuilt/exports/${created.id}`)
      .set(auth(f.tokens.admin));
    expect(viaOther.status).toBe(404);
    const fileViaOther = await http()
      .get(`/projects/${f.otherProjectId}/asbuilt/exports/${created.id}/file`)
      .set(auth(f.tokens.admin));
    expect(fileViaOther.status).toBe(404);

    // f.otherProjectId has no published revision.
    const none = await http()
      .post(`/projects/${f.otherProjectId}/asbuilt/exports`)
      .set(auth(f.tokens.admin))
      .send({});
    expect(none.status).toBe(409);
    expect(none.body.details).toMatchObject({ reason: 'NO_PUBLISHED_REVISION' });
    const bare = await createProjectIn(
      ctx.pool,
      (
        await createApprovedContract(ctx.pool, [
          { code: 'Z', unit: 'م', quantity: '1', unitPrice: '0', workType: 'civil' },
        ])
      ).contractId,
      `Bare ${randomUUID().slice(0, 6)}`,
    );
    const adminToken = await loginAs(ctx, ...SEED_LOGINS.admin);
    expect(
      (await http().post(`/projects/${bare}/asbuilt/exports`).set(auth(adminToken)).send({}))
        .status,
    ).toBe(409);
  });
});

describe('As-Built export when the queue is down', () => {
  it('marks the export failed with ENQUEUE_FAILED instead of leaving it queued forever', async () => {
    const down = await createTestContext(inject('databaseUrl'), {
      REDIS_URL: 'redis://127.0.0.1:1',
    });
    try {
      const f = await createExecutionFixture(down);
      const res = await request(down.app.getHttpServer())
        .post(`/projects/${f.projectId}/asbuilt/exports`)
        .set(auth(f.tokens.pm))
        .send({});
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      const created = AsBuiltExportSchema.parse(res.body);
      expect(created).toMatchObject({ status: 'failed', error: 'ENQUEUE_FAILED' });
      expect(created.finishedAt).not.toBeNull();
      expect(await eventTypes(down.pool, created.id)).toEqual([
        'asbuilt_export.requested',
        'asbuilt_export.failed',
      ]);
    } finally {
      await down.close();
    }
  }, 60_000);
});
