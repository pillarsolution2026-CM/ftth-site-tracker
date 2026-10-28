import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CAD_QUEUE_KEYS,
  CadBuildRevisionJobSchema,
  CadFileDetailSchema,
  CadMappingSchema,
  CadMappingViewSchema,
  DesignFeaturePageSchema,
  DesignRevisionDetailSchema,
  DesignRevisionListResponseSchema,
  DesignRevisionSummarySchema,
  DiffPageSchema,
  TextLinkPageSchema,
  TextLinkSchema,
  TileUrlResponseSchema,
  type CrsDetection,
} from '@ftth/shared';
import { Redis } from 'ioredis';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { signTile } from '../src/modules/cad/domain/tile-signature.js';
import { ensureMember, eventTypes, loginAs, projectIds, SEED_LOGINS } from './support/helpers.js';
import { startRedis, type TestRedis } from './support/redis.js';
import { createTestContext, type TestContext } from './support/test-app.js';

const TILE_SECRET = 'integration-tile-secret-integration-tile-secret';
const TILES_URL = 'https://tiles.example.test';
const DETECTION: CrsDetection = {
  kind: 'projected_utm',
  reason: 'MATCHES_PROJECT_CRS',
  suggestedEpsg: 32636,
  projectEpsg: 32636,
  impliedUnit: 'm',
  insUnits: 1,
  declaredUnit: 'in',
  unitsConflict: true,
};
/** UTM 36N, around Cairo: a real place so ST_Transform to web mercator is well defined. */
const E0 = 330000;
const N0 = 3330000;

let testRedis: TestRedis;
let redis: Redis;
let ctx: TestContext;
let noTilesCtx: TestContext;
let brokenQueueCtx: TestContext;
let projectA: string;
let projectB: string;
let admin: string;
let pm: string;
let supervisor: string;
let contractor: string;

beforeAll(async () => {
  testRedis = await startRedis();
  redis = new Redis(testRedis.url);
  const databaseUrl = inject('databaseUrl');
  ctx = await createTestContext(databaseUrl, {
    REDIS_URL: testRedis.url,
    TILE_URL_SECRET: TILE_SECRET,
    TILES_PUBLIC_URL: `${TILES_URL}/`,
  });
  noTilesCtx = await createTestContext(databaseUrl, { REDIS_URL: testRedis.url });
  // Nothing listens on port 1: the real Redis adapter must fail and the revision must report it.
  brokenQueueCtx = await createTestContext(databaseUrl, { REDIS_URL: 'redis://127.0.0.1:1' });

  // A fresh project per run: published revisions are immutable and cannot be cleaned up afterwards.
  projectB = (await projectIds(ctx.pool)).b;
  const created = await ctx.pool.query<{ id: string }>(
    `INSERT INTO projects (name, client, crs_epsg, currency, locale)
     VALUES ($1, 'WE', 32636, 'EGP', 'ar') RETURNING id`,
    [`Design revisions ${randomUUID()}`],
  );
  projectA = created.rows[0]?.id ?? '';
  const zone = await ctx.pool.query<{ id: string }>(
    `INSERT INTO zones (project_id, name) VALUES ($1, 'Sector 1') RETURNING id`,
    [projectA],
  );
  const zoneId = zone.rows[0]?.id ?? '';
  const member = (email: string, password: string, role: 'pm' | 'supervisor' | 'contractor') =>
    ensureMember(ctx.pool, { email, password, role, projectId: projectA, zoneId });
  await member('design-pm@ftth.local', 'Design#Pm123', 'pm');
  await member('design-supervisor@ftth.local', 'Design#Sup123', 'supervisor');
  await member('design-contractor@ftth.local', 'Design#Con123', 'contractor');
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
  pm = await loginAs(ctx, 'design-pm@ftth.local', 'Design#Pm123');
  supervisor = await loginAs(ctx, 'design-supervisor@ftth.local', 'Design#Sup123');
  contractor = await loginAs(ctx, 'design-contractor@ftth.local', 'Design#Con123');
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  await noTilesCtx?.close();
  await brokenQueueCtx?.close();
  redis?.disconnect();
  await testRedis?.stop();
});

const http = (context: TestContext = ctx) => request(context.app.getHttpServer());
const as = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
const filesUrl = (project: string) => `/projects/${project}/cad-files`;
const revisionsUrl = (project: string) => `/projects/${project}/design-revisions`;

// ---------- data helpers (the worker's side of the contract is simulated with SQL) ----------

async function insertCadFile(
  status: 'processed' | 'uploaded',
  project = projectA,
  name = `plan-${randomUUID().slice(0, 8)}.dxf`,
): Promise<string> {
  const id = randomUUID();
  await ctx.pool.query(
    `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                            status, current_job_id, ins_units, crs_detection, processed_at)
     VALUES ($1, $2, $3, 'dxf', 100, repeat('a', 64), $4, $5, $6, 1, $7, $8)`,
    [
      id,
      project,
      name,
      `projects/${project}/cad/${id}/original.dxf`,
      status,
      status === 'uploaded' ? null : randomUUID(),
      status === 'processed' ? JSON.stringify(DETECTION) : null,
      status === 'processed' ? new Date() : null,
    ],
  );
  return id;
}

