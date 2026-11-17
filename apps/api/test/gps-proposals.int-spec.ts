import { createHash, randomUUID } from 'node:crypto';
import {
  GpsProposalListResponseSchema,
  GpsProposalSchema,
  PlacementDrawingSchema,
  PlacementSchema,
  SyncPushResponseSchema,
  type GpsProposal,
  type OpResult,
} from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createExecutionFixture,
  E0,
  N0,
  toWgs84,
  type ExecutionFixture,
} from './support/execution-fixtures.js';
import { eventTypes } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

let ctx: TestContext;
let fx: ExecutionFixture;
/** WGS 84 of the point (E0 + 50, N0 + 5): where the "supervisor stands". */
let here: [number, number];

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  fx = await createExecutionFixture(ctx);
  here = await toWgs84(ctx.pool, E0 + 50, N0 + 5);
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

const http = () => request(ctx.app.getHttpServer());
const as = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
const DEVICE = randomUUID();

// ---------- data helpers (the CAD worker's side is simulated with SQL) ----------

async function insertCadFile(status: 'processed' | 'uploaded' = 'processed'): Promise<string> {
  const id = randomUUID();
  await ctx.pool.query(
    `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                            status, current_job_id, processed_at)
     VALUES ($1, $2, 'plan.dxf', 'dxf', 100, repeat('a', 64), $3, $4, $5, $6)`,
    [
      id,
      fx.projectId,
      `projects/${fx.projectId}/cad/${id}/original.dxf`,
      status,
      status === 'uploaded' ? null : randomUUID(),
      status === 'uploaded' ? null : new Date(),
    ],
  );
  return id;
}

async function insertMapping(
  fileId: string,
  rules: object[],
  unit: { name: string; mpu: string } = { name: 'm', mpu: '1' },
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO cad_mappings (cad_file_id, project_id, rules, crs_epsg, drawing_unit, metres_per_unit)
     VALUES ($1, $2, $3::jsonb, 32636, $4, $5)`,
    [fileId, fx.projectId, JSON.stringify(rules), unit.name, unit.mpu],
  );
}

const pointWkt = (x: number, y: number) => `POINT Z (${x} ${y} 0)`;

async function insertInsert(
  fileId: string,
  handle: string,
  layer: string,
  block: string,
  at: [number, number],
  centre?: [number, number],
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO cad_inserts (project_id, cad_file_id, handle, layer, block_name, position, centre)
     VALUES ($1, $2, $3, $4, $5, ST_GeomFromText($6, 0),
             CASE WHEN $7::text IS NULL THEN NULL ELSE ST_GeomFromText($7::text, 0) END)`,
    [
      fx.projectId,
      fileId,
      handle,
      layer,
      block,
      pointWkt(...at),
      centre ? pointWkt(...centre) : null,
    ],
  );
}

async function insertText(
  fileId: string,
  handle: string,
  layer: string,
  text: string,
  at: [number, number],
  readable = true,
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO cad_texts (project_id, cad_file_id, handle, kind, layer, position, height, raw_text, text, readable)
     VALUES ($1, $2, $3, 'text', $4, ST_GeomFromText($5, 0), 1, $6, $6, $7)`,
    [fx.projectId, fileId, handle, layer, pointWkt(...at), text, readable],
  );
}

async function insertCurve(
  fileId: string,
  handle: string,
  layer: string,
  wkt: string,
  closed: boolean,
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO cad_curves (project_id, cad_file_id, handle, entity_type, layer, geom, is_closed)
     VALUES ($1, $2, $3, 'LWPOLYLINE', $4, ST_GeomFromText($5, 0), $6)`,
    [fx.projectId, fileId, handle, layer, wkt, closed],
  );
}

const square = (x0: number, y0: number, x1: number, y1: number) =>
  `LINESTRING Z (${x0} ${y0} 0, ${x1} ${y0} 0, ${x1} ${y1} 0, ${x0} ${y1} 0, ${x0} ${y0} 0)`;

// ---------- placement items from the uploaded file (ADR-037) ----------

