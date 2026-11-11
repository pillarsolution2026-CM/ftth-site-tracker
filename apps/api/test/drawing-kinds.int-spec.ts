import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CadFileSummarySchema,
  DesignRevisionDetailSchema,
  DesignRevisionSummarySchema,
  KindExistsDetailsSchema,
  OfflineBundleSchema,
  PublishReadinessSchema,
  type DrawingKind,
} from '@ftth/shared';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eventTypes, loginAs, SEED_LOGINS } from './support/helpers.js';
import {
  createExecutionFixture,
  E0,
  N0,
  publishRevision,
  type ExecutionFixture,
} from './support/execution-fixtures.js';
import { startRedis, type TestRedis } from './support/redis.js';
import { createTestContext, type TestContext } from './support/test-app.js';

/**
 * ADR-040 part A: drawing kinds (General / Secondary) per CAD file, versions that supersede,
 * one open revision per kind, publishing the pair together, and the readers that stay on the
 * General. The worker's side is simulated with SQL, as in the design-revision tests.
 */

const DXF = Buffer.from('  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nEOF\n');

let testRedis: TestRedis;
let redis: Redis;
let ctx: TestContext;
let admin: string;

beforeAll(async () => {
  testRedis = await startRedis();
  redis = new Redis(testRedis.url);
  ctx = await createTestContext(inject('databaseUrl'), { REDIS_URL: testRedis.url });
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  redis?.disconnect();
  await testRedis?.stop();
});

const http = () => request(ctx.app.getHttpServer());
const as = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
const filesUrl = (project: string) => `/projects/${project}/cad-files`;
const revisionsUrl = (project: string) => `/projects/${project}/design-revisions`;

async function newProject(): Promise<string> {
  const created = await ctx.pool.query<{ id: string }>(
    `INSERT INTO projects (name, client, crs_epsg, currency, locale)
     VALUES ($1, 'WE', 32636, 'EGP', 'ar') RETURNING id`,
    [`Drawing kinds ${randomUUID()}`],
  );
  return created.rows[0]?.id ?? '';
}

async function insertFile(
  project: string,
  kind: DrawingKind = 'general',
  status = 'processed',
): Promise<string> {
  const id = randomUUID();
  await ctx.pool.query(
    `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                            status, current_job_id, processed_at, drawing_kind)
     VALUES ($1, $2, $3, 'dxf', 100, repeat('a', 64), $4, $5, $6, now(), $7)`,
    [
      id,
      project,
      `${kind}-${id.slice(0, 6)}.dxf`,
      `projects/${project}/cad/${id}/o.dxf`,
      status,
      randomUUID(),
      kind,
    ],
  );
  return id;
}