async function insertExtraction(fileId: string): Promise<void> {
  const layer = (name: string, aci: number, counts: Record<string, number>) =>
    ctx.pool.query(
      `INSERT INTO cad_layers (project_id, cad_file_id, name, aci_color, is_on, is_frozen, is_locked,
                               entity_counts, entity_total)
       VALUES ($1, $2, $3, $4, true, false, false, $5, $6)`,
      [
        projectA,
        fileId,
        name,
        aci,
        JSON.stringify(counts),
        Object.values(counts).reduce((a, b) => a + b, 0),
      ],
    );
  await layer('N_DUC_CBL', 3, { curve: 2 });
  await layer('sub', 1, { insert: 2 });
  await layer('TXT', 7, { text: 3 });
  await layer('tx', 8, { text: 1 });
  await layer('RRR', 2, { insert: 2, text: 3 });

  const insert = (handle: string, layerName: string, block: string) =>
    ctx.pool.query(
      `INSERT INTO cad_inserts (project_id, cad_file_id, handle, layer, block_name, position)
       VALUES ($1, $2, $3, $4, $5, ST_GeomFromText('POINT Z (1 2 0)', 0))`,
      [projectA, fileId, handle, layerName, block],
    );
  await insert('I1', 'sub', 'sub');
  await insert('I2', 'sub', 'sub');
  await insert('I3', 'RRR', 'HHI');
  await insert('I4', 'sub', 'HHI');
  await insert('I5', 'RRR', 'MISC');

  const text = (handle: string, layerName: string, value: string, readable = true) =>
    ctx.pool.query(
      `INSERT INTO cad_texts (project_id, cad_file_id, handle, kind, layer, position, height, raw_text, text, readable)
       VALUES ($1, $2, $3, 'text', $4, ST_GeomFromText('POINT Z (1 2 0)', 0), 2.5, $5, $5, $6)`,
      [projectA, fileId, handle, layerName, value, readable],
    );
  await text('X1', 'RRR', 'NEW-HHI');
  await text('X2', 'RRR', 'NEW-HHI');
  await text('X3', 'RRR', 'NEW-HHI');
  await text('X4', 'TXT', '1-1');
  await text('X5', 'TXT', ' 1-1 '); // groups with X4 once trimmed
  await text('X6', 'TXT', 'F 36 C');
  await text('X7', 'tx', 'garbled', false); // unreadable: never offered for rules
}

const point = (x: number, y: number) => `ST_SetSRID(ST_MakePoint(${x}, ${y}), 32636)`;

interface SimulatedBuild {
  route: string;
  boxA: string;
  boxB: string;
  hhi: string;
  linkBoxA: string;
  linkLength: string;
  linkUnreadable: string;
  linkBoxB: string;
  linkOther: string;
}

/** What the worker leaves behind: features, text links, a diff, counts; then `draft`. */
async function simulateBuild(revisionId: string, withData = true): Promise<SimulatedBuild> {
  const q = (text: string, values: unknown[] = []) => ctx.pool.query(text, values);
  const ids: SimulatedBuild = {
    route: randomUUID(),
    boxA: randomUUID(),
    boxB: randomUUID(),
    hhi: randomUUID(),
    linkBoxA: randomUUID(),
    linkLength: randomUUID(),
    linkUnreadable: randomUUID(),
    linkBoxB: randomUUID(),
    linkOther: randomUUID(),
  };
  await q(
    `UPDATE design_revisions SET status = 'building', build_started_at = now() WHERE id = $1`,
    [revisionId],
  );
  if (withData) {
    const feature = async (
      id: string,
      type: string,
      geom: string,
      layer: string,
      kind: string,
      handle: string,
    ) => {
      await q(
        `INSERT INTO features (id, project_id, feature_type, first_revision_id) VALUES ($1, $2, $3, $4)`,
        [id, projectA, type, revisionId],
      );
      await q(
        `INSERT INTO design_features (revision_id, feature_id, project_id, feature_type, layer, source_kind, source_handle, geom)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ${geom})`,
        [revisionId, id, projectA, type, layer, kind, handle],
      );
    };
    // 7.5 east, 10 north: a 12.5 m route (3 decimals in the database: 12.500).
    await feature(
      ids.route,
      'route',
      `ST_SetSRID(ST_MakeLine(ST_MakePoint(${E0}, ${N0}), ST_MakePoint(${E0 + 7.5}, ${N0 + 10})), 32636)`,
      'N_DUC_CBL',
      'curve',
      'A1',
    );
    await feature(ids.boxA, 'box', point(E0 + 10, N0 + 10), 'sub', 'insert', 'B1');
    await feature(ids.boxB, 'box', point(E0 + 50, N0 + 50), 'sub', 'insert', 'B2');
    await feature(ids.hhi, 'hhi', point(E0 + 100, N0 + 100), 'RRR', 'text', 'H1');

    const link = (
      id: string,
      handle: string,
      kind: string,
      status: string,
      text: string | null,
      confidence: string,
      feature: string | null,
      distance: string | null,
      x: number,
      y: number,
    ) =>
      q(
        `INSERT INTO text_links (id, project_id, revision_id, text_handle, layer, text, raw_text, readable,
                                 position, height_m, kind, status, feature_id, distance_m, confidence)
         VALUES ($1, $2, $3, $4, 'TXT', $5::text, $6, $5::text IS NOT NULL, ${point(x, y)}, 2.5, $7, $8, $9, $10, $11)`,
        [
          id,
          projectA,
          revisionId,
          handle,
          text,
          text ?? 'zz',
          kind,
          status,
          feature,
          distance,
          confidence,
        ],
      );
    // The stored distance of linkBoxA is deliberately wrong: confirming must recompute it (5 m).
    await link(
      ids.linkBoxA,
      'T1',
      'box_id',
      'review',
      '1-1',
      '0.450',
      ids.boxA,
      '99.000',
      E0 + 13,
      N0 + 14,
    );
    await link(
      ids.linkLength,
      'T2',
      'length',
      'auto',
      '150.0M',
      '0.900',
      ids.route,
      '2.000',
      E0 + 3,
      N0 + 5,
    );
    await link(
      ids.linkUnreadable,
      'T3',
      'unreadable',
      'review',
      null,
      '0.000',
      null,
      null,
      E0 + 200,
      N0 + 200,
    );
    await link(
      ids.linkBoxB,
      'T4',
      'box_id',
      'review',
      '1-2',
      '0.600',
      ids.boxB,
      '1.500',
      E0 + 51,
      N0 + 51,
    );
    await link(
      ids.linkOther,
      'T5',
      'other',
      'unlinked',
      '12',
      '0.000',
      null,
      null,
      E0 + 300,
      N0 + 300,
    );

    const diff = (feature: string, type: string, change: string, extra = '') =>
      q(
        `INSERT INTO revision_diff_items (project_id, revision_id, feature_id, feature_type, change,
                                          length_delta_m, candidate_feature_ids)
         VALUES ($1, $2, $3, $4, $5, ${extra || 'NULL'}, '{}')`,
        [projectA, revisionId, feature, type, change],
      );
    await diff(ids.route, 'route', 'reshaped', '1.250');
    await diff(ids.boxA, 'box', 'added');
    await diff(ids.boxB, 'box', 'unchanged');
    await diff(ids.hhi, 'hhi', 'conflict');
  }
  await q(
    `UPDATE design_revisions
        SET status = 'draft', built_at = now(), counts = $2, text_link_counts = $3, diff_counts = $4
      WHERE id = $1`,
    [
      revisionId,
      JSON.stringify({
        features: withData
          ? { route: 1, box: 2, hhi: 1, joint: 0, mh: 0 }
          : { route: 0, box: 0, hhi: 0, joint: 0, mh: 0 },
        routeLengthM: withData ? '12.5' : '0',
      }),
      JSON.stringify({ auto: 1, review: 3, confirmed: 0, rejected: 0, unlinked: 1 }),
      JSON.stringify({
        added: 1,
        removed: 0,
        unchanged: 1,
        moved: 0,
        reshaped: 1,
        attributes_changed: 0,
        conflict: 1,
      }),
    ],
  );
  return ids;
}

