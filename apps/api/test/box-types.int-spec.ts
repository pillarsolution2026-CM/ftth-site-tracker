import { randomUUID } from 'node:crypto';
import {
  BoxTypeStateSchema,
  BoxTypesReportSchema,
  DesignRevisionDetailSchema,
  PublishReadinessSchema,
  type BoxShapeGallery,
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

/** ADR-043: box type by the drawn shape — the choices, the freeze, the check and publishing. */

let testRedis: TestRedis;
let redis: Redis;
let ctx: TestContext;
let admin: string;
let outsider: string;
let outsiderProject: string;

const PASSWORD = 'Box#Pass123';
const SHAPE_1 = `v1-${'1'.repeat(64)}`;
const SHAPE_2 = `v1-${'2'.repeat(64)}`;
const SHAPE_X = `v1-${'f'.repeat(64)}`;
const USED_PLACEMENT = {
  sourceCrs: 'project',
  points: [{ id: 'p1', drawing: { x: 1, y: 1 }, lat: 30.9, lon: 32.7, source: 'typed' }],
};
const BOX_RULES = [
  { source: 'layer', layer: 'BOXES', target: 'box', textRoles: ['box_cable_type'] },
];
const ROUTE_RULES = [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }];

beforeAll(async () => {
  testRedis = await startRedis();
  redis = new Redis(testRedis.url);
  ctx = await createTestContext(inject('databaseUrl'), { REDIS_URL: testRedis.url });
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
  const out = await newProject();
  outsiderProject = out.project;
  outsider = out.pm;
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

// ---------- data helpers (the worker's side of the contract is simulated with SQL) ----------

/** A project (with a work order of the lines L1 and L2 unless told otherwise) and its PM. */
async function newProject(
  withWorkOrder = true,
): Promise<{ project: string; pm: string; lines: Record<string, string> }> {
  let project: string;
  let lines: Record<string, string> = {};
  if (withWorkOrder) {
    const contract = await createApprovedContract(ctx.pool, [
      { code: 'L1', description: 'Box type L1   with\nsplitter', quantity: '1000' },
      { code: 'L2', description: 'Box type L2   with\nsplitter', quantity: '1000' },
    ]);
    project = await createProjectIn(ctx.pool, contract.contractId);
    lines = (await createWorkOrderFrom(ctx.pool, project, contract, { L1: '10', L2: '10' }))
      .itemIdsByCode;
  } else {
    project = await createProjectIn(ctx.pool, null);
  }
  const zone = (
    await q(`INSERT INTO zones (project_id, name) VALUES ($1, 'Z') RETURNING id`, [project])
  ).rows[0]?.id as string;
  const email = `box-pm-${project.slice(0, 8)}@ftth.local`;
  await ensureMember(ctx.pool, {
    email,
    password: PASSWORD,
    role: 'pm',
    projectId: project,
    zoneId: zone,
  });
  const supEmail = `box-sup-${project.slice(0, 8)}@ftth.local`;
  await ensureMember(ctx.pool, {
    email: supEmail,
    password: PASSWORD,
    role: 'supervisor',
    projectId: project,
    zoneId: zone,
  });
  return { project, pm: await loginAs(ctx, email, PASSWORD), lines };
}

async function insertFile(kind: 'general' | 'secondary', p: string): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                            status, current_job_id, ins_units, processed_at, drawing_kind)
     VALUES ($1, $2, $3, 'dxf', 100, repeat('a', 64), $4, 'processed', $5, 1, now(), $6)`,
    [
      id,
      p,
      `${kind}-${id.slice(0, 6)}.dxf`,
      `projects/${p}/cad/${id}/original.dxf`,
      randomUUID(),
      kind,
    ],
  );
  return id;
}

function galleryOf(
  shapes: [string, number][],
  extra: Partial<BoxShapeGallery> = {},
): BoxShapeGallery {
  return {
    version: 1,
    boxCount: shapes.reduce((n, [, count]) => n + count, 0),
    shapeCount: shapes.length,
    shapes: shapes.map(([shape, count]) => ({
      shape,
      source: 'block',
      count,
      blockNames: ['box c'],
      sampleHandles: ['A1'],
      preview: null,
    })),
    boxesWithoutShape: 0,
    ...extra,
  };
}

/** The placement is a frozen input: the worker sets it at build time; tests bypass the guard. */
async function setPlacement(id: string, value: object | null): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE design_revisions DISABLE TRIGGER design_revisions_immutable');
    await client.query('UPDATE design_revisions SET placement = $2::jsonb WHERE id = $1', [
      id,
      value ? JSON.stringify(value) : null,
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

/** The worker's end of a build: building, then draft with the gallery (inputs stay frozen). */
async function markDraft(revisionId: string, gallery: BoxShapeGallery | null): Promise<void> {
  await q(`UPDATE design_revisions SET status = 'building' WHERE id = $1`, [revisionId]);
  await q(
    `UPDATE design_revisions SET status = 'draft', built_at = now(), counts = '{}'::jsonb,
            text_link_counts = $2::jsonb, diff_counts = $3::jsonb, box_shapes = $4::jsonb
     WHERE id = $1`,
    [
      revisionId,
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
      gallery ? JSON.stringify(gallery) : null,
    ],
  );
  await setPlacement(revisionId, USED_PLACEMENT);
}

interface Scenario {
  project: string;
  pm: string;
  lines: Record<string, string>;
  general: string;
  secondary: string;
}

/** A project with a work order (lines L1, L2), a General (answered) and a Secondary file. */
async function scenario(options: { withWorkOrder?: boolean } = {}): Promise<Scenario> {
  const { project, pm, lines } = await newProject(options.withWorkOrder !== false);
  const general = await insertFile('general', project);
  await q(
    `INSERT INTO cad_curves (project_id, cad_file_id, handle, entity_type, layer, geom)
           VALUES ($1, $2, 'A1', 'LINE', 'N_DUC_CBL', ST_GeomFromText('LINESTRING Z (0 0 0, 1 1 0)', 0))`,
    [project, general],
  );
  const secondary = await insertFile('secondary', project);
  const answered = await as(pm)(
    http().put(`${filesUrl(project)}/${general}/installation/answer`),
  ).send({
    answer: 'pull_only',
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return { project, pm, lines, general, secondary };
}

async function saveMapping(sc: Scenario, file: string, rules: object[]): Promise<number> {
  const res = await as(sc.pm)(http().put(`${filesUrl(sc.project)}/${file}/mapping`)).send({
    rules,
    crsEpsg: 32636,
    drawingUnit: 'm',
    version: null,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.version as number;
}

async function createRevision(sc: Scenario, file: string, version: number): Promise<string> {
  const res = await as(sc.pm)(http().post(revisionsUrl(sc.project))).send({
    cadFileId: file,
    mappingVersion: version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return res.body.id as string;
}

/** The Secondary (roles mode) built as a draft with a gallery of SHAPE_1 x150 and SHAPE_2 x47. */
async function secondaryDraft(
  sc: Scenario,
  gallery = galleryOf([
    [SHAPE_1, 150],
    [SHAPE_2, 47],
  ]),
) {
  const version = await saveMapping(sc, sc.secondary, BOX_RULES);
  const revision = await createRevision(sc, sc.secondary, version);
  await markDraft(revision, gallery);
  return { revision, version };
}

async function generalDraft(sc: Scenario): Promise<string> {
  const version = await saveMapping(sc, sc.general, ROUTE_RULES);
  const revision = await createRevision(sc, sc.general, version);
  await markDraft(revision, null);
  return revision;
}

const boxUrl = (sc: Scenario, file: string) => `${filesUrl(sc.project)}/${file}/box-types`;
const choose = (
  sc: Scenario,
  choices: { shape: string; workOrderLineId: string | null }[],
  options: { file?: string; token?: string; fromPreviousVersion?: boolean } = {},
) =>
  as(options.token ?? sc.pm)(http().post(boxUrl(sc, options.file ?? sc.secondary))).send({
    choices,
    ...(options.fromPreviousVersion ? { fromPreviousVersion: true } : {}),
  });
const getState = (sc: Scenario, file = sc.secondary, token = sc.pm) =>
  as(token)(http().get(boxUrl(sc, file)));
const report = async (sc: Scenario, revision: string) =>
  BoxTypesReportSchema.parse(
    (await as(sc.pm)(http().get(`${revisionsUrl(sc.project)}/${revision}/box-types`))).body,
  );
const readiness = async (sc: Scenario, revision: string) =>
  PublishReadinessSchema.parse(
    (await as(admin)(http().get(`${revisionsUrl(sc.project)}/${revision}/publish-readiness`))).body,
  );
const publish = (sc: Scenario, revision: string) =>
  as(admin)(http().post(`${revisionsUrl(sc.project)}/${revision}/publish`)).send({
    acknowledgeOpenItems: true,
  });
const rebuild = async (sc: Scenario, revision: string, version: number): Promise<string> => {
  const res = await as(sc.pm)(http().post(`${revisionsUrl(sc.project)}/${revision}/rebuild`)).send({
    mappingVersion: version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return res.body.id as string;
};

// ---------------------------------------------------------------------------------------------

describe('migration 0023 constraints and triggers', () => {
  it('accepts choices of a Secondary only (trigger)', async () => {
    const sc = await scenario();
    await expect(
      q(
        `INSERT INTO cad_file_box_type_choices (id, project_id, cad_file_id, shape_signature, work_order_item_id)
         VALUES ($1, $2, $3, $4, NULL)`,
        [randomUUID(), sc.project, sc.general, SHAPE_1],
      ),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('accepts a line of the same project only (trigger), and a null line (cleared)', async () => {
    const sc = await scenario();
    const other = await scenario();
    const insert = (line: string | null, shape = SHAPE_1) =>
      q(
        `INSERT INTO cad_file_box_type_choices (id, project_id, cad_file_id, shape_signature, work_order_item_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), sc.project, sc.secondary, shape, line],
      );
    await expect(insert(other.lines.L1 ?? null)).rejects.toMatchObject({ code: '23001' });
    await expect(insert(randomUUID())).rejects.toMatchObject({ code: '23001' });
    await insert(sc.lines.L1 ?? null);
    await insert(null, SHAPE_2);
  });

  it('checks the shape format', async () => {
    const sc = await scenario();
    await expect(
      q(
        `INSERT INTO cad_file_box_type_choices (id, project_id, cad_file_id, shape_signature)
         VALUES ($1, $2, $3, 'not-a-shape')`,
        [randomUUID(), sc.project, sc.secondary],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      q(`UPDATE cad_inserts SET shape_signature = 'nope' WHERE false`),
    ).resolves.toBeDefined();
    await expect(
      q(
        `INSERT INTO cad_inserts (project_id, cad_file_id, handle, layer, block_name, position, shape_signature)
         VALUES ($1, $2, 'H1', 'BOXES', 'b', ST_GeomFromText('POINT Z (0 0 0)', 0), 'nope')`,
        [sc.project, sc.secondary],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await q(
      `INSERT INTO cad_inserts (project_id, cad_file_id, handle, layer, block_name, position, shape_signature)
       VALUES ($1, $2, 'H1', 'BOXES', 'b', ST_GeomFromText('POINT Z (0 0 0)', 0), $3)`,
      [sc.project, sc.secondary, SHAPE_1],
    );
    await q(
      `INSERT INTO cad_file_shapes (project_id, cad_file_id, shape_signature, insert_count)
       VALUES ($1, $2, $3, 1)`,
      [sc.project, sc.secondary, SHAPE_1],
    );
  });

  it('keeps the choices append-only: no update, delete or truncate', async () => {
    const sc = await scenario();
    const id = randomUUID();
    await q(
      `INSERT INTO cad_file_box_type_choices (id, project_id, cad_file_id, shape_signature, work_order_item_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, sc.project, sc.secondary, SHAPE_1, sc.lines.L1],
    );
    await expect(
      q(`UPDATE cad_file_box_type_choices SET work_order_item_id = NULL WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      q(`DELETE FROM cad_file_box_type_choices WHERE id = $1`, [id]),
    ).rejects.toMatchObject({
      code: '23001',
    });
    await expect(q(`TRUNCATE cad_file_box_type_choices`)).rejects.toMatchObject({ code: '23001' });
  });

  it('allows the shape gallery only on a Secondary revision, and freezes box_types', async () => {
    const sc = await scenario();
    const general = await generalDraft(sc);
    await expect(
      q(`UPDATE design_revisions SET box_shapes = '{}'::jsonb WHERE id = $1`, [general]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      q(`UPDATE design_revisions SET box_types = '{"choices":[]}'::jsonb WHERE id = $1`, [general]),
    ).rejects.toThrow();
    const { revision } = await secondaryDraft(sc);
    await expect(
      q(`UPDATE design_revisions SET box_types = '{"choices":[{"x":1}]}'::jsonb WHERE id = $1`, [
        revision,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    // The gallery is a build output, not a frozen input.
    await q(`UPDATE design_revisions SET box_shapes = $2::jsonb WHERE id = $1`, [
      revision,
      JSON.stringify(galleryOf([[SHAPE_1, 1]])),
    ]);
  });
});

describe('choosing box types', () => {
  it('runs the lifecycle: unset, batch, change, clear, no-op', async () => {
    const sc = await scenario();
    await secondaryDraft(sc);
    const first = BoxTypeStateSchema.parse((await getState(sc)).body);
    expect(first).toMatchObject({
      drawingKind: 'secondary',
      applies: true,
      active: [],
      history: [],
    });
    expect(first.previousVersion).toBeNull();

    const res = await choose(sc, [
      { shape: SHAPE_1, workOrderLineId: sc.lines.L1 ?? '' },
      { shape: SHAPE_2, workOrderLineId: sc.lines.L2 ?? '' },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const state = BoxTypeStateSchema.parse(res.body);
    expect(state.active.map((c) => [c.shape, c.workOrderLineId])).toEqual(
      expect.arrayContaining([
        [SHAPE_1, sc.lines.L1],
        [SHAPE_2, sc.lines.L2],
      ]),
    );
    expect(state.history).toHaveLength(2);
    expect(state.history[0]?.createdBy?.id).toBeTruthy();

    // The same choice writes nothing; a change appends; null clears.
    expect(
      BoxTypeStateSchema.parse(
        (await choose(sc, [{ shape: SHAPE_1, workOrderLineId: sc.lines.L1 ?? '' }])).body,
      ).history,
    ).toHaveLength(2);
    const changed = BoxTypeStateSchema.parse(
      (await choose(sc, [{ shape: SHAPE_1, workOrderLineId: sc.lines.L2 ?? '' }])).body,
    );
    expect(changed.history).toHaveLength(3);
    const cleared = BoxTypeStateSchema.parse(
      (await choose(sc, [{ shape: SHAPE_1, workOrderLineId: null }], { fromPreviousVersion: true }))
        .body,
    );
    expect(cleared.history).toHaveLength(4);
    expect(cleared.active.map((c) => c.shape)).toEqual([SHAPE_2]);

    const events = await q(
      `SELECT payload FROM events WHERE project_id = $1 AND type = 'box_type_choice.chosen' ORDER BY id`,
      [sc.project],
    );
    expect(events.rows).toHaveLength(4);
    expect(events.rows[3]?.payload).toEqual({
      cadFileId: sc.secondary,
      shape: SHAPE_1,
      workOrderLineId: null,
      previousWorkOrderLineId: sc.lines.L2,
      fromPreviousVersion: true,
    });
  });

  it('offers the previous version choices and applies them only when asked', async () => {
    const sc = await scenario();
    await secondaryDraft(sc);
    await choose(sc, [{ shape: SHAPE_1, workOrderLineId: sc.lines.L1 ?? '' }]);
    const next = await insertFile('secondary', sc.project);
    await q(`UPDATE cad_files SET superseded_at = now(), superseded_by = $2 WHERE id = $1`, [
      sc.secondary,
      next,
    ]);
    const state = BoxTypeStateSchema.parse((await getState(sc, next)).body);
    expect(state.active).toEqual([]);
    expect(state.previousVersion).toEqual({
      cadFileId: sc.secondary,
      choices: [{ shape: SHAPE_1, workOrderLineId: sc.lines.L1 }],
    });
    // The old version is closed to new choices.
    const refused = await choose(sc, [{ shape: SHAPE_1, workOrderLineId: null }]);
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({ reason: 'FILE_SUPERSEDED' });
  });

  it('refuses a General, an unbuilt file, unknown shapes, a missing work order and foreign lines', async () => {
    const sc = await scenario();
    const onGeneral = await choose(sc, [{ shape: SHAPE_1, workOrderLineId: sc.lines.L1 ?? '' }], {
      file: sc.general,
    });
    expect(onGeneral.status).toBe(409);
    expect(onGeneral.body.details).toMatchObject({ reason: 'NOT_SECONDARY_DRAWING' });
    const generalState = BoxTypeStateSchema.parse((await getState(sc, sc.general)).body);
    expect(generalState).toMatchObject({ applies: false, active: [], history: [] });

    const unbuilt = await choose(sc, [{ shape: SHAPE_1, workOrderLineId: sc.lines.L1 ?? '' }]);
    expect(unbuilt.status).toBe(409);
    expect(unbuilt.body.details).toMatchObject({ reason: 'NOT_BUILT' });

    await secondaryDraft(sc);
    const unknown = await choose(sc, [
      { shape: SHAPE_1, workOrderLineId: sc.lines.L1 ?? '' },
      { shape: SHAPE_X, workOrderLineId: sc.lines.L1 ?? '' },
    ]);
    expect(unknown.status).toBe(422);
    expect(unknown.body.details).toMatchObject({ reason: 'SHAPE_NOT_FOUND', shapes: [SHAPE_X] });

    const foreign = (await scenario()).lines.L1 ?? '';
    const bad = await choose(sc, [{ shape: SHAPE_1, workOrderLineId: foreign }]);
    expect(bad.status).toBe(422);
    expect(bad.body.details).toMatchObject({
      reason: 'LINE_NOT_IN_WORK_ORDER',
      workOrderLineIds: [foreign],
    });
    const unknownLine = randomUUID();
    expect(
      (await choose(sc, [{ shape: SHAPE_1, workOrderLineId: unknownLine }])).body.details,
    ).toMatchObject({ reason: 'LINE_NOT_IN_WORK_ORDER' });
    // Nothing was written by any refusal.
    expect(BoxTypeStateSchema.parse((await getState(sc)).body).history).toEqual([]);

    const noOrder = await scenario({ withWorkOrder: false });
    await secondaryDraft(noOrder);
    const none = await choose(noOrder, [{ shape: SHAPE_1, workOrderLineId: sc.lines.L1 ?? '' }]);
    expect(none.status).toBe(409);
    expect(none.body.details).toMatchObject({ reason: 'NO_WORK_ORDER' });
  });

  it('checks permissions and validates the body', async () => {
    const sc = await scenario();
    await secondaryDraft(sc);
    const sup = await loginAs(ctx, `box-sup-${sc.project.slice(0, 8)}@ftth.local`, PASSWORD);
    const body = [{ shape: SHAPE_1, workOrderLineId: sc.lines.L1 ?? '' }];
    expect((await choose(sc, body, { token: sup })).status).toBe(403);
    expect(
      (await as(sc.pm)(http().post(boxUrl(sc, sc.secondary))).send({ choices: [] })).status,
    ).toBe(400);
    expect(
      (
        await as(sc.pm)(http().post(boxUrl(sc, sc.secondary))).send({
          choices: [
            { shape: SHAPE_1, workOrderLineId: null },
            { shape: SHAPE_1, workOrderLineId: null },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await http().get(boxUrl(sc, sc.secondary))).status).toBe(401);
  });

  it('scopes everything to the project (another project sees 404)', async () => {
    const sc = await scenario();
    const { revision } = await secondaryDraft(sc);
    const url = (suffix: string) => `/projects/${outsiderProject}/${suffix}`;
    expect(
      (await as(outsider)(http().get(url(`cad-files/${sc.secondary}/box-types`)))).status,
    ).toBe(404);
    expect(
      (
        await as(outsider)(http().post(url(`cad-files/${sc.secondary}/box-types`))).send({
          choices: [{ shape: SHAPE_1, workOrderLineId: null }],
        })
      ).status,
    ).toBe(404);
    expect(
      (await as(outsider)(http().get(url(`design-revisions/${revision}/box-types`)))).status,
    ).toBe(404);
    // And the project's own PM cannot reach the outsider's project.
    expect(
      (
        await as(sc.pm)(
          http().get(`/projects/${outsiderProject}/cad-files/${sc.secondary}/box-types`),
        )
      ).status,
    ).toBe(403);
  });
});

describe('freezing on the design revision', () => {
  it('freezes the choices in force with the line snapshot, and again at a rebuild', async () => {
    const sc = await scenario();
    const first = await secondaryDraft(sc);
    // Nothing chosen yet: the first revision froze an empty list.
    expect(
      (await q('SELECT box_types FROM design_revisions WHERE id = $1', [first.revision])).rows[0]
        ?.box_types,
    ).toEqual({ choices: [] });

    await choose(sc, [{ shape: SHAPE_1, workOrderLineId: sc.lines.L1 ?? '' }]);
    const afterChoice = await report(sc, first.revision);
    expect(afterChoice.changedSinceBuild).toBe(true);

    const rebuilt = await rebuild(sc, first.revision, first.version);
    const stored = (await q('SELECT box_types FROM design_revisions WHERE id = $1', [rebuilt]))
      .rows[0]?.box_types as {
      choices: { shape: string; workOrderLineId: string; line: object }[];
    };
    expect(stored.choices).toHaveLength(1);
    expect(stored.choices[0]).toMatchObject({
      shape: SHAPE_1,
      workOrderLineId: sc.lines.L1,
      line: {
        code: 'L1',
        description: expect.stringContaining('Box type L1'),
        label: 'Box type L1 with splitter',
      },
    });
    const detail = await as(sc.pm)(http().get(`${revisionsUrl(sc.project)}/${rebuilt}`));
    expect(DesignRevisionDetailSchema.parse(detail.body).boxTypes).toEqual(stored);

    // A later choice does not touch the frozen revision.
    await markDraft(
      rebuilt,
      galleryOf([
        [SHAPE_1, 150],
        [SHAPE_2, 47],
      ]),
    );
    await choose(sc, [{ shape: SHAPE_2, workOrderLineId: sc.lines.L2 ?? '' }]);
    expect(
      (await q('SELECT box_types FROM design_revisions WHERE id = $1', [rebuilt])).rows[0]
        ?.box_types,
    ).toEqual(stored);
    expect((await report(sc, rebuilt)).changedSinceBuild).toBe(true);
  });

  it('freezes nothing on a General or in legacy reading mode', async () => {
    const sc = await scenario();
    const general = await generalDraft(sc);
    expect(
      (await q('SELECT box_types FROM design_revisions WHERE id = $1', [general])).rows[0]
        ?.box_types,
    ).toBeNull();
    const detail = await as(sc.pm)(http().get(`${revisionsUrl(sc.project)}/${general}`));
    expect(DesignRevisionDetailSchema.parse(detail.body).boxTypes).toBeNull();
    expect(await report(sc, general)).toMatchObject({ applies: false, ok: true, issueCount: 0 });

    const legacy = await scenario();
    const version = await saveMapping(legacy, legacy.secondary, ROUTE_RULES);
    const revision = await createRevision(legacy, legacy.secondary, version);
    expect(
      (await q('SELECT box_types FROM design_revisions WHERE id = $1', [revision])).rows[0]
        ?.box_types,
    ).toBeNull();
    // ADR-043 L3: a Secondary without text roles is an error, not "not applicable".
    expect(await report(legacy, revision)).toMatchObject({
      applies: true,
      ok: false,
      issueCount: 1,
      issues: [{ code: 'READING_ROLES_MISSING' }],
      totals: null,
    });
  });
});

describe('readiness and publishing (BOX_TYPES_UNCLEAR)', () => {
  /** General + Secondary drafts of a scenario, ready except for the box types. */
  async function pairOf(sc: Scenario) {
    const general = await generalDraft(sc);
    const secondary = await secondaryDraft(sc);
    return { general, secondary };
  }

  it('blocks a shape with no type, lists it, and publishes once every shape has a line', async () => {
    const sc = await scenario();
    const { general, secondary } = await pairOf(sc);

    const ready = await readiness(sc, secondary.revision);
    expect(ready.checks.at(-1)).toEqual({ key: 'box_types', ok: false, count: 2 });
    expect(ready.boxTypes).toMatchObject({
      applies: true,
      issueCount: 2,
      issues: [
        { code: 'BOX_TYPE_UNSET', shape: SHAPE_1, boxCount: 150 },
        { code: 'BOX_TYPE_UNSET', shape: SHAPE_2, boxCount: 47 },
      ],
    });
    expect(ready.canPublish).toBe(false);
    // The General: its own box_types is ok (null), but the Secondary's is part of other_drawing.
    const generalReady = await readiness(sc, general);
    expect(generalReady.checks.find((c) => c.key === 'box_types')).toEqual({
      key: 'box_types',
      ok: true,
      count: null,
    });
    expect(generalReady.boxTypes).toBeNull();
    expect(generalReady.checks.find((c) => c.key === 'other_drawing')?.ok).toBe(false);

    const blocked = await publish(sc, general);
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toMatchObject({
      reason: 'BOX_TYPES_UNCLEAR',
      drawingKind: 'secondary',
      issueCount: 2,
    });

    await choose(sc, [
      { shape: SHAPE_1, workOrderLineId: sc.lines.L1 ?? '' },
      { shape: SHAPE_2, workOrderLineId: sc.lines.L1 ?? '' },
    ]);
    // Still blocked until the rebuild freezes the choices.
    expect((await publish(sc, general)).status).toBe(409);
    const rebuilt = await rebuild(sc, secondary.revision, secondary.version);
    await markDraft(
      rebuilt,
      galleryOf([
        [SHAPE_1, 150],
        [SHAPE_2, 47],
      ]),
    );

    const clear = await report(sc, rebuilt);
    expect(clear).toMatchObject({ ok: true, issueCount: 0, changedSinceBuild: false });
    expect(clear.totals).toEqual([
      {
        workOrderLineId: sc.lines.L1,
        code: 'L1',
        label: 'Box type L1 with splitter',
        boxCount: 197,
        shapes: [SHAPE_1, SHAPE_2],
      },
    ]);
    expect((await readiness(sc, rebuilt)).checks.at(-1)).toEqual({
      key: 'box_types',
      ok: true,
      count: 0,
    });
    const done = await publish(sc, general);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'published' });
    // After publishing the report is history: no change since the build is reported.
    expect((await report(sc, rebuilt)).changedSinceBuild).toBe(false);
  });

  it('blocks a chosen line that was removed after the build (BOX_TYPE_LINE_MISSING)', async () => {
    const sc = await scenario();
    const general = await generalDraft(sc);
    const first = await secondaryDraft(sc);
    await choose(sc, [
      { shape: SHAPE_1, workOrderLineId: sc.lines.L1 ?? '' },
      { shape: SHAPE_2, workOrderLineId: sc.lines.L2 ?? '' },
    ]);
    const rebuilt = await rebuild(sc, first.revision, first.version);
    await markDraft(
      rebuilt,
      galleryOf([
        [SHAPE_1, 150],
        [SHAPE_2, 47],
      ]),
    );
    expect((await report(sc, rebuilt)).ok).toBe(true);

    await q('DELETE FROM work_order_items WHERE id = $1', [sc.lines.L2]);
    const broken = await report(sc, rebuilt);
    expect(broken).toMatchObject({
      ok: false,
      totals: null,
      issues: [{ code: 'BOX_TYPE_LINE_MISSING', shape: SHAPE_2, workOrderLineId: sc.lines.L2 }],
    });
    const blocked = await publish(sc, general);
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toMatchObject({
      reason: 'BOX_TYPES_UNCLEAR',
      issues: [{ code: 'BOX_TYPE_LINE_MISSING' }],
    });
  });

  it('reports a revision with no gallery, boxes without a shape and too many shapes', async () => {
    const sc = await scenario();
    const first = await secondaryDraft(sc, galleryOf([[SHAPE_1, 5]], { boxesWithoutShape: 3 }));
    expect((await report(sc, first.revision)).issues.map((i) => i.code)).toEqual([
      'BOX_SHAPE_UNKNOWN',
      'BOX_TYPE_UNSET',
    ]);
    await q(`UPDATE design_revisions SET box_shapes = NULL WHERE id = $1`, [first.revision]);
    expect((await report(sc, first.revision)).issues.map((i) => i.code)).toEqual([
      'BOX_SHAPES_NOT_READ',
    ]);
    await q(`UPDATE design_revisions SET box_shapes = $2::jsonb WHERE id = $1`, [
      first.revision,
      JSON.stringify(galleryOf([[SHAPE_1, 5]], { shapeCount: 201 })),
    ]);
    expect((await report(sc, first.revision)).issues.map((i) => i.code)).toEqual([
      'BOX_SHAPES_TOO_MANY',
      'BOX_TYPE_UNSET',
    ]);
  });

  it('refuses a Secondary mapped without text roles (READING_ROLES_MISSING), also via the General', async () => {
    const sc = await scenario();
    const general = await generalDraft(sc);
    const version = await saveMapping(sc, sc.secondary, ROUTE_RULES);
    const legacy = await createRevision(sc, sc.secondary, version);
    await markDraft(legacy, null);
    const ready = await readiness(sc, legacy);
    expect(ready.checks.at(-1)).toEqual({ key: 'box_types', ok: false, count: 1 });
    expect(ready.canPublish).toBe(false);
    expect((await readiness(sc, general)).checks.find((c) => c.key === 'other_drawing')?.ok).toBe(
      false,
    );
    for (const target of [general, legacy]) {
      const blocked = await publish(sc, target);
      expect(blocked.status).toBe(409);
      expect(blocked.body.details).toMatchObject({
        reason: 'BOX_TYPES_UNCLEAR',
        drawingKind: 'secondary',
        issueCount: 1,
        issues: [{ code: 'READING_ROLES_MISSING' }],
      });
    }
  });

  it('reports a missing work order', async () => {
    const sc = await scenario({ withWorkOrder: false });
    const { revision } = await secondaryDraft(sc);
    expect((await report(sc, revision)).issues.map((i) => i.code)).toEqual([
      'WORK_ORDER_MISSING',
      'BOX_TYPE_UNSET',
      'BOX_TYPE_UNSET',
    ]);
  });
});