describe('placement items from the uploaded file (ADR-037)', () => {
  const drawingOf = async (fileId: string, token = fx.tokens.pm) => {
    const res = await as(token)(
      http().get(`/projects/${fx.projectId}/cad-files/${fileId}/mapping/placement-drawing`),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return PlacementDrawingSchema.parse(res.body);
  };

  it('classifies inserts, texts, shape groups and routes like the build', async () => {
    const fileId = await insertCadFile();
    await insertMapping(fileId, [
      { source: 'layer', layer: 'CAB', target: 'cabinet', role: 'main' },
      { source: 'layer', layer: 'HH', target: 'hhi' },
      { source: 'layer', layer: 'BX', target: 'box' },
      { source: 'layer', layer: 'RT', target: 'route' },
      { source: 'block', block: 'MH_BLK', target: 'mh' },
      { source: 'block', block: 'IGN', target: 'ignore' },
      { source: 'block', block: 'BG', target: 'background' },
      { source: 'text', layer: 'LBL', text: 'Joint-1', target: 'joint' },
    ]);
    // Inserts: the layer rule, a block rule that wins over it, ignore / background blocks, a
    // layer without a rule, and a drawn centre that differs from the insertion point.
    await insertInsert(fileId, 'I1', 'HH', 'OTHER', [10, 10]);
    await insertInsert(fileId, 'I2', 'HH', 'MH_BLK', [20, 20], [21, 22]);
    await insertInsert(fileId, 'I3', 'HH', 'IGN', [30, 30]);
    await insertInsert(fileId, 'I4', 'BX', 'BG', [40, 40]);
    await insertInsert(fileId, 'I5', 'BX', 'MH_BLK', [7, 7]);
    await insertInsert(fileId, 'I6', 'NORULE', 'X', [8, 8]);
    await insertInsert(fileId, 'I7', 'BX', 'Y', [5, 5]);
    // Texts: a text rule matches trimmed and case-insensitively on its layer only.
    await insertText(fileId, 'T1', 'LBL', ' Joint-1 ', [50, 50]);
    await insertText(fileId, 'T2', 'LBL', 'JOINT-1', [60, 60]);
    await insertText(fileId, 'T3', 'LBL', 'Joint-1', [70, 70], false);
    await insertText(fileId, 'T4', 'ELSEWHERE', 'Joint-1', [80, 80]);
    await insertText(fileId, 'T5', 'LBL', 'other', [90, 90]);
    // Closed shapes on a cabinet layer: C10 and C11 touch C9 (C11 within 0.05 m of C10), one
    // group keyed by the smallest handle as text ('C10' < 'C11' < 'C9'), centred on the joint
    // extents (0..6, 0..2). C20 and C21 lie 0.06 m apart: separate. C30 is open: no shape.
    await insertCurve(fileId, 'C9', 'CAB', square(0, 0, 2, 2), true);
    await insertCurve(fileId, 'C10', 'CAB', square(2, 0, 4, 2), true);
    await insertCurve(fileId, 'C11', 'CAB', square(4.04, 0, 6, 2), true);
    await insertCurve(fileId, 'C20', 'CAB', square(100, 0, 102, 2), true);
    await insertCurve(fileId, 'C21', 'CAB', square(102.06, 0, 104, 2), true);
    await insertCurve(fileId, 'C30', 'CAB', 'LINESTRING Z (200 0 0, 202 0 0, 202 2 0)', false);
    await insertCurve(fileId, 'C40', 'NORULE', square(300, 0, 302, 2), true);
    // Routes: every curve on a route layer, except a zero-length one.
    const straight = Array.from({ length: 10 }, (_, i) => `${i * 10} 0 0`).join(', ');
    await insertCurve(fileId, 'R1', 'RT', `LINESTRING Z (${straight})`, false);
    await insertCurve(fileId, 'R2', 'RT', 'LINESTRING Z (5 5 0, 5 5 0)', false);
    await insertCurve(fileId, 'R3', 'RT', square(10, 10, 12, 12), true);

    const drawing = await drawingOf(fileId);
    expect(drawing.mappingVersion).toBe(1);
    const byHandle = Object.fromEntries(
      drawing.items.map((item) => [
        item.handle,
        [item.featureType, item.code, item.layer, item.x, item.y],
      ]),
    );
    expect(byHandle).toEqual({
      I1: ['hhi', null, 'HH', 10, 10],
      I2: ['mh', null, 'HH', 21, 22],
      I5: ['mh', null, 'BX', 7, 7],
      I7: ['box', null, 'BX', 5, 5],
      T1: ['joint', 'Joint-1', 'LBL', 50, 50],
      T2: ['joint', 'JOINT-1', 'LBL', 60, 60],
      C10: ['cabinet', null, 'CAB', 3, 1],
      C20: ['cabinet', null, 'CAB', 101, 1],
      C21: ['cabinet', null, 'CAB', 103.03, 1],
    });
    expect(drawing.items).toHaveLength(9);
    // Ordered by type, then code (nulls last), then handle.
    expect(drawing.items.map((item) => item.featureType)).toEqual([
      'box',
      'cabinet',
      'cabinet',
      'cabinet',
      'hhi',
      'joint',
      'joint',
      'mh',
      'mh',
    ]);
    expect(drawing.items.filter((i) => i.featureType === 'cabinet').map((i) => i.handle)).toEqual([
      'C10',
      'C20',
      'C21',
    ]);
    expect(drawing.lines).toHaveLength(2);
    expect(drawing.lines[0]).toEqual([
      [0, 0],
      [90, 0],
    ]);
    expect(drawing.lines[1]?.[0]).toEqual([10, 10]);
    expect(drawing.truncated).toBe(false);
  });

  it('applies the touch tolerance in metres, whatever the drawing unit', async () => {
    // 0.1 ft = 0.03048 m: within 0.05 m, so the two squares are one symbol in a feet drawing.
    const fileId = await insertCadFile();
    await insertMapping(
      fileId,
      [{ source: 'layer', layer: 'CAB', target: 'cabinet', role: 'main' }],
      {
        name: 'ft',
        mpu: '0.3048',
      },
    );
    await insertCurve(fileId, 'F1', 'CAB', square(0, 0, 2, 2), true);
    await insertCurve(fileId, 'F2', 'CAB', square(2.1, 0, 4, 2), true);
    const drawing = await drawingOf(fileId);
    expect(drawing.items.map((i) => [i.handle, i.x, i.y])).toEqual([['F1', 2, 1]]);
  });

  it('has no items without a saved mapping, and none while the file is not processed', async () => {
    const bare = await insertCadFile();
    await insertInsert(bare, 'Z1', 'HH', 'OTHER', [1, 1]);
    expect(await drawingOf(bare)).toEqual({
      mappingVersion: null,
      items: [],
      lines: [],
      truncated: false,
    });

    const pending = await insertCadFile('uploaded');
    await insertMapping(pending, [{ source: 'layer', layer: 'HH', target: 'hhi' }]);
    await insertInsert(pending, 'Z2', 'HH', 'OTHER', [1, 1]);
    expect(await drawingOf(pending)).toEqual({
      mappingVersion: 1,
      items: [],
      lines: [],
      truncated: false,
    });
  });
});

// ---------- a published drawing to send points for ----------

interface Published {
  fileId: string;
  revisionId: string;
  box: string;
  cabinet: string;
  mh: string;
  route: string;
  ring: string;
}

async function publishDrawing(): Promise<Published> {
  const fileId = await insertCadFile();
  await insertMapping(fileId, [{ source: 'layer', layer: 'sub', target: 'box' }]);
  await insertInsert(fileId, 'B1', 'sub', 'sub', [500, 600], [100, 200]);
  await insertCurve(fileId, 'S1', 'CAB', square(0, 0, 2, 2), true);
  await insertCurve(fileId, 'S2', 'CAB', square(2, 0, 4, 2), true);
  await insertText(fileId, 'T1', 'TXT', 'MH-7', [30, 40]);
  await insertCurve(fileId, 'A1', 'N_DUC_CBL', 'LINESTRING Z (0 0 0, 10 0 0)', false);
  await insertInsert(fileId, 'R1', 'RNG', 'ring', [9, 9]);

  const revisionId = randomUUID();
  await ctx.pool.query(
    `INSERT INTO design_revisions (id, project_id, cad_file_id, status, current_job_id, rules,
                                   mapping_version, crs_epsg, drawing_unit, metres_per_unit)
     VALUES ($1, $2, $3, 'building', $4, '[]', 1, 32636, 'm', 1)`,
    [revisionId, fx.projectId, fileId, randomUUID()],
  );
  const feature = async (
    type: string,
    wkt: string,
    layer: string,
    kind: string,
    handle: string,
    code: string | null,
    attrs: object = {},
  ): Promise<string> => {
    const id = randomUUID();
    await ctx.pool.query(
      `INSERT INTO features (id, project_id, feature_type, first_revision_id) VALUES ($1, $2, $3, $4)`,
      [id, fx.projectId, type, revisionId],
    );
    await ctx.pool.query(
      `INSERT INTO design_features (revision_id, feature_id, project_id, feature_type, code, layer,
                                    source_kind, source_handle, geom, attrs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ST_GeomFromText($9, 32636), $10)`,
      [revisionId, id, fx.projectId, type, code, layer, kind, handle, wkt, JSON.stringify(attrs)],
    );
    return id;
  };
  const box = await feature('box', `POINT(${E0 + 50} ${N0 + 5})`, 'sub', 'insert', 'B1', '1-1');
  const cabinet = await feature(
    'cabinet',
    `POINT(${E0 + 60} ${N0 + 5})`,
    'CAB',
    'curve',
    'S1',
    null,
    { shapes: ['S1', 'S2'] },
  );
  const mh = await feature('mh', `POINT(${E0 + 70} ${N0 + 5})`, 'TXT', 'text', 'T1', 'MH-7');
  const route = await feature(
    'route',
    `LINESTRING(${E0} ${N0}, ${E0 + 10} ${N0})`,
    'N_DUC_CBL',
    'curve',
    'A1',
    null,
  );
  const ring = await feature('ring', `POINT(${E0 + 80} ${N0 + 5})`, 'RNG', 'insert', 'R1', null);
  await ctx.pool.query(
    `UPDATE design_revisions SET status = 'draft', built_at = now() WHERE id = $1`,
    [revisionId],
  );
  await ctx.pool.query(
    `UPDATE design_revisions
     SET status = 'published', rev_no = (SELECT coalesce(max(rev_no), 0) + 1 FROM design_revisions WHERE project_id = $2),
         published_at = now() - interval '1 second'
     WHERE id = $1`,
    [revisionId, fx.projectId],
  );
  return { fileId, revisionId, box, cabinet, mh, route, ring };
}

// ---------- sync op ----------

const jpeg = (size = 3000, seed = 1): Buffer => {
  const bytes = Buffer.alloc(size, seed);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
};
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface ProposeOptions {
  clientOpId?: string;
  revisionId: string;
  featureId: string;
  fix?: Partial<{ lat: number; lon: number; accuracyM: number }>;
  photo?: { id: string; bytes: Buffer } | null;
  note?: string | null;
}

function propose(o: ProposeOptions) {
  const now = new Date().toISOString();
  return {
    kind: 'placement_point.propose',
    clientOpId: o.clientOpId ?? randomUUID(),
    capturedAt: now,
    payload: {
      designRevisionId: o.revisionId,
      featureId: o.featureId,
      fix: { lat: here[1], lon: here[0], accuracyM: 3.5, at: now, ...o.fix },
      photo: o.photo
        ? {
            photoId: o.photo.id,
            requirementKey: 'general',
            sha256: sha(o.photo.bytes),
            sizeBytes: o.photo.bytes.length,
            contentType: 'image/jpeg',
            takenAt: now,
            gps: null,
          }
        : null,
      note: o.note ?? null,
    },
  };
}

const pushRaw = (token: string, ops: unknown[], project = fx.projectId) =>
  http()
    .post(`/projects/${project}/sync/push`)
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId: DEVICE, ops });