async function saveMapping(fileId: string, version: number | null, unit: string = 'in') {
  return as(pm)(http().put(`${filesUrl(projectA)}/${fileId}/mapping`)).send({
    rules: [
      { source: 'layer', layer: 'N_DUC_CBL', target: 'route' },
      { source: 'layer', layer: 'sub', target: 'box' },
      { source: 'text', layer: 'RRR', text: 'NEW-HHI', target: 'hhi' },
    ],
    crsEpsg: 32636,
    drawingUnit: unit,
    version,
  });
}

const createRevision = (fileId: string, mappingVersion: number, token = pm, context = ctx) =>
  as(token)(http(context).post(revisionsUrl(projectA))).send({ cadFileId: fileId, mappingVersion });

async function jobsFor(revisionId: string) {
  const raw = await redis.lrange(CAD_QUEUE_KEYS.jobs, 0, -1);
  return raw
    .map((message) => CadBuildRevisionJobSchema.safeParse(JSON.parse(message)))
    .flatMap((parsed) =>
      parsed.success && parsed.data.revisionId === revisionId ? [parsed.data] : [],
    );
}

/** Collects a binary body (the default parser would turn it into text). */
const binary = (
  res: NodeJS.ReadableStream,
  callback: (error: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

// ---------------------------------------------------------------------------------------------

let fileId: string;
let mappingVersion: number;
let revisionId: string;
let build: SimulatedBuild;

describe('CAD mapping', () => {
  beforeAll(async () => {
    fileId = await insertCadFile('processed');
    await insertExtraction(fileId);
  });

  it('shows no groups for a file that is not processed, and a null mapping', async () => {
    const pending = await insertCadFile('uploaded');
    const res = await as(pm)(http().get(`${filesUrl(projectA)}/${pending}/mapping`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(CadMappingViewSchema.parse(res.body)).toMatchObject({
      cadFileId: pending,
      fileStatus: 'uploaded',
      layers: [],
      blocks: [],
      texts: [],
      mapping: null,
      crsDetection: null,
    });
  });

  it('groups layers, blocks and texts with name-based suggestions', async () => {
    const res = await as(pm)(http().get(`${filesUrl(projectA)}/${fileId}/mapping`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const view = CadMappingViewSchema.parse(res.body);
    expect(view).toMatchObject({
      fileStatus: 'processed',
      projectEpsg: 32636,
      insUnits: 1,
      crsDetection: DETECTION,
      mapping: null,
    });

    const layer = (name: string) => view.layers.find((row) => row.name === name);
    expect(layer('N_DUC_CBL')).toMatchObject({
      aciColor: 3,
      entityTotal: 2,
      suggestedTarget: 'route',
      suggestionSource: 'name_pattern',
    });
    expect(layer('sub')).toMatchObject({
      suggestedTarget: 'box',
      suggestionSource: 'name_pattern',
    });
    expect(layer('TXT')).toMatchObject({ suggestedTarget: 'label' });
    expect(layer('tx')).toMatchObject({
      suggestedTarget: 'background',
      suggestionSource: 'default',
    });
    expect(view.layers).toHaveLength(5);

    expect(view.blocks).toEqual([
      { name: 'HHI', count: 2, layers: ['RRR', 'sub'], suggestedTarget: 'hhi' },
      { name: 'MISC', count: 1, layers: ['RRR'], suggestedTarget: null },
      { name: 'sub', count: 2, layers: ['sub'], suggestedTarget: 'box' },
    ]);
    // count DESC, then layer, then text; trimmed duplicates merged; unreadable text excluded.
    expect(view.texts).toEqual([
      { layer: 'RRR', text: 'NEW-HHI', count: 3, suggestedTarget: 'hhi' },
      { layer: 'TXT', text: '1-1', count: 2, suggestedTarget: null },
      { layer: 'TXT', text: 'F 36 C', count: 1, suggestedTarget: null },
    ]);
  });

  it('saves version 1 with the exact factor, then bumps the version', async () => {
    const first = await saveMapping(fileId, null);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(CadMappingSchema.parse(first.body)).toMatchObject({
      cadFileId: fileId,
      version: 1,
      drawingUnit: 'in',
      metresPerUnit: '0.0254',
      crsEpsg: 32636,
    });
    expect(first.body.rules).toHaveLength(3);

    const second = await saveMapping(fileId, 1, 'ft');
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ version: 2, drawingUnit: 'ft', metresPerUnit: '0.3048' });
    mappingVersion = 2;

    const view = CadMappingViewSchema.parse(
      (await as(supervisor)(http().get(`${filesUrl(projectA)}/${fileId}/mapping`))).body,
    );
    expect(view.mapping).toMatchObject({ version: 2, drawingUnit: 'ft' });
    expect(await eventTypes(ctx.pool, fileId)).toEqual(['cad_mapping.saved', 'cad_mapping.saved']);
  });

  it('answers 409 VERSION_MISMATCH for a stale or unexpected version', async () => {
    for (const version of [1, null, 7]) {
      const res = await saveMapping(fileId, version);
      expect(res.status, `version ${String(version)}`).toBe(409);
      expect(res.body).toMatchObject({ code: 'CONFLICT', details: { reason: 'VERSION_MISMATCH' } });
    }
    const { rows } = await ctx.pool.query(
      'SELECT version FROM cad_mappings WHERE cad_file_id = $1',
      [fileId],
    );
    expect(rows[0].version).toBe(2);
  });

  it('answers 409 NOT_PROCESSED for a file that is not processed', async () => {
    const pending = await insertCadFile('uploaded');
    const res = await saveMapping(pending, null);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'CONFLICT', details: { reason: 'NOT_PROCESSED' } });
  });

  it('validates the body with the shared schema', async () => {
    const bad = (body: object) =>
      as(pm)(http().put(`${filesUrl(projectA)}/${fileId}/mapping`)).send(body);
    const rule = { source: 'layer', layer: 'a', target: 'route' };
    expect(
      (await bad({ rules: [rule, rule], crsEpsg: 32636, drawingUnit: 'm', version: 2 })).status,
    ).toBe(400);
    expect((await bad({ rules: [], crsEpsg: 4326, drawingUnit: 'm', version: 2 })).status).toBe(
      400,
    );
    expect((await bad({ rules: [], crsEpsg: 32636, version: 2 })).status).toBe(400); // no default unit
    expect(
      (
        await bad({
          rules: [{ source: 'block', block: 'x', target: 'route' }],
          crsEpsg: 32636,
          drawingUnit: 'm',
          version: 2,
        })
      ).status,
    ).toBe(400);
  });

  it('enforces roles: supervisor may read but not write; contractor nothing', async () => {
    const url = `${filesUrl(projectA)}/${fileId}/mapping`;
    expect((await as(supervisor)(http().get(url))).status).toBe(200);
    expect((await as(supervisor)(http().put(url)).send({})).status).toBe(403);
    expect((await as(contractor)(http().get(url))).status).toBe(403);
    expect((await as(contractor)(http().put(url)).send({})).status).toBe(403);
    expect((await http().get(url)).status).toBe(401);
  });

  it("treats another project's file as not found", async () => {
    const url = `${filesUrl(projectB)}/${fileId}/mapping`;
    expect((await as(admin)(http().get(url))).status).toBe(404);
    const put = await as(admin)(http().put(url)).send({
      rules: [],
      crsEpsg: 32636,
      drawingUnit: 'm',
      version: null,
    });
    expect(put.status).toBe(404);
    expect((await as(pm)(http().get(url))).status).toBe(403); // pm is not a member of project B
  });

  it('exposes the stored CRS detection on the CAD file detail', async () => {
    const res = await as(pm)(http().get(`${filesUrl(projectA)}/${fileId}`));
    expect(CadFileDetailSchema.parse(res.body).crsDetection).toEqual(DETECTION);
    const old = await insertCadFile('uploaded');
    const legacy = await as(pm)(http().get(`${filesUrl(projectA)}/${old}`));
    expect(CadFileDetailSchema.parse(legacy.body).crsDetection).toBeNull();
  });
});

describe('creating a design revision', () => {
  it('refuses without a mapping, with a stale version and for an unprocessed file', async () => {
    const bare = await insertCadFile('processed');
    const noMapping = await createRevision(bare, 1);
    expect(noMapping.status).toBe(409);
    expect(noMapping.body).toMatchObject({ code: 'CONFLICT', details: { reason: 'NO_MAPPING' } });

    const stale = await createRevision(fileId, 1);
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({
      reason: 'MAPPING_VERSION_MISMATCH',
      currentVersion: 2,
    });

    const pending = await insertCadFile('uploaded');
    await ctx.pool.query(
      `INSERT INTO cad_mappings (cad_file_id, project_id, rules, crs_epsg, drawing_unit, metres_per_unit)
       VALUES ($1, $2, '[]', 32636, 'm', 1)`,
      [pending, projectA],
    );
    const unprocessed = await createRevision(pending, 1);
    expect(unprocessed.status).toBe(409);
    expect(unprocessed.body.details).toMatchObject({ reason: 'NOT_PROCESSED' });

    const { rows } = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM design_revisions WHERE project_id = $1',
      [projectA],
    );
    expect(rows[0].n).toBe(0);
  });

  it('is limited to design:write and to the project', async () => {
    expect((await createRevision(fileId, mappingVersion, supervisor)).status).toBe(403);
    expect((await createRevision(fileId, mappingVersion, contractor)).status).toBe(403);
    const other = await as(admin)(http().post(revisionsUrl(projectB))).send({
      cadFileId: fileId,
      mappingVersion,
    });
    expect(other.status).toBe(404);
    expect((await createRevision('not-a-uuid' as string, 1)).status).toBe(400);
  });

  it('queues the revision with the frozen mapping, records the event and pushes one job', async () => {
    const res = await createRevision(fileId, mappingVersion);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const summary = DesignRevisionSummarySchema.parse(res.body);
    revisionId = summary.id;
    expect(summary).toMatchObject({
      projectId: projectA,
      cadFileId: fileId,
      status: 'queued',
      revNo: null,
      crsEpsg: 32636,
      drawingUnit: 'ft',
      metresPerUnit: '0.3048',
      insUnits: 1,
      unitsConflict: true,
      baseRevisionId: null,
      counts: null,
      hasTiles: false,
      errorCode: null,
    });
    expect(summary.cadFileName).toMatch(/^plan-/);

    const { rows } = await ctx.pool.query(
      'SELECT status, current_job_id, mapping_version, rules, created_by FROM design_revisions WHERE id = $1',
      [revisionId],
    );
    expect(rows[0]).toMatchObject({ status: 'queued', mapping_version: 2 });
    expect(rows[0].rules).toHaveLength(3);
    expect(rows[0].created_by).toBeTruthy();
    expect(await eventTypes(ctx.pool, revisionId)).toEqual(['design_revision.queued']);

    const jobs = await jobsFor(revisionId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: rows[0].current_job_id,
      type: 'cad.build_revision',
      projectId: projectA,
      cadFileId: fileId,
      attempt: 1,
    });
  });

  it('allows only one open revision per project (REVISION_IN_PROGRESS)', async () => {
    const res = await createRevision(fileId, mappingVersion);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'REVISION_IN_PROGRESS' },
    });
    const { rows } = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM design_revisions WHERE project_id = $1',
      [projectA],
    );
    expect(rows[0].n).toBe(1);
  });

  it('refuses to reprocess the file while its revision is queued or building', async () => {
    const url = `${filesUrl(projectA)}/${fileId}/reprocess`;
    const queued = await as(pm)(http().post(url));
    expect(queued.status).toBe(409);
    expect(queued.body.details).toMatchObject({ reason: 'REVISION_IN_PROGRESS' });
    await ctx.pool.query(`UPDATE design_revisions SET status = 'building' WHERE id = $1`, [
      revisionId,
    ]);
    expect((await as(pm)(http().post(url))).status).toBe(409);
    const { rows } = await ctx.pool.query('SELECT status FROM cad_files WHERE id = $1', [fileId]);
    expect(rows[0].status).toBe('processed');
  });

  it('lists and shows revisions (design:read), newest first, per project', async () => {
    const list = DesignRevisionListResponseSchema.parse(
      (await as(supervisor)(http().get(revisionsUrl(projectA)))).body,
    );
    expect(list.items.map((item) => item.id)).toEqual([revisionId]);

    const detail = await as(supervisor)(http().get(`${revisionsUrl(projectA)}/${revisionId}`));
    expect(detail.status).toBe(200);
    expect(DesignRevisionDetailSchema.parse(detail.body)).toMatchObject({
      id: revisionId,
      status: 'building',
      errorMessage: null,
      log: null,
    });
    expect((await as(contractor)(http().get(revisionsUrl(projectA)))).status).toBe(403);
    expect((await as(admin)(http().get(`${revisionsUrl(projectB)}/${revisionId}`))).status).toBe(
      404,
    );
    expect(
      DesignRevisionListResponseSchema.parse(
        (await as(admin)(http().get(revisionsUrl(projectB)))).body,
      ).items,
    ).toEqual([]);
  });
});

