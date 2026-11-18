import { randomUUID } from 'node:crypto';
import {
  BoxTypeStateSchema,
  BoxTypesReportSchema,
  DesignRevisionDetailSchema,
  InstallationReportSchema,
  InstallationStateSchema,
  PublishReadinessSchema,
} from '@ftth/shared';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createApprovedContract,
  createProjectIn,
  createWorkOrderFrom,
} from './support/contract-fixtures.js';
import { ensureMember, loginAs, SEED_LOGINS } from './support/helpers.js';
import { startRedis, type TestRedis } from './support/redis.js';
import { createTestContext, type TestContext } from './support/test-app.js';
import { insertDrawing, linkDrawingsToSite } from './support/drawing-fixtures.js';

/**
 * ADR-045: the installation question, the box types and the reading totals switched OFF (the
 * default of the API env). The other suites run with the switches on (test-app.ts).
 */

let testRedis: TestRedis;
let redis: Redis;
let ctx: TestContext;
let admin: string;

const PASSWORD = 'Flow#Pass123';
const SHAPE_1 = `v1-${'1'.repeat(64)}`;
const USED_PLACEMENT = {
  sourceCrs: 'project',
  points: [{ id: 'p1', drawing: { x: 1, y: 1 }, lat: 30.9, lon: 32.7, source: 'typed' }],
};
const BOX_RULES = [
  { source: 'layer', layer: 'BOXES', target: 'box', textRoles: ['box_cable_type'] },
];
const ROUTE_RULES = [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }];
const READING = {
  drawingKind: 'general',
  bundles: [],
  connectors: [],
  spares: [],
  cables: [{ cores: 24, count: 2, writtenLengthM: '100' }],
  handholes: [],
};

beforeAll(async () => {
  testRedis = await startRedis();
  redis = new Redis(testRedis.url);
  ctx = await createTestContext(inject('databaseUrl'), {
    REDIS_URL: testRedis.url,
    DRAWING_INSTALLATION_QUESTION: 'off',
    DRAWING_BOX_TYPES: 'off',
    DRAWING_READING_TOTALS: 'off',
  });
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  redis?.disconnect();
  await testRedis?.stop();
});

const http = () => request(ctx.app.getHttpServer());
const as = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
const q = (text: string, values: unknown[] = []) => ctx.pool.query(text, values);
const filesUrl = (p: string) => `/projects/${p}/cad-files`;
const revisionsUrl = (p: string) => `/projects/${p}/design-revisions`;

interface Scenario {
  project: string;
  pm: string;
  general: string;
  secondary: string;
}

async function insertFile(kind: 'general' | 'secondary', p: string): Promise<string> {
  const id = randomUUID();
  const drawingId = await insertDrawing(q, p, kind);
  await q(
    `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                            status, current_job_id, ins_units, processed_at, drawing_kind, drawing_id)
     VALUES ($1, $2, $3, 'dxf', 100, repeat('a', 64), $4, 'processed', $5, 1, now(), $6, $7)`,
    [
      id,
      p,
      `${kind}-${id.slice(0, 6)}.dxf`,
      `projects/${p}/cad/${id}/original.dxf`,
      randomUUID(),
      kind,
      drawingId,
    ],
  );
  return id;
}

/** A project with a work order, a General and a Secondary file; nothing answered or chosen. */
async function scenario(): Promise<Scenario> {
  const contract = await createApprovedContract(ctx.pool, [
    { code: 'L1', description: 'Box type L1', quantity: '1000' },
  ]);
  const project = await createProjectIn(ctx.pool, contract.contractId);
  await createWorkOrderFrom(ctx.pool, project, contract, { L1: '10' });
  const zone = (
    await q(`INSERT INTO zones (project_id, name) VALUES ($1, 'Z') RETURNING id`, [project])
  ).rows[0]?.id as string;
  const email = `flow-pm-${project.slice(0, 8)}@ftth.local`;
  await ensureMember(ctx.pool, {
    email,
    password: PASSWORD,
    role: 'pm',
    projectId: project,
    zoneId: zone,
  });
  const general = await insertFile('general', project);
  await q(
    `INSERT INTO cad_curves (project_id, cad_file_id, handle, entity_type, layer, geom)
     VALUES ($1, $2, 'A1', 'LINE', 'N_DUC_CBL', ST_GeomFromText('LINESTRING Z (0 0 0, 1 1 0)', 0))`,
    [project, general],
  );
  const secondary = await insertFile('secondary', project);
  return { project, pm: await loginAs(ctx, email, PASSWORD), general, secondary };
}

