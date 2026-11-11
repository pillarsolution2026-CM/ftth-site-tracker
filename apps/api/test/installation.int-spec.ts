import { randomUUID } from 'node:crypto';
import {
  DesignRevisionDetailSchema,
  InstallationAnswerRecordSchema,
  InstallationReportSchema,
  InstallationStateSchema,
  PublishReadinessSchema,
  RouteReadingSchema,
  SecondaryPlacementSuggestionSchema,
  TrenchMarkSchema,
} from '@ftth/shared';
import { createProjectCrs } from '@ftth/geo';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ensureMember, loginAs, SEED_LOGINS } from './support/helpers.js';
import { startRedis, type TestRedis } from './support/redis.js';
import { createTestContext, type TestContext } from './support/test-app.js';

/** ADR-042: the General's installation question, trench marks and the automatic Secondary placement. */

let testRedis: TestRedis;
let redis: Redis;
let ctx: TestContext;
let project: string;
let otherProject: string;
let admin: string;
let pm: string;
let supervisor: string;
let contractor: string;
let otherPm: string;

const USED_PLACEMENT = {
  sourceCrs: 'project',
  points: [{ id: 'p1', drawing: { x: 1, y: 1 }, lat: 30.9, lon: 32.7, source: 'typed' }],
};
const E0 = 330000;
const N0 = 3330000;

beforeAll(async () => {
  testRedis = await startRedis();
  redis = new Redis(testRedis.url);
  ctx = await createTestContext(inject('databaseUrl'), { REDIS_URL: testRedis.url });
  const make = async (label: string) =>
    (
      await ctx.pool.query<{ id: string }>(
        `INSERT INTO projects (name, client, crs_epsg, currency, locale)
         VALUES ($1, 'WE', 32636, 'EGP', 'ar') RETURNING id`,
        [`Installation ${label} ${randomUUID()}`],
      )
    ).rows[0]?.id ?? '';
  project = await make('A');
  otherProject = await make('B');
  const zoneOf = async (p: string) =>
    (
      await ctx.pool.query<{ id: string }>(
        `INSERT INTO zones (project_id, name) VALUES ($1, 'Sector 1') RETURNING id`,
        [p],
      )
    ).rows[0]?.id ?? '';
  const zone = await zoneOf(project);
  const otherZone = await zoneOf(otherProject);
  const member = (email: string, role: 'pm' | 'supervisor' | 'contractor') =>
    ensureMember(ctx.pool, {
      email,
      password: 'Inst#Pass123',
      role,
      projectId: project,
      zoneId: zone,
    });
  await member('inst-pm@ftth.local', 'pm');
  await member('inst-sup@ftth.local', 'supervisor');
  await member('inst-con@ftth.local', 'contractor');
  await ensureMember(ctx.pool, {
    email: 'inst-other-pm@ftth.local',
    password: 'Inst#Pass123',
    role: 'pm',
    projectId: otherProject,
    zoneId: otherZone,
  });
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
  pm = await loginAs(ctx, 'inst-pm@ftth.local', 'Inst#Pass123');
  supervisor = await loginAs(ctx, 'inst-sup@ftth.local', 'Inst#Pass123');
  contractor = await loginAs(ctx, 'inst-con@ftth.local', 'Inst#Pass123');
  otherPm = await loginAs(ctx, 'inst-other-pm@ftth.local', 'Inst#Pass123');
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  redis?.disconnect();
  await testRedis?.stop();
});

const http = () => request(ctx.app.getHttpServer());
const as = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
const filesUrl = (p = project) => `/projects/${p}/cad-files`;
const revisionsUrl = (p = project) => `/projects/${p}/design-revisions`;
const installUrl = (file: string, p = project) => `${filesUrl(p)}/${file}/installation`;
const q = (text: string, values: unknown[] = []) => ctx.pool.query(text, values);

// ---------- data helpers (the worker's side of the contract is simulated with SQL) ----------

async function newProject(): Promise<string> {
  return (
    (
      await q(
        `INSERT INTO projects (name, client, crs_epsg, currency, locale)
         VALUES ($1, 'WE', 32636, 'EGP', 'ar') RETURNING id`,
        [`Installation ${randomUUID()}`],
      )
    ).rows[0]?.id ?? ''
  );
}

async function insertFile(
  kind: 'general' | 'secondary' = 'general',
  p = project,
  status: 'processed' | 'uploaded' = 'processed',
): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                            status, current_job_id, ins_units, processed_at, drawing_kind)
     VALUES ($1, $2, $3, 'dxf', 100, repeat('a', 64), $4, $5, $6, 1, $7, $8)`,
    [
      id,
      p,
      `${kind}-${id.slice(0, 6)}.dxf`,
      `projects/${p}/cad/${id}/original.dxf`,
      status,
      status === 'uploaded' ? null : randomUUID(),
      status === 'processed' ? new Date() : null,
      kind,
    ],
  );
  return id;
}

async function insertCurves(fileId: string, handles: string[], p = project): Promise<void> {
  for (const handle of handles) {
    await q(
      `INSERT INTO cad_curves (project_id, cad_file_id, handle, entity_type, layer, geom)
       VALUES ($1, $2, $3, 'LINE', 'N_DUC_CBL', ST_GeomFromText('LINESTRING Z (0 0 0, 1 1 0)', 0))`,
      [p, fileId, handle],
    );
  }
}

/** A processed General with the curves C1 and C2. */
async function generalWithCurves(p = project): Promise<string> {
  const id = await insertFile('general', p);
  await insertCurves(id, ['C1', 'C2'], p);
  return id;
}

const answer = (fileId: string, value: string, token = pm) =>
  as(token)(http().put(`${installUrl(fileId)}/answer`)).send({ answer: value });
const addMark = (fileId: string, routeHandle: string, lengthM: string, token = pm) =>
  as(token)(http().post(`${installUrl(fileId)}/trench-marks`)).send({ routeHandle, lengthM });
const withdrawMark = (fileId: string, markId: string, token = pm) =>
  as(token)(http().post(`${installUrl(fileId)}/trench-marks/${markId}/withdraw`));
const getState = (fileId: string, token = pm, p = project) =>
  as(token)(http().get(installUrl(fileId, p)));

const saveMapping = (fileId: string, placement: object | null = null, p = project) =>
  as(pm)(http().put(`${filesUrl(p)}/${fileId}/mapping`)).send({
    rules: [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }],
    crsEpsg: 32636,
    drawingUnit: 'm',
    version: null,
    placement,
  });

const createRevision = (fileId: string, mappingVersion: number, p = project) =>
  as(pm)(http().post(revisionsUrl(p))).send({ cadFileId: fileId, mappingVersion });

/** The worker's end of a build: building, then draft (inputs stay frozen). */
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

async function markDraft(revisionId: string, placement: object | null = USED_PLACEMENT) {
  await q(`UPDATE design_revisions SET status = 'building' WHERE id = $1`, [revisionId]);
  await q(
    `UPDATE design_revisions SET status = 'draft', built_at = now(), counts = '{}'::jsonb,
            text_link_counts = $2::jsonb, diff_counts = $3::jsonb
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
    ],
  );
  await setPlacement(revisionId, placement);
}