describe('a built draft revision', () => {
  const url = (path = '') => `${revisionsUrl(projectA)}/${revisionId}${path}`;

  beforeAll(async () => {
    build = await simulateBuild(revisionId);
  });

  it('shows the counts the worker stored', async () => {
    const detail = DesignRevisionDetailSchema.parse((await as(pm)(http().get(url()))).body);
    expect(detail.status).toBe('draft');
    expect(detail.counts).toEqual({
      features: { route: 1, box: 2, hhi: 1, joint: 0, mh: 0 },
      routeLengthM: '12.5',
    });
    expect(detail.textLinkCounts).toMatchObject({ review: 3, auto: 1 });
    expect(detail.diffCounts).toMatchObject({ conflict: 1, added: 1 });
  });

  it('lists features by type, code and handle with metric anchors and exact lengths', async () => {
    const res = await as(supervisor)(http().get(url('/features')));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const page = DesignFeaturePageSchema.parse(res.body);
    expect(page.total).toBe(4);
    // 'box' < 'hhi' < 'route' alphabetically; boxes by handle (no codes yet).
    expect(page.items.map((item) => item.sourceHandle)).toEqual(['B1', 'B2', 'H1', 'A1']);
    const route = page.items.find((item) => item.featureType === 'route');
    expect(route).toMatchObject({
      id: build.route,
      revisionId,
      lengthM: '12.5',
      anchor: { x: E0, y: N0 },
      sourceKind: 'curve',
      layer: 'N_DUC_CBL',
      blockName: null,
    });
    expect(page.items.find((item) => item.id === build.boxA)).toMatchObject({
      lengthM: null,
      anchor: { x: E0 + 10, y: N0 + 10 },
    });

    const boxes = DesignFeaturePageSchema.parse(
      (await as(pm)(http().get(url('/features?featureType=box&pageSize=1&page=2')))).body,
    );
    expect(boxes).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(boxes.items.map((item) => item.id)).toEqual([build.boxB]);
    const found = DesignFeaturePageSchema.parse(
      (await as(pm)(http().get(url('/features?q=h1')))).body,
    );
    expect(found.items.map((item) => item.id)).toEqual([build.hhi]);
    expect((await as(pm)(http().get(url('/features?featureType=pipe')))).status).toBe(400);
  });

  it('lists text links least confident first, with filters and decimal strings', async () => {
    const res = await as(pm)(http().get(url('/text-links')));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const page = TextLinkPageSchema.parse(res.body);
    expect(page.items.map((item) => item.textHandle)).toEqual(['T3', 'T5', 'T1', 'T4', 'T2']);
    expect(page.items.map((item) => item.confidence)).toEqual(['0', '0', '0.45', '0.6', '0.9']);
    expect(page.items[2]).toMatchObject({
      id: build.linkBoxA,
      kind: 'box_id',
      status: 'review',
      featureId: build.boxA,
      featureType: 'box',
      featureCode: null,
      distanceM: '99',
      position: { x: E0 + 13, y: N0 + 14 },
      readable: true,
      reviewedById: null,
    });
    expect(page.items[0]).toMatchObject({
      text: null,
      readable: false,
      featureId: null,
      distanceM: null,
    });
    expect(page.items[4]).toMatchObject({ distanceM: '2', featureType: 'route' });

    const filtered = TextLinkPageSchema.parse(
      (await as(pm)(http().get(url('/text-links?status=review&readable=true')))).body,
    );
    expect(filtered.items.map((item) => item.textHandle)).toEqual(['T1', 'T4']);
    const byKind = TextLinkPageSchema.parse(
      (await as(pm)(http().get(url('/text-links?kind=length')))).body,
    );
    expect(byKind.items.map((item) => item.textHandle)).toEqual(['T2']);
  });

  it('lists the diff, hiding unchanged items by default', async () => {
    const changed = DiffPageSchema.parse((await as(pm)(http().get(url('/diff')))).body);
    expect(changed.items.map((item) => item.change)).toEqual(['added', 'conflict', 'reshaped']);
    expect(changed.items.find((item) => item.change === 'reshaped')).toMatchObject({
      featureId: build.route,
      lengthDeltaM: '1.25',
      distanceM: null,
      candidateFeatureIds: [],
    });
    const all = DiffPageSchema.parse(
      (await as(pm)(http().get(url('/diff?changedOnly=false')))).body,
    );
    expect(all.total).toBe(4);
    const only = DiffPageSchema.parse(
      (await as(pm)(http().get(url('/diff?change=unchanged')))).body,
    );
    expect(only.items.map((item) => item.featureId)).toEqual([build.boxB]);
  });

  it('reviews links: validates, recomputes distance and box codes, counts and records events', async () => {
    const link = (id: string) => url(`/text-links/${id}`);
    const patch = (id: string, body: object, token = pm) =>
      as(token)(http().patch(link(id))).send(body);
    const codeOf = async (featureId: string) =>
      (await ctx.pool.query('SELECT code FROM design_features WHERE feature_id = $1', [featureId]))
        .rows[0].code as string | null;

    // A route cannot carry a box id.
    const wrongType = await patch(build.linkBoxA, { action: 'confirm', featureId: build.route });
    expect(wrongType.status).toBe(422);
    expect(wrongType.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'FEATURE_TYPE_NOT_ALLOWED', kind: 'box_id', featureType: 'route' },
    });
    // An unreadable text with no proposed feature needs one.
    const noFeature = await patch(build.linkUnreadable, { action: 'confirm' });
    expect(noFeature.status).toBe(422);
    expect(noFeature.body.details).toMatchObject({ reason: 'FEATURE_REQUIRED' });
    expect((await patch(build.linkBoxA, { action: 'maybe' })).status).toBe(400);

    // Confirm keeps the proposed box; the stored (wrong) distance is recomputed from the geometry.
    const confirmed = await patch(build.linkBoxA, { action: 'confirm' });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(TextLinkSchema.parse(confirmed.body)).toMatchObject({
      status: 'confirmed',
      featureId: build.boxA,
      featureType: 'box',
      featureCode: '1-1',
      distanceM: '5',
      confidence: '0.45',
      reviewedAt: expect.any(String),
    });
    expect(confirmed.body.reviewedById).toBeTruthy();
    expect(await codeOf(build.boxA)).toBe('1-1');

    // Reassign to the other box: the code follows the link.
    const reassigned = await patch(build.linkBoxA, { action: 'confirm', featureId: build.boxB });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body).toMatchObject({
      featureId: build.boxB,
      distanceM: '51.624',
      featureCode: '1-1',
    });
    expect(await codeOf(build.boxA)).toBeNull();
    expect(await codeOf(build.boxB)).toBe('1-1');

    // The more confident confirmed link wins; rejecting it gives the code back.
    expect((await patch(build.linkBoxB, { action: 'confirm' })).status).toBe(200);
    expect(await codeOf(build.boxB)).toBe('1-2');
    const rejected = await patch(build.linkBoxB, { action: 'reject' });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      featureId: build.boxB,
      // Confirming recomputed the distance (the stored 1.5 was a placeholder); rejecting keeps it.
      distanceM: '1.414',
      confidence: '0.6',
    });
    expect(await codeOf(build.boxB)).toBe('1-1');

    const detail = DesignRevisionDetailSchema.parse((await as(pm)(http().get(url()))).body);
    expect(detail.textLinkCounts).toEqual({
      auto: 1,
      review: 1,
      confirmed: 1,
      rejected: 1,
      unlinked: 1,
    });

    expect(
      (
        await ctx.pool.query(
          `SELECT count(*)::int AS n FROM events WHERE type = 'text_link.reviewed' AND entity_id = $1`,
          [build.linkBoxA],
        )
      ).rows[0].n,
    ).toBe(2);
    const event = await ctx.pool.query(
      `SELECT payload, actor_id FROM events WHERE type = 'text_link.reviewed' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [build.linkBoxA],
    );
    expect(event.rows[0].payload).toMatchObject({
      before: { status: 'confirmed', featureId: build.boxA },
      after: { status: 'confirmed', featureId: build.boxB },
    });
    expect(event.rows[0].actor_id).toBeTruthy();

    // The features list shows the recomputed code.
    const features = DesignFeaturePageSchema.parse(
      (await as(pm)(http().get(url('/features?q=1-1')))).body,
    );
    expect(features.items.map((item) => item.id)).toEqual([build.boxB]);
  });

  it('refuses review by supervisors and contractors and for unknown ids', async () => {
    const link = `/text-links/${build.linkLength}`;
    expect((await as(supervisor)(http().patch(url(link))).send({ action: 'reject' })).status).toBe(
      403,
    );
    expect((await as(contractor)(http().patch(url(link))).send({ action: 'reject' })).status).toBe(
      403,
    );
    expect(
      (await as(pm)(http().patch(url(`/text-links/${randomUUID()}`))).send({ action: 'reject' }))
        .status,
    ).toBe(404);
    const stranger = await as(pm)(http().patch(url(link))).send({
      action: 'confirm',
      featureId: randomUUID(),
    });
    expect(stranger.status).toBe(404);
    expect(
      (
        await as(admin)(http().patch(`${revisionsUrl(projectB)}/${revisionId}${link}`)).send({
          action: 'reject',
        })
      ).status,
    ).toBe(404);
  });

  it('streams the PMTiles archive with Range support', async () => {
    const archive = Buffer.from('PMTiles-archive-0123456789');
    const key = `projects/${projectA}/revisions/${revisionId}/design.pmtiles`;
    // No archive yet.
    expect((await as(pm)(http().get(url('/tiles.pmtiles')))).status).toBe(404);

    await mkdir(dirname(join(ctx.storageRoot, key)), { recursive: true });
    await writeFile(join(ctx.storageRoot, key), archive);
    await ctx.pool.query('UPDATE design_revisions SET tiles_storage_key = $2 WHERE id = $1', [
      revisionId,
      key,
    ]);

    const get = (range?: string, token = supervisor) => {
      const req = as(token)(http().get(url('/tiles.pmtiles')))
        .buffer(true)
        .parse(binary as never);
      return range ? req.set('Range', range) : req;
    };

    const full = await get();
    expect(full.status).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-type']).toBe('application/vnd.pmtiles');
    expect(full.headers['content-length']).toBe(String(archive.length));
    expect((full.body as Buffer).equals(archive)).toBe(true);

    const part = await get('bytes=8-15');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 8-15/${archive.length}`);
    expect(part.headers['content-length']).toBe('8');
    expect((part.body as Buffer).toString()).toBe('archive-');

    const suffix = await get('bytes=-4');
    expect(suffix.status).toBe(206);
    expect((suffix.body as Buffer).toString()).toBe('6789');
    const open = await get(`bytes=${archive.length - 3}-`);
    expect(open.status).toBe(206);
    expect((open.body as Buffer).toString()).toBe('789');

    const outside = await get(`bytes=${archive.length}-`);
    expect(outside.status).toBe(416);
    expect(outside.headers['content-range']).toBe(`bytes */${archive.length}`);

    expect((await get(undefined, contractor)).status).toBe(403);
    expect(
      (await as(admin)(http().get(`${revisionsUrl(projectB)}/${revisionId}/tiles.pmtiles`))).status,
    ).toBe(404);
    expect(DesignRevisionSummarySchema.parse((await as(pm)(http().get(url()))).body).hasTiles).toBe(
      true,
    );
  });

  it('signs tile URLs that /tiles/verify accepts, and only those', async () => {
    const res = await as(supervisor)(http().post(url('/tile-url')));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { urlTemplate, expiresAt } = TileUrlResponseSchema.parse(res.body);
    expect(
      urlTemplate.startsWith(
        `${TILES_URL}/design_features/{z}/{x}/{y}?p=${projectA}&r=${revisionId}&exp=`,
      ),
    ).toBe(true);
    const remaining = new Date(expiresAt).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(3_590_000);
    expect(remaining).toBeLessThanOrEqual(3_600_000);

    const concrete = new URL(urlTemplate.replace('{z}/{x}/{y}', '14/9640/6290'));
    const forwarded = concrete.pathname + concrete.search;
    const verify = (uri?: string, context = ctx) => {
      const req = http(context).get('/tiles/verify'); // no Authorization header: Caddy only
      return uri === undefined ? req : req.set('X-Forwarded-Uri', uri);
    };
    expect((await verify(forwarded)).status).toBe(204);

    // Tampered project, revision, path, signature; missing header; expired; wrong secret.
    expect((await verify(forwarded.replace(projectA, projectB))).status).toBe(401);
    expect((await verify(forwarded.replace(revisionId, randomUUID()))).status).toBe(401);
    expect((await verify(forwarded.replace('/design_features/', '/other/'))).status).toBe(401);
    const flipped = `${forwarded.slice(0, -1)}${forwarded.endsWith('A') ? 'B' : 'A'}`;
    expect((await verify(flipped)).status).toBe(401);
    expect((await verify()).status).toBe(401);
    const exp = Math.floor(Date.now() / 1000) - 10;
    const expired = `/design_features/14/1/2?p=${projectA}&r=${revisionId}&exp=${exp}&sig=${signTile(TILE_SECRET, projectA, revisionId, exp)}`;
    expect((await verify(expired)).status).toBe(401);
    expect((await verify(forwarded, noTilesCtx)).status).toBe(401);

    // Not configured → 404 for the signing endpoint.
    expect((await as(supervisor)(http(noTilesCtx).post(url('/tile-url')))).status).toBe(404);
    expect((await as(contractor)(http().post(url('/tile-url')))).status).toBe(403);
    expect(
      (await as(admin)(http().post(`${revisionsUrl(projectB)}/${revisionId}/tile-url`))).status,
    ).toBe(404);
  });

  it('serves tiles only to the restricted ftth_tiles role, through the tile function', async () => {
    const databaseUrl = new URL(inject('databaseUrl'));
    await ctx.pool.query(`ALTER ROLE ftth_tiles LOGIN PASSWORD 'tiles-test-password'`);
    databaseUrl.username = 'ftth_tiles';
    databaseUrl.password = 'tiles-test-password';
    const client = new pg.Client({ connectionString: databaseUrl.toString() });
    await client.connect();
    try {
      // No table privileges at all.
      await expect(client.query('SELECT 1 FROM design_features LIMIT 1')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query('SELECT 1 FROM users LIMIT 1')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query('SELECT 1 FROM design_revisions LIMIT 1')).rejects.toThrow(
        /permission denied/,
      );

      // The tile that contains the route start (web mercator XYZ at z=14).
      const lonLat = await ctx.pool.query<{ lon: number; lat: number }>(
        `SELECT ST_X(g) AS lon, ST_Y(g) AS lat
           FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 32636), 4326) AS g) AS t`,
        [E0, N0],
      );
      const { lon, lat } = lonLat.rows[0] ?? { lon: 0, lat: 0 };
      const z = 14;
      const x = Math.floor(((lon + 180) / 360) * 2 ** z);
      const latRad = (lat * Math.PI) / 180;
      const y = Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * 2 ** z,
      );

      const tile = (project: string, revision: string, tileX = x, tileY = y) =>
        client.query<{ tile: Buffer }>(
          `SELECT tiles.design_features($1, $2, $3, $4::json) AS tile`,
          [z, tileX, tileY, JSON.stringify({ p: project, r: revision })],
        );
      const matching = await tile(projectA, revisionId);
      expect(matching.rows[0]?.tile.length).toBeGreaterThan(0);
      // Same revision under another project, an unknown revision, junk ids, an empty tile area.
      expect((await tile(projectB, revisionId)).rows[0]?.tile.length).toBe(0);
      expect((await tile(projectA, randomUUID())).rows[0]?.tile.length).toBe(0);
      expect((await tile('nope', 'nope')).rows[0]?.tile.length).toBe(0);
      expect((await tile(projectA, revisionId, x + 40, y + 40)).rows[0]?.tile.length).toBe(0);
    } finally {
      await client.end();
      await ctx.pool.query('ALTER ROLE ftth_tiles NOLOGIN');
    }
  });

  it('blocks publishing while items are open, until they are acknowledged', async () => {
    expect((await as(supervisor)(http().post(url('/publish'))).send({})).status).toBe(403);

    const blocked = await as(pm)(http().post(url('/publish'))).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'OPEN_ITEMS', textLinksToReview: 1, diffConflicts: 1 },
    });
    const still = await ctx.pool.query(
      'SELECT status, rev_no FROM design_revisions WHERE id = $1',
      [revisionId],
    );
    expect(still.rows[0]).toEqual({ status: 'draft', rev_no: null });

    const published = await as(pm)(http().post(url('/publish'))).send({
      acknowledgeOpenItems: true,
    });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(DesignRevisionDetailSchema.parse(published.body)).toMatchObject({
      id: revisionId,
      status: 'published',
      revNo: 1,
      publishedAt: expect.any(String),
    });
    expect(published.body.publishedById).toBeTruthy();
    expect(await eventTypes(ctx.pool, revisionId)).toEqual([
      'design_revision.queued',
      'design_revision.published',
    ]);
    const event = await ctx.pool.query(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'design_revision.published'`,
      [revisionId],
    );
    expect(event.rows[0].payload).toMatchObject({
      revNo: 1,
      acknowledgedOpenItems: true,
      textLinksToReview: 1,
      diffConflicts: 1,
    });
  });

  it('is locked once published: reviews, publishing and discarding answer 409', async () => {
    const review = await as(pm)(http().patch(url(`/text-links/${build.linkUnreadable}`))).send({
      action: 'reject',
    });
    expect(review.status).toBe(409);
    expect(review.body).toMatchObject({ code: 'CONFLICT', details: { reason: 'REVISION_LOCKED' } });
    const again = await as(pm)(http().post(url('/publish'))).send({ acknowledgeOpenItems: true });
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: 'NOT_DRAFT' });
    const discard = await as(pm)(http().post(url('/discard')));
    expect(discard.status).toBe(409);
    expect(discard.body.details).toMatchObject({ reason: 'NOT_DISCARDABLE' });

    // The data stays readable and unchanged.
    const links = TextLinkPageSchema.parse(
      (await as(pm)(http().get(url('/text-links?status=review')))).body,
    );
    expect(links.items.map((item) => item.textHandle)).toEqual(['T3']);
    // Tile URLs and the archive stay available for a published revision.
    expect((await as(pm)(http().post(url('/tile-url')))).status).toBe(200);
    expect((await as(pm)(http().get(url('/tiles.pmtiles')))).status).toBe(200);
  });
});

describe('further revisions', () => {
  it('bases the next revision on the published one and numbers it 2 on publish', async () => {
    const created = await createRevision(fileId, mappingVersion);
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const second = DesignRevisionSummarySchema.parse(created.body);
    expect(second.baseRevisionId).toBe(revisionId);
    await simulateBuild(second.id, false);

    const published = await as(pm)(
      http().post(`${revisionsUrl(projectA)}/${second.id}/publish`),
    ).send({});
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body).toMatchObject({ status: 'published', revNo: 2 });

    const list = DesignRevisionListResponseSchema.parse(
      (await as(pm)(http().get(revisionsUrl(projectA)))).body,
    );
    expect(list.items.map((item) => item.revNo)).toEqual([2, 1]);
    // The first revision is untouched.
    const first = await ctx.pool.query(
      'SELECT status, rev_no FROM design_revisions WHERE id = $1',
      [revisionId],
    );
    expect(first.rows[0]).toEqual({ status: 'published', rev_no: 1 });
  });

  it('discards failed and stale revisions and frees the slot for the next one', async () => {
    const created = DesignRevisionSummarySchema.parse(
      (await createRevision(fileId, mappingVersion)).body,
    );
    const url = `${revisionsUrl(projectA)}/${created.id}`;

    // Freshly queued: not discardable yet.
    const early = await as(pm)(http().post(`${url}/discard`));
    expect(early.status).toBe(409);
    expect(early.body.details).toMatchObject({ reason: 'NOT_DISCARDABLE' });
    expect((await as(supervisor)(http().post(`${url}/discard`))).status).toBe(403);

    // Stale queued revision (its worker is gone): discardable, and its job is superseded.
    const before = await ctx.pool.query(
      'SELECT current_job_id FROM design_revisions WHERE id = $1',
      [created.id],
    );
    await ctx.pool.query(
      `UPDATE design_revisions SET queued_at = now() - interval '20 minutes' WHERE id = $1`,
      [created.id],
    );
    const stale = await as(pm)(http().post(`${url}/discard`));
    expect(stale.status, JSON.stringify(stale.body)).toBe(200);
    expect(stale.body.status).toBe('discarded');
    const after = await ctx.pool.query(
      'SELECT current_job_id FROM design_revisions WHERE id = $1',
      [created.id],
    );
    expect(after.rows[0].current_job_id).not.toBe(before.rows[0].current_job_id);
    expect(await eventTypes(ctx.pool, created.id)).toEqual([
      'design_revision.queued',
      'design_revision.discarded',
    ]);

    // A failed revision is discardable at once; its error code is cleared (table CHECK) but kept in the event.
    const failed = DesignRevisionSummarySchema.parse(
      (await createRevision(fileId, mappingVersion)).body,
    );
    await ctx.pool.query(
      `UPDATE design_revisions SET status = 'failed', error_code = 'TILES_FAILED' WHERE id = $1`,
      [failed.id],
    );
    const shown = await as(pm)(http().get(`${revisionsUrl(projectA)}/${failed.id}`));
    expect(shown.body).toMatchObject({ status: 'failed', errorCode: 'TILES_FAILED' });
    const discarded = await as(pm)(http().post(`${revisionsUrl(projectA)}/${failed.id}/discard`));
    expect(discarded.status).toBe(200);
    expect(discarded.body).toMatchObject({ status: 'discarded', errorCode: null });

    // Discarded revisions are locked too.
    const locked = await as(pm)(http().post(`${revisionsUrl(projectA)}/${failed.id}/publish`)).send(
      {},
    );
    expect(locked.status).toBe(409);
  });

  it('marks the revision failed (ENQUEUE_FAILED) when the queue is unavailable', async () => {
    const res = await createRevision(fileId, mappingVersion, pm, brokenQueueCtx);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ status: 'failed', errorCode: 'ENQUEUE_FAILED' });
    expect(await eventTypes(ctx.pool, res.body.id)).toEqual([
      'design_revision.queued',
      'design_revision.failed',
    ]);
    expect(await jobsFor(res.body.id)).toHaveLength(0);

    // A failed revision does not block the project; it can be discarded.
    const again = await createRevision(fileId, mappingVersion);
    expect(again.status).toBe(202);
    await ctx.pool.query(
      `UPDATE design_revisions SET status = 'failed', error_code = 'INTERNAL' WHERE id = $1`,
      [again.body.id],
    );
    expect(
      (await as(pm)(http().post(`${revisionsUrl(projectA)}/${res.body.id}/discard`))).status,
    ).toBe(200);
  });

  it('answers 404 for unknown revisions and revisions of another project on every route', async () => {
    const unknown = randomUUID();
    for (const path of ['', '/features', '/text-links', '/diff', '/tiles.pmtiles']) {
      expect(
        (await as(pm)(http().get(`${revisionsUrl(projectA)}/${unknown}${path}`))).status,
        path,
      ).toBe(404);
      expect(
        (await as(admin)(http().get(`${revisionsUrl(projectB)}/${revisionId}${path}`))).status,
        path,
      ).toBe(404);
    }
    for (const path of ['/publish', '/discard', '/tile-url']) {
      expect(
        (await as(admin)(http().post(`${revisionsUrl(projectB)}/${revisionId}${path}`)).send({}))
          .status,
        path,
      ).toBe(404);
    }
    expect((await as(pm)(http().get(`${revisionsUrl(projectA)}/not-a-uuid`))).status).toBe(400);
  });
});