/** The placement is a frozen input: the worker sets it at build time; tests bypass the guard. */
async function setPlacement(id: string): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE design_revisions DISABLE TRIGGER design_revisions_immutable');
    await client.query('UPDATE design_revisions SET placement = $2::jsonb WHERE id = $1', [
      id,
      JSON.stringify(USED_PLACEMENT),
    ]);
    await client.query('ALTER TABLE design_revisions ENABLE TRIGGER design_revisions_immutable');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** The worker's end of a build: draft with counts (reading totals included) and a gallery. */
async function markDraft(revisionId: string, boxShapes: object | null = null): Promise<void> {
  await q(`UPDATE design_revisions SET status = 'building' WHERE id = $1`, [revisionId]);
  await q(
    `UPDATE design_revisions SET status = 'draft', built_at = now(), counts = $2::jsonb,
            text_link_counts = $3::jsonb, diff_counts = $4::jsonb, box_shapes = $5::jsonb
     WHERE id = $1`,
    [
      revisionId,
      JSON.stringify({
        features: { route: 1, box: 2, hhi: 0, joint: 0, mh: 0, cabinet: 0, ring: 0 },
        routeLengthM: '12.5',
        reading: READING,
      }),
      JSON.stringify({ auto: 0, review: 0, confirmed: 0, rejected: 0, unlinked: 0 }),
      JSON.stringify({
        added: 0,
        removed: 0,
        unchanged: 0,
        moved: 0,
        reshaped: 0,
        attributes_changed: 0,
        conflict: 0,
      }),
      boxShapes ? JSON.stringify(boxShapes) : null,
    ],
  );
  await setPlacement(revisionId);
}

