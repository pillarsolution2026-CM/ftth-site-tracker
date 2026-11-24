import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CadFileSummarySchema,
  OfflineBundleSchema,
  PublishReadinessSchema,
  SiteDrawingsResponseSchema,
  UploadRefusedDetailsSchema,
} from '@ftth/shared';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createApprovedContract,
  createProjectIn,
  createWorkOrderFrom,
} from './support/contract-fixtures.js';
import {
  createExecutionFixture,
  publishRevision,
  type ExecutionFixture,
} from './support/execution-fixtures.js';
import { insertDrawing } from './support/drawing-fixtures.js';
import { loginAs, SEED_LOGINS } from './support/helpers.js';
import { startRedis, type TestRedis } from './support/redis.js';
import { createTestContext, type TestContext } from './support/test-app.js';
import { makeBoxTypesClear } from './support/box-types-fixtures.js';

/**
 * ADR-049 part B: drawings belong to a site of the work order. The migration backfill runs on its own
 * database built to 0025; the rest is the real API on PostGIS (the CAD worker is simulated with SQL).
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
const DXF = Buffer.from('  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nEOF\n');

let testRedis: TestRedis;
let ctx: TestContext;
let admin: string;
let fx: ExecutionFixture;

beforeAll(async () => {
  testRedis = await startRedis();
  ctx = await createTestContext(inject('databaseUrl'), { REDIS_URL: testRedis.url });
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
  fx = await createExecutionFixture(ctx);
}, 180_000);
afterAll(async () => {
  await ctx?.close();
  await testRedis?.stop();
});

const http = () => request(ctx.app.getHttpServer());
const as = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
const q = (text: string, values: unknown[] = []) => ctx.pool.query(text, values);
const filesUrl = (p: string) => `/projects/${p}/cad-files`;
const revisionsUrl = (p: string) => `/projects/${p}/design-revisions`;

async function sqlState(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

// ---------------------------------------------------------------------------------------------
// Migration 0026 on a database built to 0025 with legacy data

describe('migration 0026 backfill', () => {
  it('moves a project with one work order into a new site, and keeps unassigned drawings of the others', async () => {
    const adminClient = new pg.Client({ connectionString: inject('databaseUrl') });
    await adminClient.connect();
    const dbName = `backfill_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await adminClient.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(inject('databaseUrl'));
    url.pathname = `/${dbName}`;
    const db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    try {
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql') && !f.startsWith('0026'))
        .sort();
      for (const file of files) await db.query(readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8'));

      const project = async (name: string) =>
        (
          await db.query<{ id: string }>(
            `INSERT INTO projects (name, client, crs_epsg, currency, locale)
             VALUES ($1, 'WE', 32636, 'EGP', 'ar') RETURNING id`,
            [name],
          )
        ).rows[0]?.id ?? '';
      const file = async (p: string, kind: string, superseded?: string) => {
        const id = randomUUID();
        await db.query(
          `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                                  status, current_job_id, processed_at, drawing_kind)
           VALUES ($1, $2, $3, 'dxf', 100, repeat('a', 64), $4, 'processed', $5, now(), $6)`,
          [id, p, `${kind}.dxf`, `projects/${p}/cad/${id}/o.dxf`, randomUUID(), kind],
        );
        if (superseded) {
          await db.query(
            `UPDATE cad_files SET superseded_at = now(), superseded_by = $2 WHERE id = $1`,
            [superseded, id],
          );
        }
        return id;
      };
      const published = async (p: string, cadFile: string, kind: string, revNo: number) => {
        const id = randomUUID();
        const feature = randomUUID();
        await db.query(
          `INSERT INTO design_revisions (id, project_id, cad_file_id, status, current_job_id, rules,
                                         mapping_version, crs_epsg, drawing_unit, metres_per_unit, drawing_kind)
           VALUES ($1, $2, $3, 'building', $4, '[]', 1, 32636, 'm', 1, $5)`,
          [id, p, cadFile, randomUUID(), kind],
        );
        await db.query(
          `INSERT INTO features (id, project_id, feature_type, first_revision_id) VALUES ($1, $2, 'box', $3)`,
          [feature, p, id],
        );
        await db.query(
          `INSERT INTO design_features (revision_id, feature_id, project_id, feature_type, code, layer,
                                        source_kind, source_handle, geom)
           VALUES ($1, $2, $3, 'box', '1-1', 'sub', 'insert', 'H1', ST_GeomFromText('POINT(330000 3340000)', 32636))`,
          [id, feature, p],
        );
        await db.query(
          `UPDATE design_revisions SET status = 'published', rev_no = $2, published_at = now() WHERE id = $1`,
          [id, revNo],
        );
        return { id, feature };
      };

      // El Fath-like: one work order, a General with two versions, a Secondary, both published.
      const elFath = await project('El Fath');
      await db.query(
        `INSERT INTO work_orders (project_id, number, title, currency) VALUES ($1, 'WO-77', 'الفتح', 'EGP')`,
        [elFath],
      );
      const g1 = await file(elFath, 'general');
      const g2 = await file(elFath, 'general', g1);
      const s1 = await file(elFath, 'secondary');
      const revG = await published(elFath, g2, 'general', 1);
      const revS = await published(elFath, s1, 'secondary', 1);
      // A work order with no title: the site is named by the number alone.
      const noTitle = await project('No title');
      await db.query(
        `INSERT INTO work_orders (project_id, number, currency) VALUES ($1, 'WO-88', 'EGP')`,
        [noTitle],
      );
      await file(noTitle, 'general');
      // No work order (the Rabaa test project): drawings stay without a site.
      const rabaa = await project('Rabaa');
      const rg = await file(rabaa, 'general');
      const revR = await published(rabaa, rg, 'general', 1);
      // A work order with no drawings gets no site.
      const empty = await project('Empty');
      await db.query(
        `INSERT INTO work_orders (project_id, number, currency) VALUES ($1, 'WO-99', 'EGP')`,
        [empty],
      );

      await db.query(readFileSync(`${MIGRATIONS_DIR}0026_site_drawings.sql`, 'utf8'));

      // El Fath: a new site named «number — title», one General and one Secondary.
      const site = (
        await db.query(`SELECT id, name FROM work_order_sites WHERE project_id = $1`, [elFath])
      ).rows;
      expect(site).toHaveLength(1);
      expect(site[0].name).toBe('WO-77 — الفتح');
      const drawings = (
        await db.query(
          `SELECT id, site_id, drawing_kind, ordinal FROM site_drawings WHERE project_id = $1 ORDER BY drawing_kind`,
          [elFath],
        )
      ).rows;
      expect(drawings.map((d) => [d.drawing_kind, d.ordinal, d.site_id])).toEqual([
        ['general', 1, site[0].id],
        ['secondary', 1, site[0].id],
      ]);
      const general = drawings[0].id;
      const secondary = drawings[1].id;
      const fileRows = (
        await db.query(`SELECT id, drawing_id FROM cad_files WHERE project_id = $1`, [elFath])
      ).rows as { id: string; drawing_id: string }[];
      expect(new Map(fileRows.map((r) => [r.id, r.drawing_id]))).toEqual(
        new Map([
          [g1, general],
          [g2, general],
          [s1, secondary],
        ]),
      );
      // Published revisions keep ids, numbers and features; only the drawing was added.
      const revs = (
        await db.query(
          `SELECT id, drawing_id, rev_no, status, (SELECT count(*)::int FROM design_features f WHERE f.revision_id = r.id) AS n
           FROM design_revisions r WHERE project_id = $1`,
          [elFath],
        )
      ).rows;
      expect(new Map(revs.map((r) => [r.id, [r.drawing_id, r.rev_no, r.status, r.n]]))).toEqual(
        new Map([
          [revG.id, [general, 1, 'published', 1]],
          [revS.id, [secondary, 1, 'published', 1]],
        ]),
      );

      // No title: the number alone.
      expect(
        (await db.query(`SELECT name FROM work_order_sites WHERE project_id = $1`, [noTitle]))
          .rows[0].name,
      ).toBe('WO-88');
      // No work order: the same drawings, with no site, and the revision still published.
      expect(
        (
          await db.query(`SELECT count(*)::int AS n FROM work_order_sites WHERE project_id = $1`, [
            rabaa,
          ])
        ).rows[0].n,
      ).toBe(0);
      const rabaaDrawing = (
        await db.query(
          `SELECT id, site_id, drawing_kind FROM site_drawings WHERE project_id = $1`,
          [rabaa],
        )
      ).rows;
      expect(rabaaDrawing).toHaveLength(1);
      expect(rabaaDrawing[0].site_id).toBeNull();
      expect(
        (await db.query(`SELECT drawing_id, status FROM design_revisions WHERE id = $1`, [revR.id]))
          .rows[0],
      ).toEqual({ drawing_id: rabaaDrawing[0].id, status: 'published' });
      // A work order with no drawings gets no site.
      expect(
        (
          await db.query(`SELECT count(*)::int AS n FROM work_order_sites WHERE project_id = $1`, [
            empty,
          ])
        ).rows[0].n,
      ).toBe(0);

      // The published revision is still immutable, and its drawing cannot be changed.
      expect(
        await sqlState(
          db.query(`UPDATE design_revisions SET drawing_id = $2 WHERE id = $1`, [
            revG.id,
            secondary,
          ]),
        ),
      ).toBe('23001');
      // The unassigned drawing is linked once; a drawing never moves to another site.
      const otherSite = randomUUID();
      expect(
        await sqlState(
          db.query(`UPDATE site_drawings SET site_id = $2 WHERE id = $1`, [general, otherSite]),
        ),
      ).not.toBeNull();
      // Published drawings cannot be withdrawn; nothing is ever deleted.
      expect(
        await sqlState(
          db.query(`UPDATE site_drawings SET withdrawn_at = now() WHERE id = $1`, [general]),
        ),
      ).toBe('23001');
      expect(await sqlState(db.query(`DELETE FROM site_drawings WHERE id = $1`, [general]))).toBe(
        '23001',
      );
      // One General per site.
      expect(
        await sqlState(
          db.query(
            `INSERT INTO site_drawings (id, project_id, site_id, drawing_kind, ordinal) VALUES ($1, $2, $3, 'general', 1)`,
            [randomUUID(), elFath, site[0].id],
          ),
        ),
      ).toBe('23505');
    } finally {
      await db.end();
      await adminClient.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
      await adminClient.end();
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------
// The API: sites, uploads, per-site publishing

interface Scenario {
  project: string;
  workOrder: string;
  siteA: string;
  siteB: string;
}

async function scenario(): Promise<Scenario> {
  const contract = await createApprovedContract(
    ctx.pool,
    [{ code: 'A', quantity: '10', unitPrice: '1' }],
    {
      approve: true,
    },
  );
  const project = await createProjectIn(ctx.pool, contract.contractId);
  const { workOrderId } = await createWorkOrderFrom(ctx.pool, project, contract, { A: '1' });
  const site = async (name: string, position: number) => {
    const id = randomUUID();
    await q(
      `INSERT INTO work_order_sites (id, project_id, work_order_id, name, name_key, position)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [id, project, workOrderId, name, position],
    );
    return id;
  };
  return {
    project,
    workOrder: workOrderId,
    siteA: await site('موقع أ', 1),
    siteB: await site('موقع ب', 2),
  };
}

const upload = (
  s: Scenario,
  query: Record<string, string>,
  name = 'plan.dxf',
  token = admin,
): request.Test =>
  as(token)(http().post(`${filesUrl(s.project)}?${new URLSearchParams(query).toString()}`)).attach(
    'file',
    DXF,
    name,
  );

describe('uploading to a site', () => {
  it('opens one General and several Secondaries per site and lists them', async () => {
    const s = await scenario();
    const general = await upload(s, { siteId: s.siteA, kind: 'general', target: 'new_drawing' });
    expect(general.status, JSON.stringify(general.body)).toBe(201);
    expect(CadFileSummarySchema.parse(general.body)).toMatchObject({
      siteId: s.siteA,
      drawingKind: 'general',
      drawingOrdinal: 1,
    });
    const sec1 = await upload(s, { siteId: s.siteA, kind: 'secondary', target: 'new_drawing' });
    const sec2 = await upload(s, { siteId: s.siteA, kind: 'secondary', target: 'new_drawing' });
    expect([sec1.body.drawingOrdinal, sec2.body.drawingOrdinal]).toEqual([1, 2]);

    const again = await upload(s, { siteId: s.siteA, kind: 'general', target: 'new_drawing' });
    expect(again.status).toBe(409);
    expect(UploadRefusedDetailsSchema.parse(again.body.details)).toMatchObject({
      reason: 'GENERAL_EXISTS',
      drawingId: general.body.drawingId,
    });
    // The other site is a different drawing space.
    const other = await upload(s, { siteId: s.siteB, kind: 'general', target: 'new_drawing' });
    expect(other.status).toBe(201);

    const list = SiteDrawingsResponseSchema.parse(
      (await as(admin)(http().get(`/projects/${s.project}/site-drawings`)).expect(200)).body,
    );
    expect(list.sites.map((x) => [x.name, x.drawings.map((d) => `${d.kind}${d.ordinal}`)])).toEqual(
      [
        ['موقع أ', ['general1', 'secondary1', 'secondary2']],
        ['موقع ب', ['general1']],
      ],
    );
    expect(list.unassigned).toEqual([]);
  });

  it('refuses an unknown site, a drawing of another site or kind, and an unassigned drawing', async () => {
    const s = await scenario();
    const general = await upload(s, { siteId: s.siteA, kind: 'general', target: 'new_drawing' });
    const refused = async (query: Record<string, string>, status: number, reason: string) => {
      const res = await upload(s, query);
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      expect(res.body.details).toMatchObject({ reason });
    };
    await refused(
      { siteId: randomUUID(), kind: 'general', target: 'new_drawing' },
      404,
      'SITE_NOT_FOUND',
    );
    await refused(
      {
        siteId: s.siteB,
        kind: 'general',
        target: 'new_version',
        drawingId: general.body.drawingId,
      },
      409,
      'DRAWING_NOT_IN_SITE',
    );
    await refused(
      {
        siteId: s.siteA,
        kind: 'secondary',
        target: 'new_version',
        drawingId: general.body.drawingId,
      },
      409,
      'DRAWING_NOT_IN_SITE',
    );
    const legacy = await insertDrawing((t, v) => q(t, v), s.project, 'general');
    await refused(
      { siteId: s.siteA, kind: 'general', target: 'new_version', drawingId: legacy },
      409,
      'DRAWING_UNASSIGNED',
    );
    const version = await upload(s, {
      siteId: s.siteA,
      kind: 'general',
      target: 'new_version',
      drawingId: general.body.drawingId,
    });
    expect(version.status, JSON.stringify(version.body)).toBe(201);
    expect(version.body.drawingId).toBe(general.body.drawingId);
    const old = await as(admin)(http().get(`${filesUrl(s.project)}/${general.body.id}`)).expect(
      200,
    );
    expect(old.body.supersededById).toBe(version.body.id);
  });

  it('links an unassigned drawing to a site once, and withdraws a drawing that was never published', async () => {
    const s = await scenario();
    const legacy = await insertDrawing((t, v) => q(t, v), s.project, 'secondary');
    const assign = (site: string) =>
      as(admin)(http().post(`/projects/${s.project}/site-drawings/${legacy}/assign-site`)).send({
        siteId: site,
      });
    expect((await assign(s.siteA)).status).toBe(204);
    expect((await assign(s.siteB)).status).toBe(409);
    expect((await assign(randomUUID())).status).toBe(404);
    const list = SiteDrawingsResponseSchema.parse(
      (await as(admin)(http().get(`/projects/${s.project}/site-drawings`))).body,
    );
    expect(list.sites[0]?.drawings.map((d) => d.id)).toEqual([legacy]);

    const withdrawn = await as(admin)(
      http().post(`/projects/${s.project}/site-drawings/${legacy}/withdraw`),
    );
    expect(withdrawn.status).toBe(204);
    const again = await as(admin)(
      http().post(`/projects/${s.project}/site-drawings/${legacy}/withdraw`),
    );
    expect(again.status).toBe(409);
    // A withdrawn drawing is not in the list; a new Secondary of the site takes the next number.
    const next = await upload(s, { siteId: s.siteA, kind: 'secondary', target: 'new_drawing' });
    expect(next.body.drawingOrdinal).toBe(2);
    const events = await q(`SELECT type FROM events WHERE entity_id = $1`, [legacy]);
    expect(events.rows.map((r) => r.type).sort()).toEqual([
      'site_drawing.assigned',
      'site_drawing.withdrawn',
    ]);
  });

  it('refuses to withdraw a published drawing', async () => {
    const s = await scenario();
    const drawing = await insertDrawing((t, v) => q(t, v), s.project, 'general', {
      siteId: s.siteA,
    });
    const file = randomUUID();
    await q(
      `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                              status, current_job_id, processed_at, drawing_kind, drawing_id)
       VALUES ($1, $2, 'g.dxf', 'dxf', 1, repeat('a', 64), $3, 'processed', $4, now(), 'general', $5)`,
      [file, s.project, `projects/${s.project}/cad/${file}/o.dxf`, randomUUID(), drawing],
    );
    const revision = randomUUID();
    await q(
      `INSERT INTO design_revisions (id, project_id, cad_file_id, status, current_job_id, rules,
                                     mapping_version, crs_epsg, drawing_unit, metres_per_unit)
       VALUES ($1, $2, $3, 'building', $4, '[]', 1, 32636, 'm', 1)`,
      [revision, s.project, file, randomUUID()],
    );
    await q(
      `UPDATE design_revisions SET status = 'published', rev_no = 1, published_at = now() WHERE id = $1`,
      [revision],
    );
    const res = await as(admin)(
      http().post(`/projects/${s.project}/site-drawings/${drawing}/withdraw`),
    );
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'DRAWING_PUBLISHED' });
  });
});

// ---------------------------------------------------------------------------------------------

describe('publishing a site', () => {
  const place = {
    sourceCrs: 'project',
    points: [{ id: 'p1', drawing: { x: 1, y: 1 }, lat: 30.9, lon: 32.7, source: 'typed' }],
  };

  /** Uploads, maps and builds (the worker is simulated) one drawing; returns its draft revision. */
  async function draft(
    s: Scenario,
    siteId: string,
    kind: 'general' | 'secondary',
    cabinets: string[],
  ): Promise<{ revision: string; drawing: string }> {
    const up = await upload(s, { siteId, kind, target: 'new_drawing' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const file = up.body.id as string;
    // No Redis here: the upload was marked ENQUEUE_FAILED; the worker's result is simulated.
    await q(
      `UPDATE cad_files SET status = 'processed', error_code = NULL, error_message = NULL,
              processed_at = now() WHERE id = $1`,
      [file],
    );
    if (kind === 'general') {
      await q(
        `INSERT INTO cad_file_installation_answers (id, project_id, cad_file_id, answer)
         VALUES ($1, $2, $3, 'pull_only')`,
        [randomUUID(), s.project, file],
      );
    }
    const mapping = await as(admin)(http().put(`${filesUrl(s.project)}/${file}/mapping`)).send({
      rules: [{ source: 'layer', layer: 'N_DUC_CBL', target: 'route' }],
      crsEpsg: 32636,
      drawingUnit: 'm',
      version: null,
      placement: place,
    });
    expect(mapping.status, JSON.stringify(mapping.body)).toBe(200);
    const created = await as(admin)(http().post(revisionsUrl(s.project))).send({
      cadFileId: file,
      mappingVersion: 1,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const revision = created.body.id as string;
    expect(created.body).toMatchObject({ drawingId: up.body.drawingId, siteId });
    await q(
      `UPDATE design_revisions SET status = 'building', build_started_at = now(), error_code = NULL, error_message = NULL WHERE id = $1`,
      [revision],
    );
    for (const [index, name] of cabinets.entries()) {
      const id = randomUUID();
      await q(
        `INSERT INTO features (id, project_id, feature_type, first_revision_id) VALUES ($1, $2, 'cabinet', $3)`,
        [id, s.project, revision],
      );
      await q(
        `INSERT INTO design_features (revision_id, feature_id, project_id, feature_type, code, layer,
                                      source_kind, source_handle, geom, attrs)
         VALUES ($1, $2, $3, 'cabinet', $4, 'Sap', 'insert', $5, ST_SetSRID(ST_MakePoint($6, 10), 32636), '{"role":"sub"}'::jsonb)`,
        [revision, id, s.project, name, `C${index}`, 10 + index],
      );
    }
    await q(
      `UPDATE design_revisions SET status = 'draft', built_at = now(),
              counts = $2, text_link_counts = $3, diff_counts = $4 WHERE id = $1`,
      [
        revision,
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
    await makeBoxTypesClear(ctx.pool, revision);
    return { revision, drawing: up.body.drawingId as string };
  }

  const publish = (s: Scenario, revision: string, body: object = {}) =>
    as(admin)(http().post(`${revisionsUrl(s.project)}/${revision}/publish`)).send(body);
  const siteReadiness = async (s: Scenario, site: string) =>
    PublishReadinessSchema.parse(
      (
        await as(admin)(
          http().get(`/projects/${s.project}/sites/${site}/publish-readiness`),
        ).expect(200)
      ).body,
    );

  it('publishes every draft of the site together with one number, each site on its own', async () => {
    const s = await scenario();
    const g = await draft(s, s.siteA, 'general', ['1-1', '1-2', '2-1']);
    const s1 = await draft(s, s.siteA, 'secondary', ['1-1', '1-2']);
    const s2 = await draft(s, s.siteA, 'secondary', ['2-1']);
    const b = await draft(s, s.siteB, 'general', ['9-1']);

    const ready = await siteReadiness(s, s.siteA);
    expect(ready).toMatchObject({
      siteId: s.siteA,
      canPublish: true,
      siteRevisionIds: [g.revision, s1.revision, s2.revision],
    });
    expect(ready.drawings.map((d) => [d.drawingKind, d.ordinal, d.state])).toEqual([
      ['general', 1, 'draft'],
      ['secondary', 1, 'draft'],
      ['secondary', 2, 'draft'],
    ]);
    // Site B has only a General: it is not complete.
    const incomplete = await publish(s, b.revision);
    expect(incomplete.status, JSON.stringify(incomplete.body)).toBe(409);
    expect(incomplete.body.details).toEqual({
      reason: 'SITE_INCOMPLETE',
      siteId: s.siteB,
      missingKinds: ['secondary'],
    });

    const done = await publish(s, s2.revision);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const rows = await q(
      `SELECT id, status, rev_no, drawing_id FROM design_revisions WHERE project_id = $1 AND status = 'published'`,
      [s.project],
    );
    expect(rows.rows.map((r) => r.rev_no)).toEqual([1, 1, 1]);
    expect(new Set(rows.rows.map((r) => r.drawing_id)).size).toBe(3);
    const event = await q(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'design_revision.published'`,
      [s1.revision],
    );
    expect(event.rows[0].payload).toMatchObject({
      revNo: 1,
      siteId: s.siteA,
      drawingId: s1.drawing,
      siteRevisionIds: [g.revision, s1.revision, s2.revision],
    });
    // Site B, still without a Secondary, was untouched.
    expect(
      (await q('SELECT status FROM design_revisions WHERE id = $1', [b.revision])).rows[0].status,
    ).toBe('draft');
  });

  it('holds the whole site back for a Secondary with errors, naming that drawing', async () => {
    const s = await scenario();
    const g = await draft(s, s.siteA, 'general', ['1-1', '2-1']);
    const s1 = await draft(s, s.siteA, 'secondary', ['1-1']);
    const s2 = await draft(s, s.siteA, 'secondary', ['2-1']);
    await q(`UPDATE design_revisions SET warnings = $2 WHERE id = $1`, [
      s2.revision,
      JSON.stringify([{ code: 'LABEL_MISSING', severity: 'warning', count: 3, items: [] }]),
    ]);
    const res = await publish(s, g.revision);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({
      reason: 'PROBLEMS_OPEN',
      drawingId: s2.drawing,
      ordinal: 2,
      drawingKind: 'secondary',
      problemCount: 3,
    });
    expect((await siteReadiness(s, s.siteA)).canPublish).toBe(false);
    const status = await q(`SELECT status FROM design_revisions WHERE id = ANY($1)`, [
      [g.revision, s1.revision, s2.revision],
    ]);
    expect(status.rows.map((r) => r.status)).toEqual(['draft', 'draft', 'draft']);
  });

  it('refuses a cabinet name that is also in another site of the work order (CABINET_IN_OTHER_SITE)', async () => {
    const s = await scenario();
    const a = {
      g: await draft(s, s.siteA, 'general', ['1-1', '1-2']),
      s: await draft(s, s.siteA, 'secondary', ['1-1', '1-2']),
    };
    const b = {
      g: await draft(s, s.siteB, 'general', ['1 - 2', '5-5']),
      s: await draft(s, s.siteB, 'secondary', ['1 - 2', '5-5']),
    };
    // The other site's draft already claims 1-2: both sites are refused.
    for (const revision of [a.g.revision, b.g.revision]) {
      const res = await publish(s, revision);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details).toMatchObject({ reason: 'CABINET_IN_OTHER_SITE' });
    }
    expect(
      (await siteReadiness(s, s.siteA)).checks.find((c) => c.key === 'cabinets_other_site'),
    ).toEqual({
      key: 'cabinets_other_site',
      ok: false,
      count: 1,
    });
    // Site B renames the cabinet in a new version of both drawings: simulate by editing the names.
    await q(
      `UPDATE design_features SET code = '6-6' WHERE revision_id = ANY($1) AND code = '1 - 2'`,
      [[b.g.revision, b.s.revision]],
    );
    expect((await publish(s, a.g.revision)).status).toBe(200);
    expect((await publish(s, b.s.revision)).status).toBe(200);
    const numbers = await q(
      `SELECT DISTINCT rev_no FROM design_revisions WHERE project_id = $1 AND status = 'published'`,
      [s.project],
    );
    expect(numbers.rows.map((r) => r.rev_no)).toEqual([1]);
  });

  it('refuses a drawing that is not linked to a site (SITE_UNASSIGNED)', async () => {
    const s = await scenario();
    const g = await draft(s, s.siteA, 'general', []);
    const legacyFile = randomUUID();
    const legacyDrawing = await insertDrawing((t, v) => q(t, v), s.project, 'general');
    await q(
      `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                              status, current_job_id, processed_at, drawing_kind, drawing_id)
       VALUES ($1, $2, 'old.dxf', 'dxf', 1, repeat('a', 64), $3, 'processed', $4, now(), 'general', $5)`,
      [
        legacyFile,
        s.project,
        `projects/${s.project}/cad/${legacyFile}/o.dxf`,
        randomUUID(),
        legacyDrawing,
      ],
    );
    const revision = randomUUID();
    await q(
      `INSERT INTO design_revisions (id, project_id, cad_file_id, status, current_job_id, rules,
                                     mapping_version, crs_epsg, drawing_unit, metres_per_unit)
       VALUES ($1, $2, $3, 'draft', $4, '[]', 1, 32636, 'm', 1)`,
      [revision, s.project, legacyFile, randomUUID()],
    );
    const res = await publish(s, revision);
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({
      reason: 'SITE_UNASSIGNED',
      drawingId: legacyDrawing,
    });
    expect(g.revision).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------

describe('a published revision of a drawing without a site keeps syncing', () => {
  it('serves the bundle, lists the drawing and takes a pick by drawing id', async () => {
    const project = fx.projectId;
    // The fixture's drawings belong to sites; this one has none («بدون موقع»), published long ago.
    const unassigned = await publishRevision(ctx.pool, project, [], 3, 'general', {
      siteId: null,
      publishedAgoSeconds: 7200,
    });
    const bundle = OfflineBundleSchema.parse(
      (
        await http()
          .get(`/projects/${project}/sync/bootstrap`)
          .set('Authorization', `Bearer ${fx.tokens.pm}`)
          .expect(200)
      ).body,
    );
    expect(bundle.revision?.id).toBe(fx.revisionId);
    const drawing = bundle.drawings.find((d) => d.revision.id === unassigned);
    expect(drawing).toMatchObject({ siteId: null, siteName: null, kind: 'general', ordinal: 1 });
    expect(bundle.drawings.find((d) => d.revision.id === fx.revisionId)).toMatchObject({
      siteId: fx.siteA,
      kind: 'general',
    });

    const picked = OfflineBundleSchema.parse(
      (
        await http()
          .get(`/projects/${project}/sync/bootstrap?drawingId=${drawing?.drawingId}`)
          .set('Authorization', `Bearer ${fx.tokens.pm}`)
          .expect(200)
      ).body,
    );
    expect(picked.revision?.id).toBe(unassigned);
    expect(picked.revision?.drawingId).toBe(drawing?.drawingId);

    // An unknown drawing is refused.
    const unknown = await http()
      .get(`/projects/${project}/sync/bootstrap?drawingId=${randomUUID()}`)
      .set('Authorization', `Bearer ${fx.tokens.pm}`);
    expect(unknown.status).toBe(404);
    const second = await publishRevision(ctx.pool, project, [], 2, 'secondary');
    const withSecondary = OfflineBundleSchema.parse(
      (
        await http()
          .get(`/projects/${project}/sync/bootstrap`)
          .set('Authorization', `Bearer ${fx.tokens.pm}`)
          .expect(200)
      ).body,
    );
    expect(withSecondary.drawings.map((d) => d.kind).sort()).toEqual([
      'general',
      'general',
      'general',
      'secondary',
    ]);
    // The default pick is still the General published last.
    expect(withSecondary.revision?.id).toBe(fx.revisionId);
    expect(second).toBeDefined();
  });
});
