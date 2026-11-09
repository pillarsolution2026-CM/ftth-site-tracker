import { randomUUID } from 'node:crypto';
import {
  DesignRevisionSummarySchema,
  DrawingCorrectionListSchema,
  DrawingCorrectionSchema,
  FrozenDrawingCorrectionSchema,
} from '@ftth/shared';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ensureMember, eventTypes, loginAs, SEED_LOGINS } from './support/helpers.js';
import { startRedis, type TestRedis } from './support/redis.js';
import { createTestContext, type TestContext } from './support/test-app.js';

let testRedis: TestRedis;
let redis: Redis;
let ctx: TestContext;
let project: string;
let otherProject: string;
let admin: string;
let pm: string;
let supervisor: string;

beforeAll(async () => {
  testRedis = await startRedis();
  redis = new Redis(testRedis.url);
  ctx = await createTestContext(inject('databaseUrl'), { REDIS_URL: testRedis.url });
  // A fresh project per run: only one open revision per project, published ones are immutable.
  const make = async (label: string) =>
    (
      await ctx.pool.query<{ id: string }>(
        `INSERT INTO projects (name, client, crs_epsg, currency, locale)
         VALUES ($1, 'WE', 32636, 'EGP', 'ar') RETURNING id`,
        [`Corrections ${label} ${randomUUID()}`],
      )
    ).rows[0]?.id ?? '';
  project = await make('A');
  otherProject = await make('B');
  const zone = await ctx.pool.query<{ id: string }>(
    `INSERT INTO zones (project_id, name) VALUES ($1, 'Sector 1') RETURNING id`,
    [project],
  );
  await ensureMember(ctx.pool, {
    email: 'corr-pm@ftth.local',
    password: 'Corr#Pm1234',
    role: 'pm',
    projectId: project,
    zoneId: zone.rows[0]?.id ?? '',
  });
  await ensureMember(ctx.pool, {
    email: 'corr-sup@ftth.local',
    password: 'Corr#Sup1234',
    role: 'supervisor',
    projectId: project,
    zoneId: zone.rows[0]?.id ?? '',
  });
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
  pm = await loginAs(ctx, 'corr-pm@ftth.local', 'Corr#Pm1234');
  supervisor = await loginAs(ctx, 'corr-sup@ftth.local', 'Corr#Sup1234');
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  redis?.disconnect();
  await testRedis?.stop();
});

const http = () => request(ctx.app.getHttpServer());
const as = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
const correctionsUrl = (file: string, p = project) =>
  `/projects/${p}/cad-files/${file}/corrections`;
const revisionsUrl = (p = project) => `/projects/${p}/design-revisions`;

async function insertFile(
  status: 'processed' | 'uploaded' = 'processed',
  p = project,
): Promise<string> {
  const id = randomUUID();
  await ctx.pool.query(
    `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                            status, current_job_id, ins_units, processed_at)
     VALUES ($1, $2, 'plan.dxf', 'dxf', 100, repeat('a', 64), $3, $4, $5, 1, $6)`,
    [
      id,
      p,
      `projects/${p}/cad/${id}/original.dxf`,
      status,
      status === 'uploaded' ? null : randomUUID(),
      status === 'processed' ? new Date() : null,
    ],
  );
  return id;
}

/** A processed file with an insert I1, a text T1 and two curves C1, C2 (the worker's rows). */
async function insertDrawing(): Promise<string> {
  const fileId = await insertFile();
  await ctx.pool.query(
    `INSERT INTO cad_inserts (project_id, cad_file_id, handle, layer, block_name, position)
     VALUES ($1, $2, 'I1', 'sub', 'sub', ST_GeomFromText('POINT Z (1 2 0)', 0))`,
    [project, fileId],
  );
  await ctx.pool.query(
    `INSERT INTO cad_texts (project_id, cad_file_id, handle, kind, layer, position, height, raw_text, text, readable)
     VALUES ($1, $2, 'T1', 'text', 'TXT', ST_GeomFromText('POINT Z (1 2 0)', 0), 2.5, 'x', 'x', true)`,
    [project, fileId],
  );
  for (const handle of ['C1', 'C2']) {
    await ctx.pool.query(
      `INSERT INTO cad_curves (project_id, cad_file_id, handle, entity_type, layer, geom)
       VALUES ($1, $2, $3, 'LINE', 'N_DUC_CBL', ST_GeomFromText('LINESTRING Z (0 0 0, 1 1 0)', 0))`,
      [project, fileId, handle],
    );
  }
  return fileId;
}

