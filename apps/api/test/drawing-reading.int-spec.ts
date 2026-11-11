import { randomUUID } from 'node:crypto';
import {
  DRAWING_PROBLEM_CODES,
  DrawingProblemListSchema,
  PublishReadinessSchema,
  type DrawingKind,
} from '@ftth/shared';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { loginAs, SEED_LOGINS } from './support/helpers.js';
import { startRedis, type TestRedis } from './support/redis.js';
import { createTestContext, type TestContext } from './support/test-app.js';

/**
 * ADR-041 (API side): kind validation of the mapping, blocking totals of the problem list, the
 * cabinets comparison in the readiness and publish gate, and the widened problem-code check.
 * The worker's side is simulated with SQL, as in the other design-revision tests.
 */

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
const q = (text: string, values: unknown[] = []) => ctx.pool.query(text, values);

async function newProject(): Promise<string> {
  const created = await q(
    `INSERT INTO projects (name, client, crs_epsg, currency, locale)
     VALUES ($1, 'WE', 32636, 'EGP', 'ar') RETURNING id`,
    [`Reading ${randomUUID()}`],
  );
  return created.rows[0]?.id ?? '';
}

async function insertFile(project: string, kind: DrawingKind): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                            status, current_job_id, processed_at, drawing_kind)
     VALUES ($1, $2, $3, 'dxf', 100, repeat('a', 64), $4, 'processed', $5, now(), $6)`,
    [
      id,
      project,
      `${kind}-${id.slice(0, 6)}.dxf`,
      `projects/${project}/cad/${id}/o.dxf`,
      randomUUID(),
      kind,
    ],
  );
  return id;
}

const placement = {
  sourceCrs: 'project',
  points: [{ id: 'p1', drawing: { x: 1, y: 1 }, lat: 30.9, lon: 32.7, source: 'typed' }],
};

const putMapping = (
  project: string,
  file: string,
  rules: unknown[],
  version: number | null = null,
) =>
  as(admin)(http().put(`${filesUrl(project)}/${file}/mapping`)).send({
    rules,
    crsEpsg: 32636,
    drawingUnit: 'm',
    version,
    placement,
  });

describe('mapping rules and the drawing kind (ADR-041)', () => {
  it('keeps textRoles, ways and zone through save and read', async () => {
    const project = await newProject();
    const file = await insertFile(project, 'secondary');
    const rules = [
      { source: 'layer', layer: 'TXTNMPER', target: 'label', textRoles: ['box_number'] },
      { source: 'layer', layer: 'N_1WAY', target: 'route', ways: 1 },
      { source: 'layer', layer: 'CBZONE', target: 'zone' },
    ];
    const saved = await putMapping(project, file, rules);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.rules).toEqual(rules);
    const read = await as(admin)(http().get(`${filesUrl(project)}/${file}/mapping`));
    expect(read.body.mapping.rules).toEqual(rules);
    const stored = await q('SELECT rules FROM cad_mappings WHERE cad_file_id = $1', [file]);
    expect(stored.rows[0].rules).toEqual(rules);
  });

  it('answers 422 ROLE_NOT_FOR_KIND for a role of the other kind and saves nothing', async () => {
    const project = await newProject();
    const file = await insertFile(project, 'secondary');
    const res = await putMapping(project, file, [
      { source: 'layer', layer: 'HH', target: 'label', textRoles: ['handhole_type'] },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      reason: 'ROLE_NOT_FOR_KIND',
      problems: [{ index: 0, reason: 'ROLE_NOT_FOR_KIND', role: 'handhole_type' }],
    });
    const rows = await q('SELECT 1 FROM cad_mappings WHERE cad_file_id = $1', [file]);
    expect(rows.rowCount).toBe(0);
  });

  it('answers 422 ZONE_NOT_FOR_KIND for a zone layer in a General', async () => {
    const project = await newProject();
    const file = await insertFile(project, 'general');
    const res = await putMapping(project, file, [
      { source: 'layer', layer: 'CBZONE', target: 'zone' },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ reason: 'ZONE_NOT_FOR_KIND', drawingKind: 'general' });
  });

  it('still answers 400 for a role that does not fit its target', async () => {
    const project = await newProject();
    const file = await insertFile(project, 'general');
    const res = await putMapping(project, file, [
      { source: 'layer', layer: 'X', target: 'route', textRoles: ['handhole_type'] },
    ]);
    expect(res.status).toBe(400);
  });
});

describe('handhole type aliases on the mapping (owner 2026-11-11)', () => {
  const hh = {
    source: 'layer',
    layer: 'HHTXT',
    target: 'label',
    textRoles: ['handhole_number', 'handhole_type'],
    handholeTypeAliases: { HH2: 'HH-II', CH: 'HH-II' },
  };

  it('stores and returns the aliases, and a re-save with the version keeps them', async () => {
    const project = await newProject();
    const file = await insertFile(project, 'general');
    const saved = await putMapping(project, file, [hh]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.rules[0].handholeTypeAliases).toEqual({ HH2: 'HH-II', CH: 'HH-II' });
    const read = await as(admin)(http().get(`${filesUrl(project)}/${file}/mapping`));
    expect(read.body.mapping.rules[0].handholeTypeAliases).toEqual({ HH2: 'HH-II', CH: 'HH-II' });
    const stored = await q('SELECT rules FROM cad_mappings WHERE cad_file_id = $1', [file]);
    expect(stored.rows[0].rules[0].handholeTypeAliases).toEqual({ HH2: 'HH-II', CH: 'HH-II' });
    const again = await putMapping(
      project,
      file,
      [{ ...hh, handholeTypeAliases: { HH2: 'HH-II', CH: 'HH-II', X: 'DH' } }],
      saved.body.version,
    );
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.rules[0].handholeTypeAliases).toEqual({ HH2: 'HH-II', CH: 'HH-II', X: 'DH' });
  });

  it('refuses aliases on a rule without the handhole_type role, and an unknown type', async () => {
    const project = await newProject();
    const file = await insertFile(project, 'general');
    const noRole = await putMapping(project, file, [{ ...hh, textRoles: ['handhole_number'] }]);
    expect(noRole.status).toBe(400);
    const badType = await putMapping(project, file, [
      { ...hh, handholeTypeAliases: { HH2: 'HH-9' } },
    ]);
    expect(badType.status).toBe(400);
    const rows = await q('SELECT 1 FROM cad_mappings WHERE cad_file_id = $1', [file]);
    expect(rows.rowCount).toBe(0);
  });
});

describe('corrections accept every problem code (migration 0020)', () => {
  it('takes all codes of DRAWING_PROBLEM_CODES and refuses an unknown one', async () => {
    const project = await newProject();
    const file = await insertFile(project, 'general');
    const insert = (code: string) =>
      q(
        `INSERT INTO cad_file_corrections (id, project_id, cad_file_id, correction, problem_code, problem_handle)
         VALUES ($1, $2, $3, '{}'::jsonb, $4, 'H')`,
        [randomUUID(), project, file, code],
      );
    for (const code of DRAWING_PROBLEM_CODES) await expect(insert(code)).resolves.toBeDefined();
    await expect(insert('NOPE')).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts the three codes of the owner answers (migration 0021)', async () => {
    const project = await newProject();
    const file = await insertFile(project, 'secondary');
    for (const code of [
      'BOX_CABINET_UNKNOWN',
      'CABINET_NAME_DUPLICATE',
      'CONNECTOR_SIZE_MISSING',
    ]) {
      await q(
        `INSERT INTO cad_file_corrections (id, project_id, cad_file_id, correction, problem_code, problem_handle)
         VALUES ($1, $2, $3, '{}'::jsonb, $4, 'H')`,
        [randomUUID(), project, file, code],
      );
    }
    const rows = await q(
      `SELECT problem_code FROM cad_file_corrections WHERE cad_file_id = $1 ORDER BY problem_code`,
      [file],
    );
    expect(rows.rows.map((r: { problem_code: string }) => r.problem_code)).toEqual([
      'BOX_CABINET_UNKNOWN',
      'CABINET_NAME_DUPLICATE',
      'CONNECTOR_SIZE_MISSING',
    ]);
  });
});

describe('problems, cabinets and the publish gate (ADR-041)', () => {
  interface Pair {
    project: string;
    general: string;
    secondary: string;
  }

  /** A project with a General and a Secondary draft, both placed, built and with no problems. */
  async function newPair(): Promise<Pair> {
    const project = await newProject();
    const ids: Record<DrawingKind, string> = { general: '', secondary: '' };
    for (const kind of ['general', 'secondary'] as const) {
      const file = await insertFile(project, kind);
      const saved = await putMapping(project, file, [
        { source: 'layer', layer: 'N_DUC_CBL', target: 'route' },
      ]);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const created = await as(admin)(http().post(revisionsUrl(project))).send({
        cadFileId: file,
        mappingVersion: 1,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(202);
      ids[kind] = created.body.id;
      await q(
        `UPDATE design_revisions SET status = 'building', build_started_at = now() WHERE id = $1`,
        [created.body.id],
      );
      await q(
        `UPDATE design_revisions SET status = 'draft', built_at = now(), counts = $2,
                text_link_counts = $3, diff_counts = $4 WHERE id = $1`,
        [
          created.body.id,
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
    return { project, general: ids.general, secondary: ids.secondary };
  }

  /** The worker writes cabinet features; `name` null = unnamed. */
  async function addCabinet(
    pair: Pair,
    revision: string,
    role: 'main' | 'sub',
    name: string | null,
    handle: string,
  ): Promise<void> {
    const id = randomUUID();
    await q(
      `INSERT INTO features (id, project_id, feature_type, first_revision_id) VALUES ($1, $2, 'cabinet', $3)`,
      [id, pair.project, revision],
    );
    await q(
      `INSERT INTO design_features (revision_id, feature_id, project_id, feature_type, code, layer,
                                    source_kind, source_handle, geom, attrs)
       VALUES ($1, $2, $3, 'cabinet', $4, 'Sap', 'insert', $5, ST_SetSRID(ST_MakePoint(10, 10), 32636), $6::jsonb)`,
      [revision, id, pair.project, name, handle, JSON.stringify({ role })],
    );
  }

  const readiness = async (pair: Pair, revision: string) =>
    PublishReadinessSchema.parse(
      (await as(admin)(http().get(`${revisionsUrl(pair.project)}/${revision}/publish-readiness`)))
        .body,
    );
  const publish = (pair: Pair, revision: string, body: object = {}) =>
    as(admin)(http().post(`${revisionsUrl(pair.project)}/${revision}/publish`)).send(body);
  const setWarnings = (revision: string, warnings: unknown[]) =>
    q('UPDATE design_revisions SET warnings = $2 WHERE id = $1', [
      revision,
      JSON.stringify(warnings),
    ]);
  const problem = (code: string, count: number) => ({
    code,
    severity: 'warning',
    count,
    items: [],
  });

  it('lists blocking places in total and warning places apart', async () => {
    const pair = await newPair();
    await setWarnings(pair.general, [
      problem('LABEL_MISSING', 2),
      problem('SPARE_CORES_MISMATCH', 1),
      problem('CABLE_SLACK_TOO_LONG', 5),
    ]);
    const res = await as(admin)(
      http().get(`${revisionsUrl(pair.project)}/${pair.general}/problems`),
    );
    expect(res.status).toBe(200);
    const list = DrawingProblemListSchema.parse(res.body);
    expect(list.total).toBe(3);
    expect(list.warningTotal).toBe(5);
    expect(list.items.map((p) => p.code)).toEqual([
      'LABEL_MISSING',
      'SPARE_CORES_MISMATCH',
      'CABLE_SLACK_TOO_LONG',
    ]);
  });

  it('still blocks publishing when a blocking problem has an out-of-range param', async () => {
    const pair = await newPair();
    await setWarnings(pair.general, [
      {
        ...problem('SPARE_CORES_MISMATCH', 1),
        items: [
          {
            x: 1,
            y: 1,
            drawingX: 1,
            drawingY: 1,
            layer: 'L',
            handle: 'H',
            suggestedLayer: null,
            text: null,
            near: null,
            params: { mainCores: 1e30 },
          },
        ],
      },
    ]);
    const list = DrawingProblemListSchema.parse(
      (await as(admin)(http().get(`${revisionsUrl(pair.project)}/${pair.general}/problems`))).body,
    );
    expect(list.total).toBe(1);
    const ready = await readiness(pair, pair.general);
    expect(ready.canPublish).toBe(false);
    expect(ready.checks.find((c) => c.key === 'no_problems')).toMatchObject({
      ok: false,
      count: 1,
    });
  });

  it('still blocks publishing when a blocking problem has an out-of-range param', async () => {
    const pair = await newPair();
    await setWarnings(pair.general, [
      {
        ...problem('SPARE_CORES_MISMATCH', 1),
        items: [
          {
            x: 1,
            y: 1,
            drawingX: 1,
            drawingY: 1,
            layer: 'L',
            handle: 'H',
            suggestedLayer: null,
            text: null,
            near: null,
            params: { mainCores: 1e30 },
          },
        ],
      },
    ]);
    const list = DrawingProblemListSchema.parse(
      (await as(admin)(http().get(`${revisionsUrl(pair.project)}/${pair.general}/problems`))).body,
    );
    expect(list.total).toBe(1);
    const ready = await readiness(pair, pair.general);
    expect(ready.canPublish).toBe(false);
    expect(ready.checks.find((c) => c.key === 'no_problems')).toMatchObject({
      ok: false,
      count: 1,
    });
  });

  it('matches the sub cabinets by name: ok, and main cabinets are not compared', async () => {
    const pair = await newPair();
    await addCabinet(pair, pair.general, 'sub', '1-1', 'G1');
    await addCabinet(pair, pair.general, 'sub', '1-2', 'G2');
    await addCabinet(pair, pair.general, 'main', null, 'G3');
    await addCabinet(pair, pair.secondary, 'sub', '1 - 2', 'S1');
    await addCabinet(pair, pair.secondary, 'sub', '1-1', 'S2');
    for (const revision of [pair.general, pair.secondary]) {
      const ready = await readiness(pair, revision);
      expect(ready.checks.map((c) => [c.key, c.ok, c.count])).toEqual([
        ['crs_known', true, null],
        ['control_point', true, 1],
        ['no_problems', true, 0],
        ['open_items', true, 0],
        ['other_drawing', true, 0],
        ['cabinets_match', true, 0],
      ]);
      expect(ready).toMatchObject({
        canPublish: true,
        cabinets: {
          ok: true,
          general: { count: 2, unnamed: 0, missingInOther: [] },
          secondary: { count: 2, unnamed: 0, missingInOther: [] },
        },
      });
    }
  });

  it('lists the unmatched names, locks the checklist and refuses CABINETS_MISMATCH', async () => {
    const pair = await newPair();
    await addCabinet(pair, pair.general, 'sub', '1-1', 'G1');
    await addCabinet(pair, pair.general, 'sub', '1-2', 'G2');
    await addCabinet(pair, pair.general, 'sub', null, 'G3');
    await addCabinet(pair, pair.secondary, 'sub', '1-1', 'S1');
    await addCabinet(pair, pair.secondary, 'sub', '1-3', 'S2');

    const ready = await readiness(pair, pair.secondary);
    expect(ready).toMatchObject({ canPublish: false, otherRevisionId: pair.general });
    expect(ready.checks.find((c) => c.key === 'cabinets_match')).toEqual({
      key: 'cabinets_match',
      ok: false,
      count: 3,
    });
    expect(ready.cabinets).toEqual({
      ok: false,
      general: { count: 3, unnamed: 1, missingInOther: ['1-2'] },
      secondary: { count: 2, unnamed: 0, missingInOther: ['1-3'] },
    });

    for (const revision of [pair.general, pair.secondary]) {
      const res = await publish(pair, revision);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details).toEqual({ reason: 'CABINETS_MISMATCH', cabinets: ready.cabinets });
    }
    const state = await q('SELECT status FROM design_revisions WHERE id = ANY($1)', [
      [pair.general, pair.secondary],
    ]);
    expect(state.rows.map((r) => r.status)).toEqual(['draft', 'draft']);
  });

  it('checks the cabinets after both own blockers and before open items', async () => {
    const pair = await newPair();
    await addCabinet(pair, pair.general, 'sub', '1-1', 'G1');
    await q(
      `UPDATE design_revisions SET diff_counts = jsonb_set(diff_counts, '{conflict}', '2') WHERE id = $1`,
      [pair.general],
    );
    const mismatch = await publish(pair, pair.general, { acknowledgeOpenItems: true });
    expect(mismatch.body.details).toMatchObject({ reason: 'CABINETS_MISMATCH' });

    await setWarnings(pair.secondary, [problem('BOX_NOT_REACHED', 1)]);
    expect((await publish(pair, pair.general)).body.details).toEqual({
      reason: 'PROBLEMS_OPEN',
      drawingKind: 'secondary',
      problemCount: 1,
    });
  });

  it('publishes a pair that has only warnings and names the same cabinets', async () => {
    const pair = await newPair();
    await addCabinet(pair, pair.general, 'sub', '1-1', 'G1');
    await addCabinet(pair, pair.secondary, 'sub', '1-1', 'S1');
    await setWarnings(pair.general, [problem('CABLE_SLACK_TOO_LONG', 3)]);
    const ready = await readiness(pair, pair.general);
    expect(ready).toMatchObject({ canPublish: true, warningCount: 3 });
    expect(ready.checks.find((c) => c.key === 'no_problems')).toEqual({
      key: 'no_problems',
      ok: true,
      count: 0,
    });
    const res = await publish(pair, pair.general);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'published', revNo: 1 });
  });

  it('is not ok without the other draft and gives no comparison', async () => {
    const pair = await newPair();
    await q(`UPDATE design_revisions SET status = 'discarded' WHERE id = $1`, [pair.secondary]);
    const ready = await readiness(pair, pair.general);
    expect(ready.cabinets).toBeNull();
    expect(ready.checks.find((c) => c.key === 'cabinets_match')).toEqual({
      key: 'cabinets_match',
      ok: false,
      count: null,
    });
  });

  it('does not read cabinets of another project or revision', async () => {
    const pair = await newPair();
    const other = await newPair();
    await addCabinet(other, other.general, 'sub', '9-9', 'X1');
    await addCabinet(pair, pair.general, 'sub', '1-1', 'G1');
    await addCabinet(pair, pair.secondary, 'sub', '1-1', 'S1');
    expect((await readiness(pair, pair.general)).cabinets?.ok).toBe(true);
  });
});