async function insertFeature(
  revision: string,
  p: string,
  type: 'route' | 'cabinet',
  handle: string,
  options: { code?: string | null; attrs?: object; point?: [number, number] } = {},
): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO features (id, project_id, feature_type, first_revision_id) VALUES ($1, $2, $3, $4)`,
    [id, p, type, revision],
  );
  const [x, y] = options.point ?? [E0, N0];
  const geom =
    type === 'route'
      ? `ST_SetSRID(ST_GeomFromText('LINESTRING Z (${x} ${y} 0, ${x + 50} ${y} 0)'), 32636)`
      : `ST_SetSRID(ST_MakePoint(${x}, ${y}), 32636)`;
  await q(
    `INSERT INTO design_features (revision_id, feature_id, project_id, feature_type, code, layer,
                                  source_kind, source_handle, geom, attrs)
     VALUES ($1, $2, $3, $4, $5, 'L', $6, $7, ${geom}, $8::jsonb)`,
    [
      revision,
      id,
      p,
      type,
      options.code ?? null,
      type === 'route' ? 'curve' : 'insert',
      handle,
      JSON.stringify(options.attrs ?? {}),
    ],
  );
  return id;
}

const routeAttrs = (writtenLengthM: string | null) => ({
  reading: RouteReadingSchema.parse({
    of: 'route',
    ways: null,
    labelWays: null,
    ductSize: null,
    writtenLengthM,
    cableCores: null,
    cableLengthM: null,
    spareCores: null,
    spares: [],
    connectors: null,
    texts: {},
  }),
});

interface Pair {
  project: string;
  general: { file: string; revision: string };
  secondary: { file: string; revision: string };
}

/**
 * A fresh project with a General and a Secondary, both built (draft) and placed, ready to publish;
 * the General's installation is answered with `answer` BEFORE its revision is created.
 */
async function pair(answerValue: 'pull_only' | 'has_trench' | null): Promise<Pair> {
  const p = await newProject();
  const zone = (await q(`INSERT INTO zones (project_id, name) VALUES ($1, 'Z') RETURNING id`, [p]))
    .rows[0]?.id as string;
  await ensureMember(ctx.pool, {
    email: `inst-pair-${p.slice(0, 8)}@ftth.local`,
    password: 'Inst#Pass123',
    role: 'pm',
    projectId: p,
    zoneId: zone,
  });
  const token = await loginAs(ctx, `inst-pair-${p.slice(0, 8)}@ftth.local`, 'Inst#Pass123');
  const gFile = await insertFile('general', p);
  await insertCurves(gFile, ['A1', 'B2'], p);
  if (answerValue) {
    const res = await as(token)(
      http()
        .put(`${installUrl(gFile, p)}/answer`)
        .send({ answer: answerValue }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  const sFile = await insertFile('secondary', p);
  const build = async (file: string) => {
    const saved = await as(token)(http().put(`${filesUrl(p)}/${file}/mapping`)).send({
      rules: [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }],
      crsEpsg: 32636,
      drawingUnit: 'm',
      version: null,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const created = await as(token)(http().post(revisionsUrl(p))).send({
      cadFileId: file,
      mappingVersion: saved.body.version,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    return created.body.id as string;
  };
  const gRev = await build(gFile);
  const sRev = await build(sFile);
  await markDraft(gRev);
  await markDraft(sRev);
  return {
    project: p,
    general: { file: gFile, revision: gRev },
    secondary: { file: sFile, revision: sRev },
  };
}

const readiness = async (pr: Pair, revision: string) =>
  PublishReadinessSchema.parse(
    (await as(admin)(http().get(`${revisionsUrl(pr.project)}/${revision}/publish-readiness`))).body,
  );
const publish = (pr: Pair, revision: string) =>
  as(admin)(http().post(`${revisionsUrl(pr.project)}/${revision}/publish`)).send({
    acknowledgeOpenItems: true,
  });

// ---------------------------------------------------------------------------------------------

describe('migration 0022 constraints and triggers', () => {
  it('accepts answers and marks of a General only (trigger)', async () => {
    const secondary = await insertFile('secondary');
    await expect(
      q(
        `INSERT INTO cad_file_installation_answers (id, project_id, cad_file_id, answer)
         VALUES ($1, $2, $3, 'pull_only')`,
        [randomUUID(), project, secondary],
      ),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      q(
        `INSERT INTO cad_file_trench_marks (id, project_id, cad_file_id, route_handle, length_m)
         VALUES ($1, $2, $3, 'C1', 1)`,
        [randomUUID(), project, secondary],
      ),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('keeps answers append-only: no update, delete or truncate', async () => {
    const file = await generalWithCurves();
    const id = randomUUID();
    await q(
      `INSERT INTO cad_file_installation_answers (id, project_id, cad_file_id, answer)
       VALUES ($1, $2, $3, 'pull_only')`,
      [id, project, file],
    );
    await expect(
      q(`UPDATE cad_file_installation_answers SET answer = 'has_trench' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      q('DELETE FROM cad_file_installation_answers WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(q('TRUNCATE cad_file_installation_answers')).rejects.toMatchObject({
      code: '23001',
    });
    await expect(
      q(
        `INSERT INTO cad_file_installation_answers (id, project_id, cad_file_id, answer)
         VALUES ($1, $2, $3, 'maybe')`,
        [randomUUID(), project, file],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('lets a mark be withdrawn once and nothing else change; checks the length and handle', async () => {
    const file = await generalWithCurves();
    const id = randomUUID();
    const insert = (handle: string, length: string) =>
      q(
        `INSERT INTO cad_file_trench_marks (id, project_id, cad_file_id, route_handle, length_m)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, project, file, handle, length],
      );
    await expect(insert('C1', '0')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('C1', '100000.001')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('C1', '99999.999').then(() => 'ok')).resolves.toBe('ok');
    await expect(
      q(`UPDATE cad_file_trench_marks SET length_m = 2 WHERE id = $1`, [id]),
    ).rejects.toMatchObject({
      code: '23001',
    });
    const user = (await q('SELECT id FROM users LIMIT 1')).rows[0]?.id;
    await q(
      `UPDATE cad_file_trench_marks SET withdrawn_by = $2, withdrawn_at = now() WHERE id = $1`,
      [id, user],
    );
    await expect(
      q(`UPDATE cad_file_trench_marks SET withdrawn_at = NULL, withdrawn_by = NULL WHERE id = $1`, [
        id,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(q('DELETE FROM cad_file_trench_marks WHERE id = $1', [id])).rejects.toMatchObject({
      code: '23001',
    });
    await expect(q('TRUNCATE cad_file_trench_marks')).rejects.toMatchObject({ code: '23001' });
  });

  it('allows the installation column on a General revision only, and never changes it', async () => {
    const pr = await pair('pull_only');
    await expect(
      q(
        `UPDATE design_revisions SET installation = '{"answer":null,"answerId":null,"marks":[]}' WHERE id = $1`,
        [pr.secondary.revision],
      ),
    ).rejects.toMatchObject({ code: '23001' }); // frozen inputs (the guard fires before the check)
    await expect(
      q(`UPDATE design_revisions SET installation = NULL WHERE id = $1`, [pr.general.revision]),
    ).rejects.toMatchObject({ code: '23001' });
    const other = await insertFile('secondary');
    await expect(
      q(
        `INSERT INTO design_revisions (id, project_id, cad_file_id, drawing_kind, status, current_job_id,
                                       rules, mapping_version, crs_epsg, drawing_unit, metres_per_unit, installation)
         VALUES ($1, $2, $3, 'secondary', 'queued', $4, '[]', 1, 32636, 'm', 1, '{"answer":null}')`,
        [randomUUID(), project, other, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('answer and trench marks lifecycle', () => {
  it('reads an unanswered General, then answers it (append-only history, events, who and when)', async () => {
    const file = await generalWithCurves();
    const empty = InstallationStateSchema.parse((await getState(file)).body);
    expect(empty).toMatchObject({
      drawingKind: 'general',
      asked: true,
      answer: null,
      answerHistory: [],
      marks: [],
      activeMarkCount: 0,
      activeTrenchM: '0.000',
    });
    const first = await answer(file, 'has_trench');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const parsed = InstallationAnswerRecordSchema.parse(first.body);
    expect(parsed).toMatchObject({ cadFileId: file, answer: 'has_trench' });
    expect(parsed.answeredBy?.id).toBeTruthy();
    // The same answer again: nothing new.
    expect((await answer(file, 'has_trench')).body.id).toBe(parsed.id);
    const second = await answer(file, 'pull_only');
    expect(second.body.id).not.toBe(parsed.id);
    const state = InstallationStateSchema.parse((await getState(file)).body);
    expect(state.answer?.id).toBe(second.body.id);
    expect(state.answerHistory.map((a) => a.answer)).toEqual(['pull_only', 'has_trench']);
    const events = await q(
      `SELECT payload FROM events WHERE type = 'installation_answer.answered' AND payload->>'cadFileId' = $1
       ORDER BY id`,
      [file],
    );
    expect(events.rows.map((r) => r.payload)).toEqual([
      { cadFileId: file, answer: 'has_trench', previousAnswer: null },
      { cadFileId: file, answer: 'pull_only', previousAnswer: 'has_trench' },
    ]);
  });

  it('rejects a bad answer body', async () => {
    const file = await generalWithCurves();
    expect((await answer(file, 'maybe')).status).toBe(400);
    expect(
      (await as(pm)(http().put(`${installUrl(file)}/answer`)).send({ answer: 'pull_only', x: 1 }))
        .status,
    ).toBe(400);
  });

  it('adds marks only after has_trench, on a real curve, with a valid length; withdraws once', async () => {
    const file = await generalWithCurves();
    let res = await addMark(file, 'C1', '10.5');
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'ANSWER_NOT_TRENCH' });
    await answer(file, 'pull_only');
    expect((await addMark(file, 'C1', '10.5')).body.details).toMatchObject({
      reason: 'ANSWER_NOT_TRENCH',
    });
    await answer(file, 'has_trench');

    res = await addMark(file, 'NOPE', '10.5');
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ reason: 'ROUTE_NOT_FOUND', handle: 'NOPE' });
    for (const bad of ['0', '-1', '1.2345', '100000.001', 'abc', '']) {
      expect((await addMark(file, 'C1', bad)).status, bad).toBe(400);
    }
    expect(
      (await as(pm)(http().post(`${installUrl(file)}/trench-marks`)).send({ routeHandle: 'C1' }))
        .status,
    ).toBe(400);

    res = await addMark(file, 'C1', '10.5');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const mark = TrenchMarkSchema.parse(res.body);
    expect(mark).toMatchObject({
      cadFileId: file,
      routeHandle: 'C1',
      lengthM: '10.500',
      withdrawnAt: null,
    });
    expect(mark.createdBy?.id).toBeTruthy();
    // Several marks on one route, and on another.
    expect((await addMark(file, 'C1', '2')).status).toBe(201);
    expect((await addMark(file, 'C2', '0.001')).status).toBe(201);

    // pull_only is refused while marks are in force.
    const refused = await answer(file, 'pull_only');
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({ reason: 'TRENCH_MARKS_ACTIVE' });

    let state = InstallationStateSchema.parse((await getState(file)).body);
    expect(state).toMatchObject({ activeMarkCount: 3, activeTrenchM: '12.501' });
    expect(state.marks).toHaveLength(3);

    const withdrawn = await withdrawMark(file, mark.id);
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(TrenchMarkSchema.parse(withdrawn.body)).toMatchObject({ id: mark.id });
    expect(withdrawn.body.withdrawnAt).toBeTruthy();
    const again = await withdrawMark(file, mark.id);
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: 'ALREADY_WITHDRAWN' });
    expect((await withdrawMark(file, randomUUID())).status).toBe(404);

    state = InstallationStateSchema.parse((await getState(file)).body);
    expect(state).toMatchObject({ activeMarkCount: 2, activeTrenchM: '2.001' });
    expect(state.marks).toHaveLength(3); // withdrawn ones stay in history
    const types = (
      await q(
        `SELECT type FROM events WHERE payload->>'cadFileId' = $1 AND type LIKE 'trench_mark.%' ORDER BY id`,
        [file],
      )
    ).rows.map((r) => r.type);
    expect(types).toEqual([
      'trench_mark.added',
      'trench_mark.added',
      'trench_mark.added',
      'trench_mark.withdrawn',
    ]);

    // With every mark withdrawn, pull_only is allowed.
    for (const m of state.marks.filter((x) => !x.withdrawnAt)) await withdrawMark(file, m.id);
    expect((await answer(file, 'pull_only')).status).toBe(200);
  });

  it('refuses a Secondary, a superseded General and an unprocessed General', async () => {
    const secondary = await insertFile('secondary');
    const asked = InstallationStateSchema.parse((await getState(secondary)).body);
    expect(asked).toMatchObject({
      drawingKind: 'secondary',
      asked: false,
      answer: null,
      marks: [],
    });
    for (const res of [await answer(secondary, 'pull_only'), await addMark(secondary, 'C1', '1')]) {
      expect(res.status).toBe(409);
      expect(res.body.details).toMatchObject({ reason: 'NOT_GENERAL_DRAWING' });
    }

    const old = await generalWithCurves();
    await answer(old, 'has_trench');
    const replacement = await insertFile('general');
    await q(`UPDATE cad_files SET superseded_at = now(), superseded_by = $2 WHERE id = $1`, [
      old,
      replacement,
    ]);
    for (const res of [await answer(old, 'pull_only'), await addMark(old, 'C1', '1')]) {
      expect(res.status).toBe(409);
      expect(res.body.details).toMatchObject({ reason: 'FILE_SUPERSEDED' });
    }

    const pending = await insertFile('general', project, 'uploaded');
    await answer(pending, 'has_trench');
    const res = await addMark(pending, 'C1', '1');
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'NOT_PROCESSED' });
  });

  it('stops at the technical caps', async () => {
    const file = await generalWithCurves();
    await answer(file, 'has_trench');
    const user = (await q('SELECT id FROM users LIMIT 1')).rows[0]?.id;
    // 2000 marks in force.
    await q(
      `INSERT INTO cad_file_trench_marks (id, project_id, cad_file_id, route_handle, length_m)
       SELECT gen_random_uuid(), $1, $2, 'C1', 1 FROM generate_series(1, 2000)`,
      [project, file],
    );
    let res = await addMark(file, 'C1', '1');
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'TOO_MANY_MARKS' });

    // 8000 rows, all withdrawn: still capped.
    const file2 = await generalWithCurves();
    await answer(file2, 'has_trench');
    await q(
      `INSERT INTO cad_file_trench_marks (id, project_id, cad_file_id, route_handle, length_m,
                                          withdrawn_by, withdrawn_at)
       SELECT gen_random_uuid(), $1, $2, 'C1', 1, $3, now() FROM generate_series(1, 8000)`,
      [project, file2, user],
    );
    res = await addMark(file2, 'C1', '1');
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'TOO_MANY_MARKS' });

    // 100 answers.
    const file3 = await generalWithCurves();
    await q(
      `INSERT INTO cad_file_installation_answers (id, project_id, cad_file_id, answer, created_at)
       SELECT gen_random_uuid(), $1, $2, CASE WHEN n % 2 = 0 THEN 'pull_only' ELSE 'has_trench' END,
              now() + n * interval '1 second' FROM generate_series(1, 100) AS n`,
      [project, file3],
    );
    res = await answer(file3, 'has_trench'); // the 100th row is has_trench... change to the other
    if (res.status === 200) res = await answer(file3, 'pull_only');
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'TOO_MANY_ANSWERS' });
  });

  it('checks permissions and the project scope', async () => {
    const file = await generalWithCurves();
    await answer(file, 'has_trench');
    const mark = (await addMark(file, 'C1', '3')).body.id as string;
    // Reads: pm, supervisor (cad_files:read); not the contractor.
    expect((await getState(file, supervisor)).status).toBe(200);
    expect((await getState(file, contractor)).status).toBe(403);
    // Writes: design:write only.
    expect((await answer(file, 'pull_only', supervisor)).status).toBe(403);
    expect((await addMark(file, 'C1', '1', supervisor)).status).toBe(403);
    expect((await withdrawMark(file, mark, supervisor)).status).toBe(403);
    expect((await answer(file, 'pull_only', contractor)).status).toBe(403);
    // Another project's member cannot reach the project at all.
    expect((await getState(file, otherPm)).status).toBe(403);
    expect((await answer(file, 'pull_only', otherPm)).status).toBe(403);
    // A file addressed through another project's URL is not found, even for an admin.
    expect((await getState(file, admin, otherProject)).status).toBe(404);
    const stranger = await as(admin)(http().put(`${installUrl(file, otherProject)}/answer`)).send({
      answer: 'pull_only',
    });
    expect(stranger.status).toBe(404);
    expect(
      (
        await as(admin)(
          http().post(`${installUrl(file, otherProject)}/trench-marks/${mark}/withdraw`),
        )
      ).status,
    ).toBe(404);
    // Nothing changed.
    const state = InstallationStateSchema.parse((await getState(file)).body);
    expect(state.answer?.answer).toBe('has_trench');
    expect(state.activeMarkCount).toBe(1);
  });
});

describe('freezing on the design revision', () => {
  it('freezes the answer and the marks in force at creation and again at a rebuild', async () => {
    const p = project;
    const file = await generalWithCurves();
    await answer(file, 'has_trench');
    const kept = (await addMark(file, 'C1', '4')).body.id as string;
    const dropped = (await addMark(file, 'C2', '5')).body.id as string;
    await withdrawMark(file, dropped);
    const saved = await saveMapping(file);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const created = await createRevision(file, saved.body.version);
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const revision = created.body.id as string;
    const answerId = (await getState(file)).body.answer.id as string;

    const stored = (await q('SELECT installation FROM design_revisions WHERE id = $1', [revision]))
      .rows[0]?.installation;
    expect(stored).toEqual({
      answer: 'has_trench',
      answerId,
      marks: [{ id: kept, routeHandle: 'C1', lengthM: '4.000' }],
    });
    const detail = await as(pm)(http().get(`${revisionsUrl(p)}/${revision}`));
    expect(DesignRevisionDetailSchema.parse(detail.body).installation).toEqual(stored);

    // A later mark does not touch the frozen revision...
    await addMark(file, 'C2', '6');
    expect(
      (await q('SELECT installation FROM design_revisions WHERE id = $1', [revision])).rows[0]
        ?.installation,
    ).toEqual(stored);
    // ...but the rebuild takes it.
    await markDraft(revision);
    const rebuilt = await as(pm)(http().post(`${revisionsUrl(p)}/${revision}/rebuild`)).send({
      mappingVersion: saved.body.version,
    });
    expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(202);
    const next = DesignRevisionDetailSchema.parse(
      (await as(pm)(http().get(`${revisionsUrl(p)}/${rebuilt.body.id}`))).body,
    );
    expect(next.installation?.marks.map((m) => [m.routeHandle, m.lengthM])).toEqual([
      ['C1', '4.000'],
      ['C2', '6.000'],
    ]);
    // Hand the project back: nothing open for the next test.
    await q(`UPDATE design_revisions SET status = 'building' WHERE id = $1`, [next.id]);
    await q(
      `UPDATE design_revisions SET status = 'failed', error_code = 'INTERNAL' WHERE id = $1`,
      [next.id],
    );
  });

  it('freezes nothing on a Secondary', async () => {
    const pr = await pair('pull_only');
    const row = await q('SELECT installation FROM design_revisions WHERE id = $1', [
      pr.secondary.revision,
    ]);
    expect(row.rows[0]?.installation).toBeNull();
    const detail = await as(admin)(
      http().get(`${revisionsUrl(pr.project)}/${pr.secondary.revision}`),
    );
    expect(DesignRevisionDetailSchema.parse(detail.body).installation).toBeNull();
  });
});

describe('readiness and publishing (INSTALLATION_UNCLEAR)', () => {
  const blocked = async (pr: Pair, revision = pr.general.revision) => {
    const res = await publish(pr, revision);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    return res.body.details as Record<string, unknown>;
  };

  it('publishes the pair when pull_only is answered', async () => {
    const pr = await pair('pull_only');
    const ready = await readiness(pr, pr.general.revision);
    expect(ready.checks.find((c) => c.key === 'installation')).toEqual({
      key: 'installation',
      ok: true,
      count: 0,
    });
    expect(ready).toMatchObject({ canPublish: true, installation: { applies: true, ok: true } });
    const report = InstallationReportSchema.parse(
      (
        await as(admin)(
          http().get(`${revisionsUrl(pr.project)}/${pr.general.revision}/installation`),
        )
      ).body,
    );
    expect(report).toBeDefined();
    const res = await publish(pr, pr.general.revision);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'published' });
  });

  it('blocks an unanswered General (the Secondary is not asked) and keeps the order of blockers', async () => {
    const pr = await pair(null);
    const ready = await readiness(pr, pr.general.revision);
    expect(ready).toMatchObject({
      canPublish: false,
      installation: { ok: false, issueCount: 1, issues: [{ code: 'QUESTION_UNANSWERED' }] },
    });
    expect(ready.checks.find((c) => c.key === 'installation')).toEqual({
      key: 'installation',
      ok: false,
      count: 1,
    });
    // The Secondary: its own installation check is always ok, but the General is part of other_drawing.
    const secReady = await readiness(pr, pr.secondary.revision);
    expect(secReady.installation).toBeNull();
    expect(secReady.checks.find((c) => c.key === 'installation')).toEqual({
      key: 'installation',
      ok: true,
      count: null,
    });
    expect(secReady.checks.find((c) => c.key === 'other_drawing')?.ok).toBe(false);
    expect(secReady.canPublish).toBe(false);

    // Both entry points answer INSTALLATION_UNCLEAR for the General's installation.
    for (const revision of [pr.general.revision, pr.secondary.revision]) {
      expect(await blocked(pr, revision)).toMatchObject({
        reason: 'INSTALLATION_UNCLEAR',
        drawingKind: 'general',
        issueCount: 1,
        issues: [{ code: 'QUESTION_UNANSWERED' }],
      });
    }

    // After PROBLEMS_OPEN: a drawing problem comes first.
    await q(`UPDATE design_revisions SET warnings = $2::jsonb WHERE id = $1`, [
      pr.general.revision,
      JSON.stringify([
        {
          code: 'LABEL_MISSING',
          severity: 'error',
          count: 1,
          items: [],
        },
      ]),
    ]);
    expect(await blocked(pr)).toMatchObject({ reason: 'PROBLEMS_OPEN' });
  });

  it('before CABINETS_MISMATCH: a clear installation with mismatched cabinets is the cabinets error', async () => {
    const unclear = await pair(null);
    await insertFeature(unclear.general.revision, unclear.project, 'cabinet', 'K1', {
      code: '1-1',
      attrs: { role: 'sub' },
    });
    expect(await blocked(unclear)).toMatchObject({ reason: 'INSTALLATION_UNCLEAR' });
    const clear = await pair('pull_only');
    await insertFeature(clear.general.revision, clear.project, 'cabinet', 'K1', {
      code: '1-1',
      attrs: { role: 'sub' },
    });
    expect(await blocked(clear)).toMatchObject({ reason: 'CABINETS_MISMATCH' });
  });

  it('blocks has_trench with no mark, then accepts a mark that fits its route', async () => {
    const pr = await pair('has_trench');
    expect(await blocked(pr)).toMatchObject({ issues: [{ code: 'TRENCH_NOT_MARKED' }] });
    // A mark made now only counts after a rebuild; here the revision is frozen, so check a new pair.
    const marked = await markedPair('A1', '10', '10.000');
    const ready = await readiness(marked, marked.general.revision);
    expect(ready).toMatchObject({
      canPublish: true,
      installation: { ok: true, totals: { trenchM: '10.000', pullM: '0.000' } },
    });
    expect((await publish(marked, marked.general.revision)).status).toBe(200);
  });

  /** A General with has_trench and one mark, built, with routes A1 (written length `route`). */
  async function markedPair(
    handle: string,
    markLength: string,
    routeLength: string | null,
    options: { routeFeature?: boolean } = {},
  ): Promise<Pair> {
    const p = await newProject();
    const zone = (
      await q(`INSERT INTO zones (project_id, name) VALUES ($1, 'Z') RETURNING id`, [p])
    ).rows[0]?.id as string;
    const email = `inst-mp-${p.slice(0, 8)}@ftth.local`;
    await ensureMember(ctx.pool, {
      email,
      password: 'Inst#Pass123',
      role: 'pm',
      projectId: p,
      zoneId: zone,
    });
    const token = await loginAs(ctx, email, 'Inst#Pass123');
    const gFile = await insertFile('general', p);
    await insertCurves(gFile, ['A1', 'B2', 'M3'], p);
    expect(
      (await as(token)(http().put(`${installUrl(gFile, p)}/answer`)).send({ answer: 'has_trench' }))
        .status,
    ).toBe(200);
    const marked = await as(token)(http().post(`${installUrl(gFile, p)}/trench-marks`)).send({
      routeHandle: handle,
      lengthM: markLength,
    });
    expect(marked.status, JSON.stringify(marked.body)).toBe(201);
    const sFile = await insertFile('secondary', p);
    const build = async (file: string) => {
      const saved = await as(token)(http().put(`${filesUrl(p)}/${file}/mapping`)).send({
        rules: [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }],
        crsEpsg: 32636,
        drawingUnit: 'm',
        version: null,
      });
      const created = await as(token)(http().post(revisionsUrl(p))).send({
        cadFileId: file,
        mappingVersion: saved.body.version,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(202);
      return created.body.id as string;
    };
    const gRev = await build(gFile);
    const sRev = await build(sFile);
    await markDraft(gRev);
    await markDraft(sRev);
    if (options.routeFeature !== false) {
      await insertFeature(gRev, p, 'route', 'A1', { attrs: routeAttrs(routeLength) });
    }
    return {
      project: p,
      general: { file: gFile, revision: gRev },
      secondary: { file: sFile, revision: sRev },
    };
  }

  it('blocks marks with pull_only (defence: written directly, the API prevents it)', async () => {
    const pr = await pair('has_trench');
    await q(`UPDATE design_revisions SET status = 'building' WHERE id = $1`, [
      pr.general.revision,
    ]).catch(() => undefined);
    // The frozen inputs cannot be edited, so build the defensive case with a frozen row inserted
    // directly: a fresh queued revision carrying pull_only and a mark.
    const p = await newProject();
    const file = await insertFile('general', p);
    const id = randomUUID();
    await q(
      `INSERT INTO design_revisions (id, project_id, cad_file_id, drawing_kind, status, current_job_id,
                                     rules, mapping_version, crs_epsg, drawing_unit, metres_per_unit, installation)
       VALUES ($1, $2, $3, 'general', 'queued', $4, '[]', 1, 32636, 'm', 1, $5::jsonb)`,
      [
        id,
        p,
        file,
        randomUUID(),
        JSON.stringify({
          answer: 'pull_only',
          answerId: randomUUID(),
          marks: [{ id: randomUUID(), routeHandle: 'A1', lengthM: '1.000' }],
        }),
      ],
    );
    await markDraft(id);
    await insertFeature(id, p, 'route', 'A1', { attrs: routeAttrs('10.000') });
    const report = InstallationReportSchema.parse(
      (await as(admin)(http().get(`${revisionsUrl(p)}/${id}/installation`))).body,
    );
    expect(report.issues.map((i) => i.code)).toEqual(['MARKS_WITH_PULL_ONLY']);
  });

  it('blocks a mark whose route is missing from the revision', async () => {
    const pr = await markedPair('B2', '1', '10.000');
    // The revision has only route A1; the mark sits on B2.
    expect(await blocked(pr)).toMatchObject({
      issues: [{ code: 'MARK_ROUTE_MISSING', routeHandle: 'B2' }],
    });
  });

  it('blocks a marked route with no written length, and a trench longer than its route', async () => {
    const noLength = await markedPair('A1', '1', null);
    expect(await blocked(noLength)).toMatchObject({
      issues: [{ code: 'ROUTE_LENGTH_UNKNOWN', routeHandle: 'A1' }],
    });
    const longer = await markedPair('A1', '10.001', '10.000');
    expect(await blocked(longer)).toMatchObject({
      issues: [{ code: 'TRENCH_LONGER_THAN_ROUTE', markedM: '10.001', routeLengthM: '10.000' }],
    });
    const body = InstallationReportSchema.parse(
      (
        await as(admin)(
          http().get(`${revisionsUrl(longer.project)}/${longer.general.revision}/installation`),
        )
      ).body,
    );
    expect(body.ok).toBe(false);
    expect(body.totals).toBeNull();
  });

  it('resolves a mark through the frozen merge_routes correction', async () => {
    const p = await newProject();
    const zone = (
      await q(`INSERT INTO zones (project_id, name) VALUES ($1, 'Z') RETURNING id`, [p])
    ).rows[0]?.id as string;
    const email = `inst-mg-${p.slice(0, 8)}@ftth.local`;
    await ensureMember(ctx.pool, {
      email,
      password: 'Inst#Pass123',
      role: 'pm',
      projectId: p,
      zoneId: zone,
    });
    const token = await loginAs(ctx, email, 'Inst#Pass123');
    const gFile = await insertFile('general', p);
    await insertCurves(gFile, ['A1', 'B2'], p);
    await as(token)(http().put(`${installUrl(gFile, p)}/answer`)).send({ answer: 'has_trench' });
    // The mark is on B2, which the merge joins into the route keyed by A1.
    await as(token)(http().post(`${installUrl(gFile, p)}/trench-marks`)).send({
      routeHandle: 'B2',
      lengthM: '10',
    });
    const merged = await as(token)(http().post(`${filesUrl(p)}/${gFile}/corrections`)).send({
      correction: { kind: 'merge_routes', handles: ['A1', 'B2'] },
    });
    expect(merged.status, JSON.stringify(merged.body)).toBe(201);
    const saved = await as(token)(http().put(`${filesUrl(p)}/${gFile}/mapping`)).send({
      rules: [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }],
      crsEpsg: 32636,
      drawingUnit: 'm',
      version: null,
    });
    const created = await as(token)(http().post(revisionsUrl(p))).send({
      cadFileId: gFile,
      mappingVersion: saved.body.version,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    await markDraft(created.body.id);
    await insertFeature(created.body.id, p, 'route', 'A1', { attrs: routeAttrs('10.000') });
    const report = InstallationReportSchema.parse(
      (await as(admin)(http().get(`${revisionsUrl(p)}/${created.body.id}/installation`))).body,
    );
    expect(report).toMatchObject({ ok: true, totals: { trenchM: '10.000', pullM: '0.000' } });
  });

  it('answers 404 for another project revision', async () => {
    const pr = await pair('pull_only');
    const res = await as(admin)(
      http().get(`${revisionsUrl(otherProject)}/${pr.general.revision}/installation`),
    );
    expect(res.status).toBe(404);
  });
});

describe('automatic Secondary placement from the General cabinets (GET …/placement/general-cabinets)', () => {
  const url = (file: string, p: string) => `${filesUrl(p)}/${file}/placement/general-cabinets`;
  const suggest = (file: string, p: string, token = admin) => as(token)(http().get(url(file, p)));

  /** Cabinets of a revision; `at` is the Secondary's drawn centre. */
  async function cabinet(
    revision: string,
    p: string,
    name: string | null,
    handle: string,
    options: { point?: [number, number]; at?: { x: number; y: number } | null } = {},
  ) {
    await insertFeature(revision, p, 'cabinet', handle, {
      code: name,
      point: options.point,
      attrs: { role: 'sub', ...(options.at ? { drawingAt: options.at } : {}) },
    });
  }

  it('matches cabinets by name, converts the General anchors, and lists the unmatched ones', async () => {
    const pr = await pair('pull_only');
    const { general, secondary } = pr;
    await cabinet(general.revision, pr.project, '1-1', 'G1', { point: [E0, N0] });
    await cabinet(general.revision, pr.project, '1-2', 'G2', { point: [E0 + 100, N0 + 50] });
    await cabinet(general.revision, pr.project, '9-9', 'G9');
    await cabinet(secondary.revision, pr.project, '1 - 2', 'S2', { at: { x: 20, y: 30 } });
    await cabinet(secondary.revision, pr.project, '1-1', 'S1', { at: { x: 10, y: 5 } });
    await cabinet(secondary.revision, pr.project, '7-7', 'S7', { at: { x: 1, y: 1 } });
    await cabinet(general.revision, pr.project, '3-3', 'G3');
    await cabinet(secondary.revision, pr.project, '3-3', 'S3', { at: null });

    const res = await suggest(secondary.file, pr.project);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = SecondaryPlacementSuggestionSchema.parse(res.body);
    expect(body).toMatchObject({
      cadFileId: secondary.file,
      secondaryRevisionId: secondary.revision,
      general: {
        cadFileId: general.file,
        revisionId: general.revision,
        status: 'draft',
        revNo: null,
      },
      matchedCount: 2,
      truncated: false,
      unmatched: { onlyInGeneral: ['9-9'], onlyInSecondary: ['7-7'] },
    });
    expect(body.points.map((x) => [x.id, x.source, x.excluded, x.handle])).toEqual([
      ['gc-1-1', 'general_cabinet', false, 'S1'],
      ['gc-1-2', 'general_cabinet', false, 'S2'],
    ]);
    expect(body.unmatched.withoutDrawingPosition).toEqual(['3-3']);
    const crs = createProjectCrs(32636);
    const expected = crs.toWgs84({ x: E0 + 100, y: N0 + 50 });
    expect(body.points[1]?.lat).toBeCloseTo(expected.lat, 7);
    expect(body.points[1]?.lon).toBeCloseTo(expected.lon, 7);
    expect(body.points[1]?.drawing).toEqual({ x: 20, y: 30 });
    // Read-only: no event, nothing saved.
    expect(
      (await q(`SELECT 1 FROM cad_mappings WHERE cad_file_id = $1`, [secondary.file])).rowCount,
    ).toBe(1); // the mapping the pair() helper saved is untouched
    expect(supervisor).toBeTruthy();
  });

  it('does not use a name drawn twice on either side', async () => {
    const pr = await pair('pull_only');
    await cabinet(pr.general.revision, pr.project, '2-1', 'GA');
    await cabinet(pr.general.revision, pr.project, '2-1', 'GB');
    await cabinet(pr.secondary.revision, pr.project, '2-1', 'SA', { at: { x: 1, y: 1 } });
    await cabinet(pr.secondary.revision, pr.project, '5-1', 'SB', { at: { x: 2, y: 2 } });
    await cabinet(pr.secondary.revision, pr.project, '5-1', 'SC', { at: { x: 3, y: 3 } });
    await cabinet(pr.general.revision, pr.project, '5-1', 'GC');
    const body = SecondaryPlacementSuggestionSchema.parse(
      (await suggest(pr.secondary.file, pr.project)).body,
    );
    expect(body.points).toEqual([]);
    expect(body.unmatched).toMatchObject({
      duplicateInGeneral: ['2-1'],
      duplicateInSecondary: ['5-1'],
    });
  });

  it('refuses with a clear reason when nothing can be suggested', async () => {
    const reason = async (res: request.Response) => {
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      return res.body.details as { reason: string; revisionId: string | null };
    };
    const pr = await pair('pull_only');
    expect(await reason(await suggest(pr.general.file, pr.project))).toMatchObject({
      reason: 'NOT_SECONDARY',
    });

    // Built before drawingAt: every cabinet lacks it.
    await cabinet(pr.secondary.revision, pr.project, '1-1', 'S1', { at: null });
    expect(await reason(await suggest(pr.secondary.file, pr.project))).toEqual({
      reason: 'SECONDARY_REBUILD_NEEDED',
      revisionId: pr.secondary.revision,
    });
    await q(`DELETE FROM design_features WHERE revision_id = $1`, [pr.secondary.revision]);

    // The General without a usable placement.
    await setPlacement(pr.general.revision, null);
    expect(await reason(await suggest(pr.secondary.file, pr.project))).toEqual({
      reason: 'GENERAL_NOT_PLACED',
      revisionId: pr.general.revision,
    });

    // The General discarded: no built revision of the current General.
    await q(`UPDATE design_revisions SET status = 'discarded', error_code = NULL WHERE id = $1`, [
      pr.general.revision,
    ]);
    expect(await reason(await suggest(pr.secondary.file, pr.project))).toMatchObject({
      reason: 'GENERAL_NOT_BUILT',
    });

    // The Secondary: a superseded file, a building revision, no built revision.
    await q(`UPDATE design_revisions SET status = 'building' WHERE id = $1`, [
      pr.secondary.revision,
    ]);
    expect(await reason(await suggest(pr.secondary.file, pr.project))).toEqual({
      reason: 'SECONDARY_BUILDING',
      revisionId: pr.secondary.revision,
    });
    await q(`UPDATE design_revisions SET status = 'discarded' WHERE id = $1`, [
      pr.secondary.revision,
    ]);
    expect(await reason(await suggest(pr.secondary.file, pr.project))).toMatchObject({
      reason: 'SECONDARY_NOT_BUILT',
    });
    const replacement = await insertFile('secondary', pr.project);
    await q(`UPDATE cad_files SET superseded_at = now(), superseded_by = $2 WHERE id = $1`, [
      pr.secondary.file,
      replacement,
    ]);
    expect(await reason(await suggest(pr.secondary.file, pr.project))).toMatchObject({
      reason: 'NOT_CURRENT',
    });
  });

  it('refuses a General building and checks permissions and the project scope', async () => {
    const pr = await pair('pull_only');
    await cabinet(pr.secondary.revision, pr.project, '1-1', 'S1', { at: { x: 1, y: 1 } });
    await q(`UPDATE design_revisions SET status = 'discarded' WHERE id = $1`, [
      pr.general.revision,
    ]);
    // A queued General revision of the current file.
    const mapping = await q(`SELECT version FROM cad_mappings WHERE cad_file_id = $1`, [
      pr.general.file,
    ]);
    const queued = randomUUID();
    await q(
      `INSERT INTO design_revisions (id, project_id, cad_file_id, drawing_kind, status, current_job_id,
                                     rules, mapping_version, crs_epsg, drawing_unit, metres_per_unit)
       VALUES ($1, $2, $3, 'general', 'queued', $4, '[]', $5, 32636, 'm', 1)`,
      [queued, pr.project, pr.general.file, randomUUID(), mapping.rows[0]?.version ?? 1],
    );
    const res = await suggest(pr.secondary.file, pr.project);
    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({ reason: 'GENERAL_BUILDING', revisionId: queued });

    // Another project's URL for this file: 404 even for an admin; no cross-project reading.
    expect((await suggest(pr.secondary.file, otherProject)).status).toBe(404);
    // Roles: contractor has no cad_files:read.
    expect((await suggest(pr.secondary.file, project, contractor)).status).toBe(403);
  });

  it('refuses general_cabinet control points in a General mapping (POINT_SOURCE_NOT_FOR_KIND)', async () => {
    const general = await insertFile('general');
    const secondary = await insertFile('secondary');
    const placement = {
      sourceCrs: 'project',
      points: [
        { id: 'a', drawing: { x: 0, y: 0 }, lat: 30, lon: 32, source: 'typed' },
        { id: 'gc-1-1', drawing: { x: 1, y: 1 }, lat: 30, lon: 32, source: 'general_cabinet' },
      ],
    };
    const refused = await saveMapping(general, placement);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.details).toMatchObject({
      reason: 'POINT_SOURCE_NOT_FOR_KIND',
      pointIndexes: [1],
    });
    const accepted = await saveMapping(secondary, placement);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.placement.points[1].source).toBe('general_cabinet');
  });
});