async function insertRevision(
  project: string,
  fileId: string,
  options: { kind?: DrawingKind; status?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const columns = options.kind ? `, drawing_kind` : '';
  const values = options.kind ? `, '${options.kind}'` : '';
  await ctx.pool.query(
    `INSERT INTO design_revisions (id, project_id, cad_file_id, status, current_job_id, rules,
                                   mapping_version, crs_epsg, drawing_unit, metres_per_unit${columns})
     VALUES ($1, $2, $3, $4, $5, '[]', 1, 32636, 'm', 1${values})`,
    [id, project, fileId, options.status ?? 'draft', randomUUID()],
  );
  return id;
}

/** The SQLSTATE of a failing statement, or null when it succeeded. */
async function sqlState(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

const q = (text: string, values: unknown[] = []) => ctx.pool.query(text, values);

describe('migration 0019: one current file per kind for files uploaded before ADR-040', () => {
  const current = async (project: string) =>
    (
      await q(
        `SELECT id, drawing_kind, superseded_by FROM cad_files WHERE project_id = $1 ORDER BY id`,
        [project],
      )
    ).rows as { id: string; drawing_kind: string; superseded_by: string | null }[];
  const age = (id: string, minutes: number) =>
    q(`UPDATE cad_files SET created_at = now() - make_interval(mins => $2) WHERE id = $1`, [
      id,
      minutes,
    ]);

  it('keeps the file of the open revision current and supersedes the others of that kind', async () => {
    const project = await newProject();
    const newest = await insertFile(project);
    const withDraft = await insertFile(project);
    const oldest = await insertFile(project);
    await age(oldest, 300);
    await age(withDraft, 200);
    await age(newest, 100);
    await insertRevision(project, newest, { status: 'discarded' });
    await insertRevision(project, withDraft, { status: 'draft' });
    const secondary = await insertFile(project, 'secondary');

    await q('SELECT cad_files_supersede_legacy()');
    const rows = new Map((await current(project)).map((r) => [r.id, r.superseded_by]));
    expect(rows.get(withDraft)).toBeNull();
    expect(rows.get(newest)).toBe(withDraft);
    expect(rows.get(oldest)).toBe(withDraft);
    expect(rows.get(secondary)).toBeNull();

    // Running it again changes nothing.
    await q('SELECT cad_files_supersede_legacy()');
    expect(new Map((await current(project)).map((r) => [r.id, r.superseded_by]))).toEqual(rows);
  });

  it('without an open revision keeps the file of the latest revision, else the newest file', async () => {
    const withRevision = await newProject();
    const a = await insertFile(withRevision);
    const b = await insertFile(withRevision);
    await age(a, 50);
    await age(b, 10);
    await insertRevision(withRevision, a, { status: 'discarded' });
    await q('SELECT cad_files_supersede_legacy()');
    expect(new Map((await current(withRevision)).map((r) => [r.id, r.superseded_by]))).toEqual(
      new Map([
        [a, null],
        [b, a],
      ]),
    );

    const noRevision = await newProject();
    const old = await insertFile(noRevision);
    const fresh = await insertFile(noRevision);
    await age(old, 50);
    await age(fresh, 10);
    await q('SELECT cad_files_supersede_legacy()');
    expect(new Map((await current(noRevision)).map((r) => [r.id, r.superseded_by]))).toEqual(
      new Map([
        [fresh, null],
        [old, fresh],
      ]),
    );
  });
});

describe('migration 0018 constraints', () => {
  it('limits the kind to general | secondary and defaults existing-style inserts to general', async () => {
    const project = await newProject();
    const id = await insertFile(project);
    const row = await q('SELECT drawing_kind FROM cad_files WHERE id = $1', [id]);
    expect(row.rows[0].drawing_kind).toBe('general');
    const bad = randomUUID();
    expect(
      await sqlState(
        q(
          `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key, drawing_kind)
           VALUES ($1, $2, 'x.dxf', 'dxf', 1, repeat('a', 64), $3, 'third')`,
          [bad, project, `projects/${project}/cad/${bad}/o.dxf`],
        ),
      ),
    ).toBe('23514');
  });

  it('never changes the kind of a file', async () => {
    const project = await newProject();
    const id = await insertFile(project, 'secondary');
    expect(
      await sqlState(q(`UPDATE cad_files SET drawing_kind = 'general' WHERE id = $1`, [id])),
    ).toBe('23001');
    // Other updates still work.
    expect(await sqlState(q(`UPDATE cad_files SET log = 'ok' WHERE id = $1`, [id]))).toBe(null);
  });

  it('sets superseded_at and superseded_by together, never to itself, and never back', async () => {
    const project = await newProject();
    const [oldId, newId] = [await insertFile(project), await insertFile(project)];
    expect(
      await sqlState(q(`UPDATE cad_files SET superseded_at = now() WHERE id = $1`, [oldId])),
    ).toBe('23514');
    expect(
      await sqlState(
        q(`UPDATE cad_files SET superseded_at = now(), superseded_by = id WHERE id = $1`, [oldId]),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        q(`UPDATE cad_files SET superseded_at = now(), superseded_by = $2 WHERE id = $1`, [
          oldId,
          newId,
        ]),
      ),
    ).toBe(null);
    expect(
      await sqlState(
        q(`UPDATE cad_files SET superseded_at = NULL, superseded_by = NULL WHERE id = $1`, [oldId]),
      ),
    ).toBe('23001');
    // The foreign key keeps the replacement inside the same project.
    const other = await newProject();
    const stranger = await insertFile(other);
    const mine = await insertFile(project);
    expect(
      await sqlState(
        q(`UPDATE cad_files SET superseded_at = now(), superseded_by = $2 WHERE id = $1`, [
          mine,
          stranger,
        ]),
      ),
    ).toBe('23503');
  });

  it('only lets a file be superseded by a file of the same kind', async () => {
    const project = await newProject();
    const general = await insertFile(project, 'general');
    const secondary = await insertFile(project, 'secondary');
    expect(
      await sqlState(
        q(`UPDATE cad_files SET superseded_at = now(), superseded_by = $2 WHERE id = $1`, [
          general,
          secondary,
        ]),
      ),
    ).toBe('23001');
    const sameKind = await insertFile(project, 'general');
    expect(
      await sqlState(
        q(`UPDATE cad_files SET superseded_at = now(), superseded_by = $2 WHERE id = $1`, [
          general,
          sameKind,
        ]),
      ),
    ).toBe(null);
  });

  it("requires a revision's kind to equal its file's kind", async () => {
    const project = await newProject();
    const general = await insertFile(project, 'general');
    const secondary = await insertFile(project, 'secondary');
    expect(await sqlState(insertRevision(project, general, { kind: 'secondary' }))).toBe('23001');
    // The column default is 'general': a secondary file needs its kind spelled out.
    expect(await sqlState(insertRevision(project, secondary))).toBe('23001');
    expect(await sqlState(insertRevision(project, secondary, { kind: 'secondary' }))).toBe(null);
    expect(await sqlState(insertRevision(project, general, { kind: 'general' }))).toBe(null);
  });

  it('freezes the kind on the revision', async () => {
    const project = await newProject();
    const file = await insertFile(project);
    const revision = await insertRevision(project, file);
    expect(
      await sqlState(
        q(`UPDATE design_revisions SET drawing_kind = 'secondary' WHERE id = $1`, [revision]),
      ),
    ).toBe('23001');
  });

  it('allows one open revision per kind, so both kinds can be open together', async () => {
    const project = await newProject();
    const g1 = await insertFile(project, 'general');
    const g2 = await insertFile(project, 'general');
    const s1 = await insertFile(project, 'secondary');
    const s2 = await insertFile(project, 'secondary');
    expect(await sqlState(insertRevision(project, g1, { kind: 'general' }))).toBe(null);
    expect(await sqlState(insertRevision(project, s1, { kind: 'secondary' }))).toBe(null);
    expect(await sqlState(insertRevision(project, g2, { kind: 'general', status: 'queued' }))).toBe(
      '23505',
    );
    expect(
      await sqlState(insertRevision(project, s2, { kind: 'secondary', status: 'building' })),
    ).toBe('23505');
    // A failed or discarded one does not count as open.
    await q(`UPDATE design_revisions SET status = 'discarded' WHERE project_id = $1`, [project]);
    expect(await sqlState(insertRevision(project, g2, { kind: 'general' }))).toBe(null);
  });

  it('numbers revisions per kind: the pair shares a rev_no, a kind never repeats one', async () => {
    const project = await newProject();
    const publish = async (kind: DrawingKind, revNo: number) => {
      const file = await insertFile(project, kind);
      const id = await insertRevision(project, file, { kind });
      try {
        await q(
          `UPDATE design_revisions SET status = 'published', rev_no = $2, published_at = now() WHERE id = $1`,
          [id, revNo],
        );
      } catch (error) {
        // Keep the project free of a leftover open draft for the next attempt.
        await q(`UPDATE design_revisions SET status = 'discarded' WHERE id = $1`, [id]);
        throw error;
      }
    };
    await publish('general', 1);
    await publish('secondary', 1);
    expect(await sqlState(publish('general', 1))).toBe('23505');
    expect(await sqlState(publish('secondary', 1))).toBe('23505');
    expect(await sqlState(publish('general', 2))).toBe(null);
  });
});

describe('uploading a drawing of a kind', () => {
  const upload = (project: string, query: string, name = 'plan.dxf') =>
    as(admin)(http().post(`${filesUrl(project)}${query}`)).attach('file', DXF, name);

  /** Original objects of a project on disk (the storage root is shared by the whole run). */
  async function storedObjects(project: string): Promise<number> {
    try {
      const entries = await readdir(join(ctx.storageRoot, 'projects', project, 'cad'), {
        recursive: true,
        withFileTypes: true,
      });
      return entries.filter((entry) => entry.isFile()).length;
    } catch {
      return 0;
    }
  }

  it('requires the kind: 400 VALIDATION_FAILED without it, or with a bad one', async () => {
    const project = await newProject();
    for (const query of ['', '?newVersion=true', '?kind=third', '?kind=general&newVersion=maybe']) {
      const res = await upload(project, query);
      expect(res.status, query).toBe(400);
      expect(res.body.code, query).toBe('VALIDATION_FAILED');
    }
    expect(await storedObjects(project)).toBe(0);
    expect((await q('SELECT 1 FROM cad_files WHERE project_id = $1', [project])).rowCount).toBe(0);
  });

  it('refuses a second file of the kind without newVersion and stores nothing for it', async () => {
    const project = await newProject();
    const first = await upload(project, '?kind=general', 'first.dxf');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(CadFileSummarySchema.parse(first.body)).toMatchObject({
      drawingKind: 'general',
      supersededAt: null,
      supersededById: null,
    });
    expect(await storedObjects(project)).toBe(1);

    for (const query of ['?kind=general', '?kind=general&newVersion=false']) {
      const again = await upload(project, query, 'second.dxf');
      expect(again.status, query).toBe(409);
      expect(again.body.code).toBe('CONFLICT');
      expect(KindExistsDetailsSchema.parse(again.body.details)).toEqual({
        reason: 'KIND_EXISTS',
        kind: 'general',
        currentFileId: first.body.id,
        currentFileName: 'first.dxf',
      });
    }
    expect(await storedObjects(project)).toBe(1);
    expect((await q('SELECT 1 FROM cad_files WHERE project_id = $1', [project])).rowCount).toBe(1);
  });

  it('keeps the old file as history when newVersion=true supersedes it, and the kinds apart', async () => {
    const project = await newProject();
    const first = await upload(project, '?kind=general', 'v1.dxf');
    const secondary = await upload(project, '?kind=secondary', 'sec.dxf');
    expect(secondary.status, JSON.stringify(secondary.body)).toBe(201);
    expect(secondary.body.drawingKind).toBe('secondary');

    const next = await upload(project, '?kind=general&newVersion=true', 'v2.dxf');
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body).toMatchObject({ drawingKind: 'general', supersededAt: null });

    // The old version stays in the system (readable by id) but is not listed (owner 2026-11-11).
    const list = await as(admin)(http().get(filesUrl(project)));
    const byId = new Map(
      (list.body.items as { id: string }[]).map((item) => [item.id, item as never]),
    );
    expect(byId.has(first.body.id)).toBe(false);
    const old = await as(admin)(http().get(`${filesUrl(project)}/${first.body.id}`)).expect(200);
    expect(old.body).toMatchObject({
      supersededById: next.body.id,
      supersededAt: expect.any(String),
    });
    expect(byId.get(secondary.body.id)).toMatchObject({ supersededAt: null, supersededById: null });
    expect(byId.get(next.body.id)).toMatchObject({ supersededAt: null });
    expect(await storedObjects(project)).toBe(3);

    const event = await q(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'cad_file.uploaded'`,
      [next.body.id],
    );
    expect(event.rows[0].payload).toMatchObject({
      drawingKind: 'general',
      supersededFileIds: [first.body.id],
    });
    const firstEvent = await q(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'cad_file.uploaded'`,
      [first.body.id],
    );
    expect(firstEvent.rows[0].payload).toMatchObject({ supersededFileIds: [] });
  });

  it('ignores newVersion when the kind has no file yet', async () => {
    const project = await newProject();
    const res = await upload(project, '?kind=secondary&newVersion=true');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ drawingKind: 'secondary', supersededAt: null });
  });

  it('lets only one of two concurrent first uploads win', async () => {
    const project = await newProject();
    const results = await Promise.all([
      upload(project, '?kind=general', 'a.dxf'),
      upload(project, '?kind=general', 'b.dxf'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const current = await q(
      `SELECT count(*)::int AS n FROM cad_files
       WHERE project_id = $1 AND drawing_kind = 'general' AND superseded_at IS NULL`,
      [project],
    );
    expect(current.rows[0].n).toBe(1);
  });

  it('discards the open revision of the kind when a new version is accepted, and only that one', async () => {
    const mapAndBuild = async (project: string, file: string) => {
      await q(`UPDATE cad_files SET status = 'processed', processed_at = now() WHERE id = $1`, [
        file,
      ]);
      const saved = await as(admin)(http().put(`${filesUrl(project)}/${file}/mapping`)).send({
        rules: [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }],
        crsEpsg: 32636,
        drawingUnit: 'm',
        version: null,
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const created = await as(admin)(http().post(revisionsUrl(project))).send({
        cadFileId: file,
        mappingVersion: 1,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(202);
      return created.body.id as string;
    };
    const project = await newProject();
    const v1 = await upload(project, '?kind=general', 'v1.dxf');
    const g1 = await mapAndBuild(project, v1.body.id);
    const sec = await upload(project, '?kind=secondary', 'sec.dxf');
    const s1 = await mapAndBuild(project, sec.body.id);
    const otherProject = await newProject();
    const other = await upload(otherProject, '?kind=general', 'other.dxf');
    const o1 = await mapAndBuild(otherProject, other.body.id);
    const jobOf = async (id: string) =>
      (await q('SELECT current_job_id FROM design_revisions WHERE id = $1', [id])).rows[0]
        .current_job_id;
    const jobBefore = await jobOf(g1);

    const v2 = await upload(project, '?kind=general&newVersion=true', 'v2.dxf');
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);

    const statuses = await q(
      'SELECT id, status FROM design_revisions WHERE id = ANY($1) ORDER BY id',
      [[g1, s1, o1]],
    );
    const status = new Map(statuses.rows.map((r) => [r.id, r.status]));
    expect(status.get(g1)).toBe('discarded');
    expect(status.get(s1)).toBe('queued');
    expect(status.get(o1)).toBe('queued');
    // A worker still building G1 is superseded: its job id changed.
    expect(await jobOf(g1)).not.toBe(jobBefore);
    expect(await eventTypes(ctx.pool, g1)).toEqual([
      'design_revision.queued',
      'design_revision.discarded',
    ]);
    const uploaded = await q(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'cad_file.uploaded'`,
      [v2.body.id],
    );
    expect(uploaded.rows[0].payload).toMatchObject({
      supersededFileIds: [v1.body.id],
      discardedRevisionId: g1,
    });
    // Without an open revision the field is null.
    const sec2 = await upload(project, '?kind=secondary&newVersion=true', 'sec2.dxf');
    expect(sec2.status).toBe(201);
    const first = await q(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'cad_file.uploaded'`,
      [v1.body.id],
    );
    expect(first.rows[0].payload.discardedRevisionId).toBeNull();

    // Building from the new version works now.
    await mapAndBuild(project, v2.body.id);
  });

  it('refuses to build from a superseded file (NOT_CURRENT_VERSION)', async () => {
    const project = await newProject();
    const old = await upload(project, '?kind=general', 'old.dxf');
    await q(`UPDATE cad_files SET status = 'processed', processed_at = now() WHERE id = $1`, [
      old.body.id,
    ]);
    const mapping = await as(admin)(http().put(`${filesUrl(project)}/${old.body.id}/mapping`)).send(
      {
        rules: [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }],
        crsEpsg: 32636,
        drawingUnit: 'm',
        version: null,
      },
    );
    expect(mapping.status, JSON.stringify(mapping.body)).toBe(200);
    await upload(project, '?kind=general&newVersion=true', 'new.dxf');

    const res = await as(admin)(http().post(revisionsUrl(project))).send({
      cadFileId: old.body.id,
      mappingVersion: 1,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'NOT_CURRENT_VERSION' });
    expect(
      (await q('SELECT 1 FROM design_revisions WHERE project_id = $1', [project])).rowCount,
    ).toBe(0);
  });
});

describe('publishing the pair', () => {
  const place = JSON.stringify({
    sourceCrs: 'project',
    points: [{ id: 'p1', drawing: { x: 1, y: 1 }, lat: 30.9, lon: 32.7, source: 'typed' }],
  });

  interface Pair {
    project: string;
    generalFile: string;
    secondaryFile: string;
  }

  /** A project with a processed General and Secondary and a saved mapping (with a placement) each. */
  async function newPair(withPlacement = true): Promise<Pair> {
    const project = await newProject();
    const generalFile = await insertFile(project, 'general');
    const secondaryFile = await insertFile(project, 'secondary');
    for (const file of [generalFile, secondaryFile]) {
      const res = await as(admin)(http().put(`${filesUrl(project)}/${file}/mapping`)).send({
        rules: [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }],
        crsEpsg: 32636,
        drawingUnit: 'm',
        version: null,
        ...(withPlacement ? { placement: JSON.parse(place) } : {}),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    return { project, generalFile, secondaryFile };
  }

  const createRevision = async (pair: Pair, file: string, version = 1) => {
    const res = await as(admin)(http().post(revisionsUrl(pair.project))).send({
      cadFileId: file,
      mappingVersion: version,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    return DesignRevisionSummarySchema.parse(res.body);
  };

  /** What the worker does when the build ends: building, then draft. */
  async function build(revisionId: string): Promise<void> {
    await q(
      `UPDATE design_revisions SET status = 'building', build_started_at = now() WHERE id = $1`,
      [revisionId],
    );
    await q(
      `UPDATE design_revisions SET status = 'draft', built_at = now(),
              counts = $2, text_link_counts = $3, diff_counts = $4 WHERE id = $1`,
      [
        revisionId,
        JSON.stringify({
          features: { route: 0, box: 0, hhi: 0, joint: 0, mh: 0 },
          routeLengthM: '0',
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
      ],
    );
  }

  const publish = (project: string, revisionId: string, body: object = {}) =>
    as(admin)(http().post(`${revisionsUrl(project)}/${revisionId}/publish`)).send(body);
  const readiness = async (project: string, revisionId: string) =>
    PublishReadinessSchema.parse(
      (await as(admin)(http().get(`${revisionsUrl(project)}/${revisionId}/publish-readiness`)))
        .body,
    );
  const problem = (count: number) => ({
    code: 'LABEL_MISSING',
    severity: 'warning',
    count,
    items: [],
  });
  const setWarnings = (revisionId: string, warnings: unknown[]) =>
    q('UPDATE design_revisions SET warnings = $2 WHERE id = $1', [
      revisionId,
      JSON.stringify(warnings),
    ]);

  it('creates one open revision per kind, each with its kind', async () => {
    const pair = await newPair();
    const general = await createRevision(pair, pair.generalFile);
    const secondary = await createRevision(pair, pair.secondaryFile);
    expect(general.drawingKind).toBe('general');
    expect(secondary.drawingKind).toBe('secondary');
    const again = await as(admin)(http().post(revisionsUrl(pair.project))).send({
      cadFileId: pair.generalFile,
      mappingVersion: 1,
    });
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: 'REVISION_IN_PROGRESS' });
  });

  it('refuses OTHER_DRAWING_MISSING with no other revision, and while the other is not a draft', async () => {
    const pair = await newPair();
    const general = await createRevision(pair, pair.generalFile);
    await build(general.id);

    const alone = await publish(pair.project, general.id);
    expect(alone.status, JSON.stringify(alone.body)).toBe(409);
    expect(alone.body.details).toEqual({
      reason: 'OTHER_DRAWING_MISSING',
      drawingKind: 'secondary',
    });
    expect(await readiness(pair.project, general.id)).toMatchObject({
      drawingKind: 'general',
      otherRevisionId: null,
      canPublish: false,
      checks: expect.arrayContaining([{ key: 'other_drawing', ok: false, count: null }]),
    });

    // Queued is open but not a draft yet.
    const secondary = await createRevision(pair, pair.secondaryFile);
    const queued = await publish(pair.project, general.id);
    expect(queued.body.details).toEqual({
      reason: 'OTHER_DRAWING_MISSING',
      drawingKind: 'secondary',
    });
    expect(secondary.status).toBe('queued');
    const status = await q('SELECT status FROM design_revisions WHERE id = $1', [general.id]);
    expect(status.rows[0].status).toBe('draft');
  });

  it("reports a blocker of the other drawing with that drawing's kind", async () => {
    const pair = await newPair();
    const general = await createRevision(pair, pair.generalFile);
    const secondary = await createRevision(pair, pair.secondaryFile);
    await build(general.id);
    await build(secondary.id);
    await setWarnings(secondary.id, [problem(4)]);

    for (const revision of [general.id, secondary.id]) {
      const res = await publish(pair.project, revision);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details).toEqual({
        reason: 'PROBLEMS_OPEN',
        drawingKind: 'secondary',
        problemCount: 4,
      });
    }
    const ready = await readiness(pair.project, general.id);
    expect(ready.checks.map((c) => [c.key, c.ok, c.count])).toEqual([
      ['crs_known', true, null],
      ['control_point', true, 1],
      ['no_problems', true, 0],
      ['open_items', true, 0],
      ['other_drawing', false, 4],
    ]);
    expect(ready).toMatchObject({ canPublish: false, otherRevisionId: secondary.id });

    // This drawing's own blocker comes first.
    await setWarnings(general.id, [problem(1)]);
    expect((await publish(pair.project, general.id)).body.details).toEqual({
      reason: 'PROBLEMS_OPEN',
      drawingKind: 'general',
      problemCount: 1,
    });
  });

  it('reports a missing placement of the other drawing', async () => {
    const pair = await newPair(false);
    // General placed through its mapping; the Secondary has none.
    const placed = await as(admin)(
      http().put(`${filesUrl(pair.project)}/${pair.generalFile}/mapping`),
    ).send({
      rules: [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }],
      crsEpsg: 32636,
      drawingUnit: 'm',
      version: 1,
      placement: JSON.parse(place),
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(200);
    const general = await createRevision(pair, pair.generalFile, 2);
    const secondary = await createRevision(pair, pair.secondaryFile);
    await build(general.id);
    await build(secondary.id);
    const res = await publish(pair.project, general.id);
    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({ reason: 'CRS_UNKNOWN', drawingKind: 'secondary' });
  });

  it('publishes both drawings together with one rev_no, then numbers the next pair 2', async () => {
    const pair = await newPair();
    const general = await createRevision(pair, pair.generalFile);
    const secondary = await createRevision(pair, pair.secondaryFile);
    await build(general.id);
    await build(secondary.id);

    const ready = await readiness(pair.project, secondary.id);
    expect(ready).toMatchObject({
      canPublish: true,
      drawingKind: 'secondary',
      otherRevisionId: general.id,
      needsAcknowledgement: false,
    });

    const res = await publish(pair.project, secondary.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(DesignRevisionDetailSchema.parse(res.body)).toMatchObject({
      id: secondary.id,
      drawingKind: 'secondary',
      status: 'published',
      revNo: 1,
    });
    const rows = await q(
      `SELECT id, drawing_kind, status, rev_no, published_at, published_by FROM design_revisions
       WHERE project_id = $1 ORDER BY drawing_kind`,
      [pair.project],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => [r.drawing_kind, r.status, r.rev_no])).toEqual([
      ['general', 'published', 1],
      ['secondary', 'published', 1],
    ]);
    expect(rows.rows[0].published_at).toEqual(rows.rows[1].published_at);
    expect(rows.rows[0].published_by).toBe(rows.rows[1].published_by);

    for (const [self, pairId, kind] of [
      [general.id, secondary.id, 'general'],
      [secondary.id, general.id, 'secondary'],
    ] as const) {
      expect(await eventTypes(ctx.pool, self)).toEqual([
        'design_revision.queued',
        'design_revision.published',
      ]);
      const event = await q(
        `SELECT payload FROM events WHERE entity_id = $1 AND type = 'design_revision.published'`,
        [self],
      );
      expect(event.rows[0].payload).toMatchObject({
        revNo: 1,
        drawingKind: kind,
        pairRevisionId: pairId,
      });
    }

    // The next pair: each revision is based on the published one of its own kind and both get 2.
    const general2 = await createRevision(pair, pair.generalFile);
    const secondary2 = await createRevision(pair, pair.secondaryFile);
    expect(general2.baseRevisionId).toBe(general.id);
    expect(secondary2.baseRevisionId).toBe(secondary.id);
    await build(general2.id);
    await build(secondary2.id);
    expect((await publish(pair.project, general2.id)).body).toMatchObject({ revNo: 2 });
    const numbers = await q(
      `SELECT drawing_kind, rev_no FROM design_revisions WHERE project_id = $1 AND rev_no = 2 ORDER BY 1`,
      [pair.project],
    );
    expect(numbers.rows).toEqual([
      { drawing_kind: 'general', rev_no: 2 },
      { drawing_kind: 'secondary', rev_no: 2 },
    ]);
    // Already published: no second publish.
    const again = await publish(pair.project, general2.id);
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: 'NOT_DRAFT' });
  });

  it('asks for acknowledgement of the open items of both drawings, summed', async () => {
    const pair = await newPair();
    const general = await createRevision(pair, pair.generalFile);
    const secondary = await createRevision(pair, pair.secondaryFile);
    await build(general.id);
    await build(secondary.id);
    // A text link to review in each drawing.
    for (const [revision, handle] of [
      [general.id, 'T1'],
      [secondary.id, 'T2'],
    ] as const) {
      await q(
        `INSERT INTO text_links (id, project_id, revision_id, text_handle, layer, text, raw_text, readable,
                                 position, height_m, kind, status, confidence)
         VALUES ($1, $2, $3, $4, 'TXT', '1-1', '1-1', true,
                 ST_SetSRID(ST_MakePoint(${E0}, ${N0}), 32636), 2.5, 'box_id', 'review', 0.4)`,
        [randomUUID(), pair.project, revision, handle],
      );
    }
    const ready = await readiness(pair.project, general.id);
    expect(ready.checks.find((c) => c.key === 'open_items')).toEqual({
      key: 'open_items',
      ok: false,
      count: 2,
    });
    expect(ready).toMatchObject({ canPublish: true, needsAcknowledgement: true });
    const refused = await publish(pair.project, general.id);
    expect(refused.status).toBe(409);
    expect(refused.body.details).toEqual({
      reason: 'OPEN_ITEMS',
      textLinksToReview: 2,
      diffConflicts: 0,
    });
    const ok = await publish(pair.project, general.id, { acknowledgeOpenItems: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

describe('readers of the latest published revision stay on the General', () => {
  let fx: ExecutionFixture;
  let secondaryRevision: string;
  const secondaryFeature = randomUUID();

  beforeAll(async () => {
    fx = await createExecutionFixture(ctx);
    // A Secondary published AFTER the General with a higher rev_no: it would win a plain "latest".
    secondaryRevision = await publishRevision(
      ctx.pool,
      fx.projectId,
      [
        {
          id: secondaryFeature,
          type: 'box',
          wkt: `POINT(${E0 + 60} ${N0 + 6})`,
          code: 'S-1',
          isNew: true,
        },
      ],
      7,
      'secondary',
    );
  }, 180_000);

  it('serves the sync bundle from the General only', async () => {
    const res = await http()
      .get(`/projects/${fx.projectId}/sync/bootstrap`)
      .set('Authorization', `Bearer ${fx.tokens.qc}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bundle = OfflineBundleSchema.parse(res.body);
    expect(bundle.revision?.id).toBe(fx.revisionId);
    expect(bundle.revision?.id).not.toBe(secondaryRevision);
    const ids = bundle.features.map((feature) => feature.id);
    expect(ids).toContain(fx.boxA);
    expect(ids).not.toContain(secondaryFeature);
  });

  it('reads the As-Built state and lengths against the General only', async () => {
    const state = await http()
      .get(`/projects/${fx.projectId}/asbuilt/state`)
      .set('Authorization', `Bearer ${fx.tokens.qc}`);
    expect(state.status, JSON.stringify(state.body)).toBe(200);
    expect(state.body.revisionId).toBe(fx.revisionId);
    expect((state.body.features as { featureId: string }[]).map((f) => f.featureId)).not.toContain(
      secondaryFeature,
    );

    const lengths = await http()
      .get(`/projects/${fx.projectId}/asbuilt/lengths`)
      .set('Authorization', `Bearer ${fx.tokens.qc}`);
    expect(lengths.status, JSON.stringify(lengths.body)).toBe(200);
    expect(lengths.body.revisionId).toBe(fx.revisionId);
  });
});