const saveMapping = (fileId: string) =>
  as(pm)(http().put(`/projects/${project}/cad-files/${fileId}/mapping`)).send({
    rules: [
      { source: 'layer', layer: 'N_DUC_CBL', target: 'route' },
      // Targets of the moves below: a move needs a rule on its layer (owner 2026-11-09).
      { source: 'layer', layer: 'N_MH', target: 'mh' },
      { source: 'layer', layer: 'L', target: 'label' },
    ],
    crsEpsg: 32636,
    drawingUnit: 'm',
    version: null,
  });

const addCorrection = (fileId: string, body: object, token = pm) =>
  as(token)(http().post(correctionsUrl(fileId))).send(body);
const setText = (fileId: string, text = 'fixed') =>
  addCorrection(fileId, { correction: { kind: 'set_text', handle: 'T1', text } });

/** The worker's end of a build: building, then draft (inputs stay frozen). */
async function markDraft(revisionId: string): Promise<void> {
  await ctx.pool.query(`UPDATE design_revisions SET status = 'building' WHERE id = $1`, [
    revisionId,
  ]);
  await ctx.pool.query(
    `UPDATE design_revisions SET status = 'draft', built_at = now() WHERE id = $1`,
    [revisionId],
  );
}

const frozen = async (revisionId: string) =>
  (
    await ctx.pool.query<{ corrections: unknown }>(
      'SELECT corrections FROM design_revisions WHERE id = $1',
      [revisionId],
    )
  ).rows[0]?.corrections;