async function pushOne(token: string, operation: unknown): Promise<OpResult> {
  const res = await pushRaw(token, [operation]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const [result] = SyncPushResponseSchema.parse(res.body).results;
  if (!result) throw new Error('no result');
  return result;
}

async function proposeApplied(token: string, options: ProposeOptions): Promise<string> {
  const result = await pushOne(token, propose(options));
  if (result.outcome !== 'applied') throw new Error(`not applied: ${JSON.stringify(result)}`);
  return result.updateId;
}

describe('sync op placement_point.propose', () => {
  let pub: Published;
  beforeAll(async () => {
    pub = await publishDrawing();
  });

  it('records the proposal, answers a resend as duplicate and appends the event', async () => {
    const operation = propose({ revisionId: pub.revisionId, featureId: pub.box, note: 'ok' });
    const first = await pushOne(fx.tokens.supervisorA, operation);
    expect(first.outcome).toBe('applied');
    if (first.outcome !== 'applied') return;
    expect(await pushOne(fx.tokens.supervisorA, operation)).toEqual({
      clientOpId: operation.clientOpId,
      outcome: 'duplicate',
      updateId: first.updateId,
    });

    const { rows } = await ctx.pool.query(
      `SELECT project_id, design_revision_id, feature_id, cad_file_id, handle, feature_type, code,
              ST_X(fix) AS lon, ST_Y(fix) AS lat, accuracy_m, status, note, proposed_by
       FROM gps_point_proposals WHERE client_op_id = $1`,
      [operation.clientOpId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: fx.projectId,
      design_revision_id: pub.revisionId,
      feature_id: pub.box,
      cad_file_id: pub.fileId,
      handle: 'B1',
      feature_type: 'box',
      code: '1-1',
      accuracy_m: 3.5,
      status: 'pending',
      note: 'ok',
      proposed_by: fx.userIds.supervisorA,
    });
    expect(rows[0].lon).toBeCloseTo(here[0], 9);
    expect(rows[0].lat).toBeCloseTo(here[1], 9);
    expect(await eventTypes(ctx.pool, first.updateId)).toEqual(['gps_proposal.received']);
    const count = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM gps_point_proposals WHERE client_op_id = $1`,
      [operation.clientOpId],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('accepts any supervisor of the project for an item in any zone (no zone check)', async () => {
    // Supervisor B is assigned to zone B only; the box is inside zone A.
    const result = await pushOne(
      fx.tokens.supervisorB,
      propose({ revisionId: pub.revisionId, featureId: pub.box }),
    );
    expect(result.outcome).toBe('applied');
  });

  it('refuses a reused op id with another payload, and does not store it', async () => {
    const operation = propose({ revisionId: pub.revisionId, featureId: pub.cabinet });
    expect((await pushOne(fx.tokens.supervisorA, operation)).outcome).toBe('applied');
    const changed = propose({
      clientOpId: operation.clientOpId,
      revisionId: pub.revisionId,
      featureId: pub.cabinet,
      note: 'different',
    });
    expect(await pushOne(fx.tokens.supervisorA, changed)).toEqual({
      clientOpId: operation.clientOpId,
      outcome: 'rejected',
      code: 'OP_ID_REUSED',
    });
  });

  it('rejects an unknown feature, an unpublished revision, a route and a ring', async () => {
    const codeOf = async (options: ProposeOptions) => {
      const result = await pushOne(fx.tokens.supervisorA, propose(options));
      return result.outcome === 'rejected' ? result.code : result.outcome;
    };
    expect(await codeOf({ revisionId: pub.revisionId, featureId: randomUUID() })).toBe(
      'FEATURE_NOT_FOUND',
    );
    expect(await codeOf({ revisionId: randomUUID(), featureId: pub.box })).toBe(
      'REVISION_NOT_PUBLISHED',
    );
    expect(await codeOf({ revisionId: pub.revisionId, featureId: pub.route })).toBe(
      'FEATURE_TYPE_NOT_ALLOWED',
    );
    expect(await codeOf({ revisionId: pub.revisionId, featureId: pub.ring })).toBe(
      'FEATURE_TYPE_NOT_ALLOWED',
    );
  });

  it('refuses a fix worse than 5 m at the contract (400) and a user without execution:write (403)', async () => {
    const bad = propose({
      revisionId: pub.revisionId,
      featureId: pub.box,
      fix: { accuracyM: 5.1 },
    });
    expect((await pushRaw(fx.tokens.supervisorA, [bad])).status).toBe(400);
    const ok = propose({ revisionId: pub.revisionId, featureId: pub.box });
    expect((await pushRaw(fx.tokens.qc, [ok])).status).toBe(403);
    expect((await pushRaw(fx.tokens.contractor, [ok])).status).toBe(403);
    expect((await pushRaw('x', [ok])).status).toBe(401);
  });

  it('keeps a proposal of another project out of reach', async () => {
    const result = await pushRaw(
      fx.tokens.supervisorA,
      [propose({ revisionId: pub.revisionId, featureId: pub.box })],
      fx.otherProjectId,
    );
    // Supervisor A has no assignment in the other project.
    expect(result.status).toBe(403);
  });

  it('registers an optional photo, refuses a reused photo id and stores the uploaded bytes', async () => {
    const bytes = jpeg(2000, 4);
    const photoId = randomUUID();
    const id = await proposeApplied(fx.tokens.supervisorA, {
      revisionId: pub.revisionId,
      featureId: pub.mh,
      photo: { id: photoId, bytes },
    });
    const row = await ctx.pool.query(
      `SELECT update_id, proposal_id, stored_at FROM execution_photos WHERE id = $1`,
      [photoId],
    );
    expect(row.rows).toEqual([{ update_id: null, proposal_id: id, stored_at: null }]);

    const reused = await pushOne(
      fx.tokens.supervisorA,
      propose({
        revisionId: pub.revisionId,
        featureId: pub.mh,
        photo: { id: photoId, bytes },
      }),
    );
    expect(reused).toMatchObject({ outcome: 'rejected', code: 'PHOTO_ID_REUSED' });

    // Only the sender may upload it (same rule as update photos).
    const upload = (token: string) =>
      http()
        .put(`/projects/${fx.projectId}/sync/photos/${photoId}/content`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/octet-stream')
        .set('Upload-Offset', '0')
        .send(bytes);
    expect((await upload(fx.tokens.supervisorA2)).status).toBe(404);

    // Before the bytes arrive the PM sees the photo as not stored, and cannot fetch it.
    const photoUrl = `/projects/${fx.projectId}/gps-proposals/${id}/photo`;
    expect((await as(fx.tokens.pm)(http().get(photoUrl))).status).toBe(404);
    const before = await as(fx.tokens.pm)(http().get(`/projects/${fx.projectId}/gps-proposals`));
    const listed = GpsProposalListResponseSchema.parse(before.body).items.find((p) => p.id === id);
    expect(listed?.photo).toEqual({ id: photoId, stored: false });

    const done = await upload(fx.tokens.supervisorA);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.state).toBe('stored');
    const shown = await as(fx.tokens.pm)(
      http()
        .get(photoUrl)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        }),
    );
    expect(shown.status).toBe(200);
    expect(shown.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.from(shown.body as Buffer).equals(bytes)).toBe(true);
    const after = await as(fx.tokens.pm)(http().get(`/projects/${fx.projectId}/gps-proposals`));
    expect(
      GpsProposalListResponseSchema.parse(after.body).items.find((p) => p.id === id)?.photo,
    ).toEqual({ id: photoId, stored: true });
  });
});

// ---------- the PM side ----------

describe('GPS proposals for the PM', () => {
  let pub: Published;
  const base = () => `/projects/${fx.projectId}/gps-proposals`;
  const accept = (
    id: string,
    mappingVersion: number,
    token = fx.tokens.pm,
    project = fx.projectId,
  ) =>
    as(token)(http().post(`/projects/${project}/gps-proposals/${id}/accept`)).send({
      mappingVersion,
    });
  const reject = (
    id: string,
    reason: string | undefined,
    token = fx.tokens.pm,
    project = fx.projectId,
  ) => as(token)(http().post(`/projects/${project}/gps-proposals/${id}/reject`)).send({ reason });
  const mappingOf = async () => {
    const { rows } = await ctx.pool.query(
      `SELECT version, placement, rules FROM cad_mappings WHERE cad_file_id = $1`,
      [pub.fileId],
    );
    return rows[0] as { version: number; placement: unknown; rules: object[] };
  };
  const propose1 = (featureId = pub.box, fix?: ProposeOptions['fix']) =>
    proposeApplied(fx.tokens.supervisorA, { revisionId: pub.revisionId, featureId, fix });
  const revisionCount = async () =>
    Number(
      (
        await ctx.pool.query(
          `SELECT count(*)::int AS n FROM design_revisions WHERE project_id = $1`,
          [fx.projectId],
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    pub = await publishDrawing();
  });

  it('lists proposals newest first with their filters, for PMs only', async () => {
    const first = await propose1();
    const second = await propose1(pub.cabinet);
    const res = await as(fx.tokens.pm)(http().get(`${base()}?cadFileId=${pub.fileId}`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = GpsProposalListResponseSchema.parse(res.body).items;
    expect(items.map((p) => p.id)).toEqual([second, first]);
    expect(items[1]).toMatchObject({
      designRevisionId: pub.revisionId,
      revNo: expect.any(Number),
      cadFileId: pub.fileId,
      featureId: pub.box,
      featureType: 'box',
      code: '1-1',
      handle: 'B1',
      accuracyM: 3.5,
      status: 'pending',
      decidedBy: null,
      photo: null,
      acceptedMappingVersion: null,
    });
    expect(items[1]?.proposedBy.id).toBe(fx.userIds.supervisorA);
    const none = await as(fx.tokens.pm)(
      http().get(`${base()}?status=accepted&cadFileId=${pub.fileId}`),
    );
    expect(GpsProposalListResponseSchema.parse(none.body).items).toEqual([]);
    expect((await as(fx.tokens.pm)(http().get(`${base()}?status=nope`))).status).toBe(400);
    // Other supervisors' fixes, notes and photos from every zone: not for supervisors or QC.
    for (const token of [fx.tokens.supervisorA, fx.tokens.qc, fx.tokens.contractor]) {
      expect((await as(token)(http().get(base()))).status).toBe(403);
      expect((await as(token)(http().get(`${base()}/${first}/photo`))).status).toBe(403);
    }
    expect((await http().get(base())).status).toBe(401);
  });

  it('keeps proposals of another project out of every endpoint (no IDOR)', async () => {
    const id = await propose1();
    const other = `/projects/${fx.otherProjectId}/gps-proposals`;
    expect((await as(fx.tokens.admin)(http().get(`${other}/${id}/photo`))).status).toBe(404);
    expect((await accept(id, 1, fx.tokens.admin, fx.otherProjectId)).status).toBe(404);
    expect((await reject(id, 'no', fx.tokens.admin, fx.otherProjectId)).status).toBe(404);
    const listed = await as(fx.tokens.admin)(http().get(other));
    expect(GpsProposalListResponseSchema.parse(listed.body).items).toEqual([]);
    // Still pending in its own project.
    const own = await as(fx.tokens.pm)(http().get(`${base()}?status=pending`));
    expect(GpsProposalListResponseSchema.parse(own.body).items.some((p) => p.id === id)).toBe(true);
  });

  it('is limited to cad_files:write for deciding', async () => {
    const id = await propose1();
    for (const token of [fx.tokens.supervisorA, fx.tokens.qc, fx.tokens.contractor]) {
      expect((await accept(id, 1, token)).status).toBe(403);
      expect((await reject(id, 'no', token)).status).toBe(403);
    }
    expect((await accept(id, 0)).status).toBe(400);
    expect((await reject(id, '   ')).status).toBe(400);
    expect((await reject(id, undefined)).status).toBe(400);
  });

  it('refuses to accept without a saved mapping (NO_MAPPING)', async () => {
    await ctx.pool.query(`DELETE FROM cad_mappings WHERE cad_file_id = $1`, [pub.fileId]);
    const id = await propose1();
    expect((await accept(id, 1)).body).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'NO_MAPPING' },
    });
  });

  it('accepts into the mapping: a gps control point at the drawn centre, a new version, no build', async () => {
    await ctx.pool.query(
      `INSERT INTO cad_mappings (cad_file_id, project_id, rules, crs_epsg, drawing_unit, metres_per_unit)
       VALUES ($1, $2, '[{"source":"layer","layer":"sub","target":"box"}]', 32636, 'm', 1)`,
      [pub.fileId, fx.projectId],
    );
    const builds = await revisionCount();
    const id = await propose1(pub.box);
    const res = await accept(id, 1);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const decided: GpsProposal = GpsProposalSchema.parse(res.body);
    expect(decided).toMatchObject({
      id,
      status: 'accepted',
      acceptedMappingVersion: 2,
      rejectReason: null,
    });
    expect(decided.decidedBy?.name).toBeTruthy();
    expect(decided.decidedAt).toBeTruthy();

    const mapping = await mappingOf();
    expect(mapping.version).toBe(2);
    const placement = PlacementSchema.parse(mapping.placement);
    expect(placement).toMatchObject({ sourceCrs: 'project', fitScaleWithTwoPoints: false });
    expect(placement.points).toEqual([
      {
        id,
        // The insert's drawn centre (100, 200), not its insertion point (500, 600).
        drawing: { x: 100, y: 200 },
        handle: 'B1',
        label: '1-1',
        lat: expect.closeTo(here[1], 9),
        lon: expect.closeTo(here[0], 9),
        source: 'gps',
        excluded: false,
      },
    ]);
    expect(await revisionCount()).toBe(builds);
    expect(await eventTypes(ctx.pool, pub.fileId)).toContain('cad_mapping.saved');
    expect(await eventTypes(ctx.pool, id)).toEqual([
      'gps_proposal.received',
      'gps_proposal.accepted',
    ]);
  });

  it('keeps only the last accepted gps point of an item; typed and other points stay', async () => {
    // Add a typed point and a gps point on other handles to the saved placement.
    const current = await mappingOf();
    const placement = current.placement as { points: object[] };
    const typed = {
      id: 'typed-1',
      drawing: { x: 1, y: 2 },
      handle: 'B1',
      label: 'typed',
      lat: 30.1,
      lon: 31.2,
      source: 'typed',
      excluded: false,
    };
    const otherGps = { ...typed, id: 'gps-zz', handle: 'ZZ', source: 'gps', label: null };
    await ctx.pool.query(`UPDATE cad_mappings SET placement = $2::jsonb WHERE cad_file_id = $1`, [
      pub.fileId,
      JSON.stringify({ ...placement, points: [...placement.points, typed, otherGps] }),
    ]);

    const id = await propose1(pub.box, { lat: here[1] + 0.00001 });
    const res = await accept(id, 2);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(GpsProposalSchema.parse(res.body).acceptedMappingVersion).toBe(3);
    const points = PlacementSchema.parse((await mappingOf()).placement).points;
    expect(points.map((p) => [p.id, p.source, p.handle])).toEqual([
      ['typed-1', 'typed', 'B1'],
      ['gps-zz', 'gps', 'ZZ'],
      [id, 'gps', 'B1'],
    ]);
  });

  it('answers VERSION_MISMATCH for a stale version and changes nothing', async () => {
    const id = await propose1(pub.cabinet);
    const res = await accept(id, 1);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'VERSION_MISMATCH', currentVersion: 3 },
    });
    expect((await mappingOf()).version).toBe(3);
    const row = await ctx.pool.query(`SELECT status FROM gps_point_proposals WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe('pending');

    // A shape group's drawn centre is the middle of the joint extents (S1 + S2: 2, 1).
    const ok = await accept(id, 3);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const point = PlacementSchema.parse((await mappingOf()).placement).points.find(
      (p) => p.id === id,
    );
    expect(point).toMatchObject({ drawing: { x: 2, y: 1 }, handle: 'S1', label: 'S1' });
  });

  it('takes a text item at the text position, with its code as the label', async () => {
    const id = await propose1(pub.mh);
    const res = await accept(id, 4);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const point = PlacementSchema.parse((await mappingOf()).placement).points.find(
      (p) => p.id === id,
    );
    expect(point).toMatchObject({ drawing: { x: 30, y: 40 }, handle: 'T1', label: 'MH-7' });
  });

  it('decides a proposal only once', async () => {
    const accepted = await propose1();
    expect((await accept(accepted, 5)).status).toBe(200);
    const again = await accept(accepted, 6);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ details: { reason: 'ALREADY_DECIDED' } });
    expect((await reject(accepted, 'late')).body).toMatchObject({
      details: { reason: 'ALREADY_DECIDED' },
    });

    const rejected = await propose1();
    const res = await reject(rejected, '  wrong place ');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(GpsProposalSchema.parse(res.body)).toMatchObject({
      id: rejected,
      status: 'rejected',
      rejectReason: 'wrong place',
      acceptedMappingVersion: null,
    });
    expect((await accept(rejected, 6)).body).toMatchObject({
      details: { reason: 'ALREADY_DECIDED' },
    });
    expect((await reject(rejected, 'again')).status).toBe(409);
    expect(await eventTypes(ctx.pool, rejected)).toEqual([
      'gps_proposal.received',
      'gps_proposal.rejected',
    ]);
    // The mapping did not move for the refused and rejected decisions.
    expect((await mappingOf()).version).toBe(6);
  });

  it('refuses more control points than the contract allows (TOO_MANY_POINTS)', async () => {
    const current = await mappingOf();
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `t${i}`,
      drawing: { x: i, y: i },
      handle: null,
      label: null,
      lat: 30,
      lon: 31,
      source: 'typed',
      excluded: false,
    }));
    await ctx.pool.query(`UPDATE cad_mappings SET placement = $2::jsonb WHERE cad_file_id = $1`, [
      pub.fileId,
      JSON.stringify({ sourceCrs: 'project', points: many }),
    ]);
    const id = await propose1(pub.box);
    const res = await accept(id, current.version);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ details: { reason: 'TOO_MANY_POINTS' } });
    expect((await mappingOf()).version).toBe(current.version);
    const row = await ctx.pool.query(`SELECT status FROM gps_point_proposals WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe('pending');
  });
});

// ---------- database rules (migration 0014) ----------

describe('database rules (migration 0014)', () => {
  let pub: Published;
  beforeAll(async () => {
    pub = await publishDrawing();
  });

  const newProposal = async (): Promise<string> =>
    proposeApplied(fx.tokens.supervisorA, { revisionId: pub.revisionId, featureId: pub.box });

  it('lets a proposal change once, pending to a decision, and nothing else', async () => {
    const id = await newProposal();
    await expect(
      ctx.pool.query(`UPDATE gps_point_proposals SET handle = 'X' WHERE id = $1`, [id]),
    ).rejects.toThrow(/only the decision fields/);
    await expect(
      ctx.pool.query(
        `UPDATE gps_point_proposals SET fix = ST_SetSRID(ST_MakePoint(31, 30), 4326) WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/only the decision fields/);
    await expect(
      ctx.pool.query(`UPDATE gps_point_proposals SET status = 'pending' WHERE id = $1`, [id]),
    ).rejects.toThrow(/only be accepted or rejected/);
    // Half a decision breaks the decision-complete rule.
    await expect(
      ctx.pool.query(`UPDATE gps_point_proposals SET status = 'rejected' WHERE id = $1`, [id]),
    ).rejects.toThrow(/decision_complete/);

    await ctx.pool.query(
      `UPDATE gps_point_proposals
       SET status = 'rejected', decided_by = proposed_by, decided_at = now(), reject_reason = 'no'
       WHERE id = $1`,
      [id],
    );
    await expect(
      ctx.pool.query(`UPDATE gps_point_proposals SET note = 'x' WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      ctx.pool.query(
        `UPDATE gps_point_proposals
         SET status = 'accepted', reject_reason = NULL, accepted_mapping_version = 2 WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('refuses DELETE and TRUNCATE', async () => {
    const id = await newProposal();
    await expect(
      ctx.pool.query(`DELETE FROM gps_point_proposals WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
    // Referenced by `execution_photos`, so only CASCADE gets as far as the triggers.
    await expect(ctx.pool.query(`TRUNCATE gps_point_proposals CASCADE`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('limits the accuracy to 0..5 m and the status to its three values', async () => {
    const op = randomUUID();
    await ctx.pool.query(
      `INSERT INTO sync_operations (client_op_id, project_id, user_id, device_id, kind, payload_sha256, result)
       VALUES ($1, $2, $3, $4, 'placement_point.propose', repeat('a', 64), '{}')`,
      [op, fx.projectId, fx.userIds.supervisorA, DEVICE],
    );
    const insert = (accuracy: number, status = 'pending') =>
      ctx.pool.query(
        `INSERT INTO gps_point_proposals
           (id, project_id, client_op_id, design_revision_id, feature_id, cad_file_id, handle,
            feature_type, fix, accuracy_m, fix_at, proposed_by, device_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'B1', 'box', ST_SetSRID(ST_MakePoint(31, 30), 4326), $7,
                 now(), $8, $9, $10)`,
        [
          randomUUID(),
          fx.projectId,
          op,
          pub.revisionId,
          pub.box,
          pub.fileId,
          accuracy,
          fx.userIds.supervisorA,
          DEVICE,
          status,
        ],
      );
    await expect(insert(5.01)).rejects.toThrow(/accuracy_m/);
    await expect(insert(-1)).rejects.toThrow(/accuracy_m/);
    await expect(insert(1, 'maybe')).rejects.toThrow(/violates check constraint/);
    await insert(5);
  });

  it('makes a photo belong to exactly one of an update or a proposal', async () => {
    const id = await newProposal();
    const photo = (updateId: string | null, proposalId: string | null) =>
      ctx.pool.query(
        `INSERT INTO execution_photos (id, project_id, update_id, proposal_id, requirement_key,
                                       sha256, size_bytes, content_type, taken_at)
         VALUES ($1, $2, $3, $4, 'general', repeat('b', 64), 10, 'image/jpeg', now())`,
        [randomUUID(), fx.projectId, updateId, proposalId],
      );
    await expect(photo(null, null)).rejects.toThrow(/owner_one/);
    const update = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM execution_updates WHERE project_id = $1 LIMIT 1`,
      [fx.projectId],
    );
    if (update.rows[0]) {
      await expect(photo(update.rows[0].id, id)).rejects.toThrow(/owner_one/);
    }
    // A proposal of another project cannot own a photo (composite key).
    await expect(
      ctx.pool.query(
        `INSERT INTO execution_photos (id, project_id, proposal_id, requirement_key, sha256,
                                       size_bytes, content_type, taken_at)
         VALUES ($1, $2, $3, 'general', repeat('b', 64), 10, 'image/jpeg', now())`,
        [randomUUID(), fx.otherProjectId, id],
      ),
    ).rejects.toThrow(/proposal_fkey/);
    await photo(null, id);
  });
});