async function draftOf(
  sc: Scenario,
  file: string,
  rules: object[],
  boxShapes: object | null = null,
): Promise<string> {
  const mapped = await as(sc.pm)(http().put(`${filesUrl(sc.project)}/${file}/mapping`)).send({
    rules,
    crsEpsg: 32636,
    drawingUnit: 'm',
    version: null,
  });
  expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
  const created = await as(sc.pm)(http().post(revisionsUrl(sc.project))).send({
    cadFileId: file,
    mappingVersion: mapped.body.version,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const id = created.body.id as string;
  await markDraft(id, boxShapes);
  return id;
}

const GALLERY = {
  version: 1,
  boxCount: 5,
  shapeCount: 1,
  shapes: [
    {
      shape: SHAPE_1,
      source: 'block',
      count: 5,
      blockNames: ['box c'],
      sampleHandles: ['A1'],
      preview: null,
    },
  ],
  boxesWithoutShape: 0,
};

const readiness = async (sc: Scenario, revision: string) => {
  await linkDrawingsToSite(ctx.pool, sc.project);
  return PublishReadinessSchema.parse(
    (await as(admin)(http().get(`${revisionsUrl(sc.project)}/${revision}/publish-readiness`))).body,
  );
};
const publish = async (sc: Scenario, revision: string) => {
  await linkDrawingsToSite(ctx.pool, sc.project);
  return as(admin)(http().post(`${revisionsUrl(sc.project)}/${revision}/publish`)).send({
    acknowledgeOpenItems: true,
  });
};

describe('installation question switched off', () => {
  it('is not asked, refuses writes like on a Secondary, and freezes nothing', async () => {
    const sc = await scenario();
    const state = await as(sc.pm)(http().get(`${filesUrl(sc.project)}/${sc.general}/installation`));
    expect(InstallationStateSchema.parse(state.body)).toMatchObject({
      drawingKind: 'general',
      asked: false,
      answer: null,
    });

    const answer = await as(sc.pm)(
      http().put(`${filesUrl(sc.project)}/${sc.general}/installation/answer`),
    ).send({ answer: 'pull_only' });
    expect(answer.status).toBe(409);
    expect(answer.body.details).toMatchObject({ reason: 'NOT_GENERAL_DRAWING' });
    const mark = await as(sc.pm)(
      http().post(`${filesUrl(sc.project)}/${sc.general}/installation/trench-marks`),
    ).send({ routeHandle: 'A1', lengthM: '1.000' });
    expect(mark.status).toBe(409);
    expect(mark.body.details).toMatchObject({ reason: 'NOT_GENERAL_DRAWING' });

    const revision = await draftOf(sc, sc.general, ROUTE_RULES);
    expect(
      (await q('SELECT installation FROM design_revisions WHERE id = $1', [revision])).rows[0]
        ?.installation,
    ).toBeNull();
    const report = await as(sc.pm)(
      http().get(`${revisionsUrl(sc.project)}/${revision}/installation`),
    );
    expect(InstallationReportSchema.parse(report.body)).toMatchObject({
      applies: false,
      ok: true,
      issueCount: 0,
    });
  });
});

describe('box types switched off', () => {
  it('shows no state, refuses choices like on a General, and freezes nothing', async () => {
    const sc = await scenario();
    const state = await as(sc.pm)(http().get(`${filesUrl(sc.project)}/${sc.secondary}/box-types`));
    expect(BoxTypeStateSchema.parse(state.body)).toMatchObject({ applies: false, active: [] });

    const choose = await as(sc.pm)(
      http().post(`${filesUrl(sc.project)}/${sc.secondary}/box-types`),
    ).send({ choices: [{ shape: SHAPE_1, workOrderLineId: null }] });
    expect(choose.status).toBe(409);
    expect(choose.body.details).toMatchObject({ reason: 'NOT_SECONDARY_DRAWING' });

    const revision = await draftOf(sc, sc.secondary, BOX_RULES, GALLERY);
    expect(
      (await q('SELECT box_types FROM design_revisions WHERE id = $1', [revision])).rows[0]
        ?.box_types,
    ).toBeNull();
    const report = await as(sc.pm)(http().get(`${revisionsUrl(sc.project)}/${revision}/box-types`));
    expect(BoxTypesReportSchema.parse(report.body)).toMatchObject({
      applies: false,
      ok: true,
      issueCount: 0,
    });
  });
});

describe('publishing with the steps switched off', () => {
  it('publishes the pair with no installation answer and no box-type choice', async () => {
    const sc = await scenario();
    const general = await draftOf(sc, sc.general, ROUTE_RULES);
    const secondary = await draftOf(sc, sc.secondary, BOX_RULES, GALLERY);
    for (const revision of [general, secondary]) {
      const ready = await readiness(sc, revision);
      expect(ready.switchedOff).toEqual(['installation', 'box_types']);
      expect(ready.checks.find((c) => c.key === 'installation')?.ok).toBe(true);
      expect(ready.checks.find((c) => c.key === 'box_types')?.ok).toBe(true);
      expect(ready.drawings.every((d) => d.installation === null)).toBe(true);
      expect(ready.drawings.every((d) => d.boxTypes === null)).toBe(true);
      expect(ready.canPublish).toBe(true);
    }
    const done = await publish(sc, general);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'published' });
  });

  it('still blocks a Secondary read without text roles (READING_ROLES_MISSING)', async () => {
    const sc = await scenario();
    const general = await draftOf(sc, sc.general, ROUTE_RULES);
    const legacy = await draftOf(sc, sc.secondary, ROUTE_RULES);
    const ready = await readiness(sc, legacy);
    expect(ready.switchedOff).toContain('box_types');
    expect(ready.checks.find((c) => c.key === 'box_types')).toMatchObject({ ok: false });
    expect(ready.canPublish).toBe(false);
    for (const target of [general, legacy]) {
      const blocked = await publish(sc, target);
      expect(blocked.status).toBe(409);
      expect(blocked.body.details).toMatchObject({
        reason: 'BOX_TYPES_UNCLEAR',
        issues: [{ code: 'READING_ROLES_MISSING' }],
      });
    }
  });
});

describe('reading totals switched off', () => {
  it('leaves counts.reading out of the revision responses, the rest unchanged', async () => {
    const sc = await scenario();
    const revision = await draftOf(sc, sc.general, ROUTE_RULES);
    const detail = await as(sc.pm)(http().get(`${revisionsUrl(sc.project)}/${revision}`));
    const parsed = DesignRevisionDetailSchema.parse(detail.body);
    expect(parsed.counts).toEqual({
      features: { route: 1, box: 2, hhi: 0, joint: 0, mh: 0, cabinet: 0, ring: 0 },
      routeLengthM: '12.5',
    });
    expect(detail.body.counts).not.toHaveProperty('reading');
    const list = await as(sc.pm)(http().get(revisionsUrl(sc.project)));
    for (const item of list.body.items as { counts: object | null }[]) {
      expect(item.counts ?? {}).not.toHaveProperty('reading');
    }
    // Stored data is kept untouched.
    const stored = await q('SELECT counts FROM design_revisions WHERE id = $1', [revision]);
    expect(stored.rows[0]?.counts).toHaveProperty('reading');
  });
});