describe('migration 0015 triggers', () => {
  async function rawCorrection(fileId: string): Promise<string> {
    const id = randomUUID();
    await ctx.pool.query(
      `INSERT INTO cad_file_corrections (id, project_id, cad_file_id, correction)
       VALUES ($1, $2, $3, '{"kind":"add_item","layer":"L","x":1,"y":2}')`,
      [id, project, fileId],
    );
    return id;
  }

  it('lets the withdrawal happen once and nothing else change', async () => {
    const fileId = await insertFile();
    const id = await rawCorrection(fileId);
    await expect(
      ctx.pool.query(`UPDATE cad_file_corrections SET correction = '{}' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ message: expect.stringContaining('only the withdrawal') });
    await expect(
      ctx.pool.query(`UPDATE cad_file_corrections SET created_at = now() WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23001' });
    const user = (await ctx.pool.query<{ id: string }>('SELECT id FROM users LIMIT 1')).rows[0]?.id;
    await ctx.pool.query(
      `UPDATE cad_file_corrections SET withdrawn_by = $2, withdrawn_at = now() WHERE id = $1`,
      [id, user],
    );
    await expect(
      ctx.pool.query(
        `UPDATE cad_file_corrections SET withdrawn_at = NULL, withdrawn_by = NULL WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('refuses delete and truncate', async () => {
    const fileId = await insertFile();
    const id = await rawCorrection(fileId);
    await expect(
      ctx.pool.query('DELETE FROM cad_file_corrections WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(ctx.pool.query('TRUNCATE cad_file_corrections')).rejects.toMatchObject({
      code: '23001',
    });
  });

  it('keeps the checks: object, known problem code, problem pair, withdrawal pair', async () => {
    const fileId = await insertFile();
    const insert = (correction: string, code: string | null, handle: string | null) =>
      ctx.pool.query(
        `INSERT INTO cad_file_corrections (id, project_id, cad_file_id, correction, problem_code, problem_handle)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [randomUUID(), project, fileId, correction, code, handle],
      );
    await expect(insert('[]', null, null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('{}', 'NOPE', 'H')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('{}', 'WRONG_LAYER', null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('{}', 'WRONG_LAYER', 'H')).resolves.toBeDefined();
  });

  it('requires a file of the same project', async () => {
    const foreign = await insertFile('processed', otherProject);
    await expect(
      ctx.pool.query(
        `INSERT INTO cad_file_corrections (id, project_id, cad_file_id, correction)
         VALUES ($1, $2, $3, '{}')`,
        [randomUUID(), project, foreign],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('freezes design_revisions.corrections like the other inputs', async () => {
    const fileId = await insertDrawing();
    expect((await saveMapping(fileId)).status).toBe(200);
    const created = await as(pm)(http().post(revisionsUrl())).send({
      cadFileId: fileId,
      mappingVersion: 1,
    });
    expect(created.status).toBe(202);
    await expect(
      ctx.pool.query(`UPDATE design_revisions SET corrections = '[{"x":1}]' WHERE id = $1`, [
        created.body.id,
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('inputs are immutable') });
    // Leave the slot free for the next test.
    await ctx.pool.query(
      `UPDATE design_revisions SET status = 'failed', error_code = 'INTERNAL' WHERE id = $1`,
      [created.body.id],
    );
    await as(pm)(http().post(`${revisionsUrl()}/${created.body.id}/discard`));
  });
});

describe('corrections routes', () => {
  it('adds, lists newest first and withdraws, with events', async () => {
    const fileId = await insertDrawing();
    expect((await saveMapping(fileId)).status).toBe(200);
    const first = await addCorrection(fileId, {
      correction: { kind: 'move_layer', handle: 'I1', toLayer: 'N_MH' },
      problem: { code: 'WRONG_LAYER', handle: 'I1' },
    });
    expect(first.status).toBe(201);
    const created = DrawingCorrectionSchema.parse(first.body);
    expect(created.problem).toEqual({ code: 'WRONG_LAYER', handle: 'I1' });
    expect(created.createdBy?.name).toBe('corr-pm@ftth.local');

    const second = await setText(fileId);
    expect(second.status).toBe(201);

    const list = DrawingCorrectionListSchema.parse(
      (await as(supervisor)(http().get(correctionsUrl(fileId)))).body,
    );
    expect(list.items.map((item) => item.id)).toEqual([second.body.id, created.id]);
    expect(list.activeCount).toBe(2);

    const withdrawn = await as(pm)(http().post(`${correctionsUrl(fileId)}/${created.id}/withdraw`));
    expect(withdrawn.status).toBe(200);
    expect(DrawingCorrectionSchema.parse(withdrawn.body).withdrawnBy?.id).toBe(
      created.createdBy?.id,
    );
    const again = await as(pm)(http().post(`${correctionsUrl(fileId)}/${created.id}/withdraw`));
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: 'ALREADY_WITHDRAWN' });
    const after = DrawingCorrectionListSchema.parse(
      (await as(pm)(http().get(correctionsUrl(fileId)))).body,
    );
    expect(after.activeCount).toBe(1);
    expect(await eventTypes(ctx.pool, created.id)).toEqual([
      'drawing_correction.added',
      'drawing_correction.withdrawn',
    ]);
  });

  it('validates the references against the extracted rows', async () => {
    const fileId = await insertDrawing();
    expect((await saveMapping(fileId)).status).toBe(200);
    const refused = (body: object, handles: string[]) =>
      addCorrection(fileId, body).then((res) => {
        expect(res.status).toBe(422);
        expect(res.body.details).toMatchObject({ reason: 'HANDLE_NOT_FOUND', handles });
      });
    await refused({ correction: { kind: 'set_text', handle: 'I1', text: 'x' } }, ['I1']);
    await refused({ correction: { kind: 'move_layer', handle: 'ZZ', toLayer: 'L' } }, ['ZZ']);
    await refused({ correction: { kind: 'merge_routes', handles: ['C1', 'T1'] } }, ['T1']);
    const noRule = await addCorrection(fileId, {
      correction: { kind: 'move_layer', handle: 'C1', toLayer: 'NO_RULE' },
    });
    expect(noRule.status).toBe(422);
    expect(noRule.body.details).toMatchObject({ reason: 'LAYER_HAS_NO_RULE', layer: 'NO_RULE' });
    expect(
      (
        await addCorrection(fileId, {
          correction: { kind: 'move_layer', handle: 'C1', toLayer: 'L' },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await addCorrection(fileId, {
          correction: { kind: 'move_layer', handle: 'T1', toLayer: 'L' },
        })
      ).status,
    ).toBe(201);
    expect(
      (await addCorrection(fileId, { correction: { kind: 'merge_routes', handles: ['C1', 'C2'] } }))
        .status,
    ).toBe(201);
    expect(
      (await addCorrection(fileId, { correction: { kind: 'add_item', layer: 'N_MH', x: 1, y: 2 } }))
        .status,
    ).toBe(201);
    expect(
      (
        await addCorrection(fileId, {
          correction: { kind: 'add_text', layer: 'T', x: 1, y: 2, text: 'MH-1' },
        })
      ).status,
    ).toBe(201);
    expect((await addCorrection(fileId, { correction: { kind: 'bogus' } })).status).toBe(400);
  });

  it('refuses a file that is not processed', async () => {
    const fileId = await insertFile('uploaded');
    const res = await addCorrection(fileId, {
      correction: { kind: 'add_item', layer: 'L', x: 0, y: 0 },
    });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'NOT_PROCESSED' });
  });

  it('is project scoped: another project, or an unknown file, is 404', async () => {
    const fileId = await insertDrawing();
    const made = await setText(fileId);
    const foreignFile = await insertFile('processed', otherProject);
    expect((await as(admin)(http().get(correctionsUrl(foreignFile)))).status).toBe(404);
    expect((await as(admin)(http().get(correctionsUrl(fileId, otherProject)))).status).toBe(404);
    expect(
      (
        await as(admin)(
          http()
            .post(correctionsUrl(fileId, otherProject))
            .send({
              correction: { kind: 'add_item', layer: 'L', x: 0, y: 0 },
            }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await as(admin)(
          http().post(`${correctionsUrl(fileId, otherProject)}/${made.body.id}/withdraw`),
        )
      ).status,
    ).toBe(404);
    expect(
      (await as(pm)(http().post(`${correctionsUrl(foreignFile)}/${made.body.id}/withdraw`))).status,
    ).toBe(404);
    expect((await as(pm)(http().get(correctionsUrl(randomUUID())))).status).toBe(404);
  });

  it('lets a supervisor read but not write', async () => {
    const fileId = await insertDrawing();
    expect((await as(supervisor)(http().get(correctionsUrl(fileId)))).status).toBe(200);
    expect(
      (
        await setText(fileId, 'x').then(() =>
          addCorrection(
            fileId,
            { correction: { kind: 'add_item', layer: 'L', x: 0, y: 0 } },
            supervisor,
          ),
        )
      ).status,
    ).toBe(403);
    expect((await http().get(correctionsUrl(fileId))).status).toBe(401);
  });
});

describe('freezing and rebuild', () => {
  it('freezes the active corrections, in creation order, on the new revision', async () => {
    const fileId = await insertDrawing();
    await saveMapping(fileId);
    const a = await setText(fileId, 'a');
    const b = await setText(fileId, 'b');
    const c = await addCorrection(fileId, {
      correction: { kind: 'add_item', layer: 'N_MH', x: 1, y: 2 },
    });
    await as(pm)(http().post(`${correctionsUrl(fileId)}/${b.body.id}/withdraw`));

    const created = await as(pm)(http().post(revisionsUrl())).send({
      cadFileId: fileId,
      mappingVersion: 1,
    });
    expect(created.status).toBe(202);
    const rows = (await frozen(created.body.id)) as unknown[];
    expect(rows.map((row) => FrozenDrawingCorrectionSchema.parse(row).id)).toEqual([
      a.body.id,
      c.body.id,
    ]);

    // Later changes never touch what the revision froze.
    await setText(fileId, 'later');
    expect(await frozen(created.body.id)).toEqual(rows);

    await ctx.pool.query(
      `UPDATE design_revisions SET status = 'failed', error_code = 'INTERNAL' WHERE id = $1`,
      [created.body.id],
    );
    expect((await as(pm)(http().post(`${revisionsUrl()}/${created.body.id}/discard`))).status).toBe(
      200,
    );
  });

  it('rebuilds a draft: discards it and queues a new one with the current corrections', async () => {
    const fileId = await insertDrawing();
    await saveMapping(fileId);
    const created = await as(pm)(http().post(revisionsUrl())).send({
      cadFileId: fileId,
      mappingVersion: 1,
    });
    expect(await frozen(created.body.id)).toEqual([]);
    await markDraft(created.body.id);
    const correction = await setText(fileId);

    const rebuilt = await as(pm)(http().post(`${revisionsUrl()}/${created.body.id}/rebuild`)).send({
      mappingVersion: 1,
    });
    expect(rebuilt.status).toBe(202);
    const summary = DesignRevisionSummarySchema.parse(rebuilt.body);
    expect(summary.status).toBe('queued');
    expect(summary.id).not.toBe(created.body.id);
    expect(summary.cadFileId).toBe(fileId);

    const old = await ctx.pool.query<{ status: string }>(
      'SELECT status FROM design_revisions WHERE id = $1',
      [created.body.id],
    );
    expect(old.rows[0]?.status).toBe('discarded');
    expect(await frozen(summary.id)).toEqual([
      { id: correction.body.id, correction: correction.body.correction },
    ]);
    expect(await eventTypes(ctx.pool, created.body.id)).toEqual([
      'design_revision.queued',
      'design_revision.discarded',
    ]);
    expect(await eventTypes(ctx.pool, summary.id)).toEqual(['design_revision.queued']);
    const jobs = (await redis.lrange('cad:jobs', 0, -1)).filter((m) => m.includes(summary.id));
    expect(jobs.length).toBeGreaterThan(0);

    // The new one is queued (not a draft): it cannot be rebuilt.
    const again = await as(pm)(http().post(`${revisionsUrl()}/${summary.id}/rebuild`)).send({
      mappingVersion: 1,
    });
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: 'NOT_REBUILDABLE' });

    await ctx.pool.query(
      `UPDATE design_revisions SET status = 'failed', error_code = 'INTERNAL' WHERE id = $1`,
      [summary.id],
    );
    await as(pm)(http().post(`${revisionsUrl()}/${summary.id}/discard`));
  });

  it('is atomic: a wrong mapping version leaves the draft as it was', async () => {
    const fileId = await insertDrawing();
    await saveMapping(fileId);
    const created = await as(pm)(http().post(revisionsUrl())).send({
      cadFileId: fileId,
      mappingVersion: 1,
    });
    await markDraft(created.body.id);
    const res = await as(pm)(http().post(`${revisionsUrl()}/${created.body.id}/rebuild`)).send({
      mappingVersion: 9,
    });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'MAPPING_VERSION_MISMATCH' });
    const row = await ctx.pool.query<{ status: string }>(
      'SELECT status FROM design_revisions WHERE id = $1',
      [created.body.id],
    );
    expect(row.rows[0]?.status).toBe('draft');
    expect(await eventTypes(ctx.pool, created.body.id)).toEqual(['design_revision.queued']);
    expect((await as(pm)(http().post(`${revisionsUrl()}/${created.body.id}/discard`))).status).toBe(
      200,
    );
  });

  it('is project scoped and checks the request', async () => {
    const fileId = await insertDrawing();
    await saveMapping(fileId);
    const created = await as(pm)(http().post(revisionsUrl())).send({
      cadFileId: fileId,
      mappingVersion: 1,
    });
    await markDraft(created.body.id);
    expect(
      (
        await as(admin)(
          http().post(`${revisionsUrl(otherProject)}/${created.body.id}/rebuild`),
        ).send({ mappingVersion: 1 })
      ).status,
    ).toBe(404);
    expect(
      (
        await as(supervisor)(http().post(`${revisionsUrl()}/${created.body.id}/rebuild`)).send({
          mappingVersion: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await as(pm)(http().post(`${revisionsUrl()}/${created.body.id}/rebuild`)).send({
          mappingVersion: 0,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await as(pm)(http().post(`${revisionsUrl()}/${randomUUID()}/rebuild`)).send({
          mappingVersion: 1,
        })
      ).status,
    ).toBe(404);

    expect((await as(pm)(http().post(`${revisionsUrl()}/${created.body.id}/discard`))).status).toBe(
      200,
    );
  });
});
