import { createHash, randomUUID } from 'node:crypto';
import {
  MeResponseSchema,
  OfflineBundleSchema,
  SUPERVISOR_SITES_EVENT,
  SupervisorSitesResponseSchema,
  SupervisorWithSitesSchema,
  SyncChangesResponseSchema,
  SyncPushResponseSchema,
  type OpResult,
} from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ensureSite } from './support/drawing-fixtures.js';
import {
  createExecutionFixture,
  E0,
  N0,
  publishRevision,
  toWgs84,
  type ExecutionFixture,
} from './support/execution-fixtures.js';
import { ensureMember, loginAs } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

/**
 * ADR-054: supervisors work by site. Real API on PostGIS (the CAD worker's side is simulated with
 * SQL by the execution fixture): site A and site B, each with a published General drawing;
 * supervisors A and A2 hold site A, supervisor B holds site B; PM and QC are project-wide.
 */

let ctx: TestContext;
const DEVICE = randomUUID();
let near: [number, number];

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  near = await toWgs84(ctx.pool, E0 + 50, N0 + 10);
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

const http = () => request(ctx.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const listUrl = (fx: ExecutionFixture) => `/projects/${fx.projectId}/supervisor-sites`;
const putUrl = (fx: ExecutionFixture, userId: string) =>
  `/projects/${fx.projectId}/supervisors/${userId}/sites`;
const getList = (fx: ExecutionFixture, token: string) => http().get(listUrl(fx)).set(auth(token));
const putSites = (fx: ExecutionFixture, token: string, userId: string, siteIds: string[]) =>
  http().put(putUrl(fx, userId)).set(auth(token)).send({ siteIds });

async function meId(token: string): Promise<string> {
  const res = await http().get('/auth/me').set(auth(token));
  return MeResponseSchema.parse(res.body).id;
}

async function heldSites(fx: ExecutionFixture, userId: string): Promise<string[]> {
  const { rows } = await ctx.pool.query<{ site_id: string }>(
    'SELECT site_id FROM supervisor_sites WHERE project_id = $1 AND user_id = $2 ORDER BY site_id',
    [fx.projectId, userId],
  );
  return rows.map((row) => row.site_id);
}

/** A tiny but valid JPEG body. */
function jpeg(size = 3000, seed = 1): Buffer {
  const bytes = Buffer.alloc(size, seed);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

/** A civil update of 1 piece (item C-02 of the fixture's work order, 10 in total) on a feature. */
function updateOp(fx: ExecutionFixture, featureId: string, revisionId: string) {
  const photo = jpeg();
  const now = new Date().toISOString();
  return {
    kind: 'execution_update.record',
    clientOpId: randomUUID(),
    capturedAt: now,
    payload: {
      featureId,
      designRevisionId: revisionId,
      workType: 'civil',
      lines: [
        {
          workOrderItemId: fx.items.civilPieces,
          quantity: '1',
          role: 'work',
          performer: { kind: 'self' },
        },
      ],
      label: null,
      note: null,
      gps: { lon: near[0], lat: near[1], accuracyM: 5, at: now },
      photos: [
        {
          photoId: randomUUID(),
          requirementKey: 'general',
          sha256: createHash('sha256').update(photo).digest('hex'),
          sizeBytes: photo.length,
          contentType: 'image/jpeg',
          takenAt: now,
          gps: null,
        },
      ],
      acknowledgedWarnings: [],
    },
  };
}

async function pushOne(fx: ExecutionFixture, token: string, operation: unknown): Promise<OpResult> {
  const res = await http()
    .post(`/projects/${fx.projectId}/sync/push`)
    .set(auth(token))
    .send({ deviceId: DEVICE, ops: [operation] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const [result] = SyncPushResponseSchema.parse(res.body).results;
  if (!result) throw new Error('no result');
  return result;
}

const rejectedWith = (result: OpResult) => (result.outcome === 'rejected' ? result.code : null);

const bootstrap = (fx: ExecutionFixture, token: string, query: Record<string, string> = {}) =>
  http().get(`/projects/${fx.projectId}/sync/bootstrap`).query(query).set(auth(token));

// ---------------------------------------------------------------------------------------------

describe('GET and PUT supervisor sites', () => {
  let fx: ExecutionFixture;
  let supervisorAId: string;
  let supervisorBId: string;
  let pmToken: string;
  let otherPmToken: string;

  beforeAll(async () => {
    fx = await createExecutionFixture(ctx);
    supervisorAId = fx.userIds.supervisorA;
    supervisorBId = fx.userIds.supervisorB;
    pmToken = fx.tokens.pm;
    const email = `other-pm-${randomUUID().slice(0, 8)}@ftth.local`;
    await ensureMember(ctx.pool, {
      email,
      password: 'Other#Pm1234',
      role: 'pm',
      projectId: fx.otherProjectId,
    });
    otherPmToken = await loginAs(ctx, email, 'Other#Pm1234');
  }, 180_000);

  it('lists the sites of the work order and every supervisor with his sites', async () => {
    const res = await getList(fx, fx.tokens.admin);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = SupervisorSitesResponseSchema.parse(res.body);
    expect(body.sites.map((site) => site.siteId)).toEqual([fx.siteA, fx.siteB]);
    expect(body.sites.every((site) => site.workOrderId === fx.workOrderId)).toBe(true);
    const byId = new Map(body.supervisors.map((s) => [s.userId, s]));
    expect(byId.get(supervisorAId)?.siteIds).toEqual([fx.siteA]);
    expect(byId.get(fx.userIds.supervisorA2)?.siteIds).toEqual([fx.siteA]);
    expect(byId.get(supervisorBId)?.siteIds).toEqual([fx.siteB]);
    // Only supervisors: no PM or QC in the list.
    expect(body.supervisors).toHaveLength(3);
    expect(body.supervisors.every((s) => s.isActive)).toBe(true);
    // The PM of the project reads the same.
    expect((await getList(fx, pmToken)).status).toBe(200);
  });

  it('lets the admin and the PM of the project replace his sites, with one event each', async () => {
    const asAdmin = await putSites(fx, fx.tokens.admin, supervisorAId, [fx.siteA, fx.siteB]);
    expect(asAdmin.status, JSON.stringify(asAdmin.body)).toBe(200);
    expect(SupervisorWithSitesSchema.parse(asAdmin.body).siteIds).toEqual([fx.siteA, fx.siteB]);
    expect(await heldSites(fx, supervisorAId)).toEqual([fx.siteA, fx.siteB].sort());

    const asPm = await putSites(fx, pmToken, supervisorAId, [fx.siteB]);
    expect(asPm.status, JSON.stringify(asPm.body)).toBe(200);
    expect(asPm.body.siteIds).toEqual([fx.siteB]);
    expect(await heldSites(fx, supervisorAId)).toEqual([fx.siteB]);

    const { rows } = await ctx.pool.query<{
      entity: string;
      project_id: string;
      actor_id: string;
      payload: { before: string[]; after: string[] };
    }>(
      `SELECT entity, project_id, actor_id, payload FROM events
       WHERE type = $1 AND entity_id = $2 ORDER BY id`,
      [SUPERVISOR_SITES_EVENT, supervisorAId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      entity: 'supervisor_sites',
      project_id: fx.projectId,
      payload: { before: [fx.siteA], after: [fx.siteA, fx.siteB] },
    });
    expect(rows[1]).toMatchObject({
      actor_id: await meId(pmToken),
      payload: { before: [fx.siteA, fx.siteB], after: [fx.siteB] },
    });

    // Back to the fixture's state and empty is allowed (he then sees nothing).
    expect((await putSites(fx, pmToken, supervisorAId, [fx.siteA])).status).toBe(200);
    expect((await putSites(fx, pmToken, supervisorAId, [])).body.siteIds).toEqual([]);
    expect(await heldSites(fx, supervisorAId)).toEqual([]);
    expect((await putSites(fx, pmToken, supervisorAId, [fx.siteA])).status).toBe(200);
  });

  it('refuses the PM of another project, QC and supervisors (403)', async () => {
    for (const token of [
      otherPmToken,
      fx.tokens.qc,
      fx.tokens.supervisorA,
      fx.tokens.supervisorB,
    ]) {
      expect((await getList(fx, token)).status).toBe(403);
      expect((await putSites(fx, token, supervisorAId, [fx.siteB])).status).toBe(403);
    }
    expect((await http().get(listUrl(fx))).status).toBe(401);
    expect(await heldSites(fx, supervisorAId)).toEqual([fx.siteA]);
  });

  it('answers 404 for a user who is not a supervisor of this project', async () => {
    for (const userId of [randomUUID(), await meId(fx.tokens.qc), await meId(fx.tokens.pm)]) {
      const res = await putSites(fx, fx.tokens.admin, userId, [fx.siteA]);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
    }
    // A supervisor of another project has no assignment here.
    const email = `other-sup-${randomUUID().slice(0, 8)}@ftth.local`;
    await ensureMember(ctx.pool, {
      email,
      password: 'Other#Sup1234',
      role: 'supervisor',
      projectId: fx.otherProjectId,
    });
    const otherSupervisor = await meId(await loginAs(ctx, email, 'Other#Sup1234'));
    expect((await putSites(fx, fx.tokens.admin, otherSupervisor, [fx.siteA])).status).toBe(404);
  });

  it('answers 422 for a site of another project or an unknown site, and changes nothing', async () => {
    const foreignSite = await ensureSite(ctx.pool, fx.otherProjectId);
    for (const siteIds of [[foreignSite], [fx.siteB, foreignSite], [randomUUID()]]) {
      const res = await putSites(fx, fx.tokens.admin, supervisorAId, siteIds);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    expect(await heldSites(fx, supervisorAId)).toEqual([fx.siteA]);
    // Repeated sites and unknown fields are refused by the contract.
    expect((await putSites(fx, fx.tokens.admin, supervisorAId, [fx.siteA, fx.siteA])).status).toBe(
      400,
    );
    expect(
      (
        await http()
          .put(putUrl(fx, supervisorAId))
          .set(auth(fx.tokens.admin))
          .send({ siteIds: [], extra: 1 })
      ).status,
    ).toBe(400);
    const events = await ctx.pool.query(
      `SELECT 1 FROM events WHERE type = $1 AND entity_id = $2 AND payload->'after' = $3::jsonb`,
      [SUPERVISOR_SITES_EVENT, supervisorAId, JSON.stringify([foreignSite])],
    );
    expect(events.rowCount).toBe(0);
  });

  it('refuses a site row for a user without a supervisor assignment at the database', async () => {
    const qcId = await meId(fx.tokens.qc);
    await expect(
      ctx.pool.query(
        'INSERT INTO supervisor_sites (project_id, user_id, site_id) VALUES ($1, $2, $3)',
        [fx.projectId, qcId, fx.siteA],
      ),
    ).rejects.toThrow(/not a supervisor of this project/);
    // And a site of another project is refused by the composite foreign key.
    const foreignSite = await ensureSite(ctx.pool, fx.otherProjectId);
    await expect(
      ctx.pool.query(
        'INSERT INTO supervisor_sites (project_id, user_id, site_id) VALUES ($1, $2, $3)',
        [fx.projectId, supervisorAId, foreignSite],
      ),
    ).rejects.toThrow(/supervisor_sites_site_fkey/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('a supervisor reads nothing outside sync and As-Built (H1)', () => {
  let fx: ExecutionFixture;
  let noSiteToken: string;
  let cadFileId: string;

  beforeAll(async () => {
    fx = await createExecutionFixture(ctx);
    const email = `h1-${randomUUID().slice(0, 8)}@ftth.local`;
    await ensureMember(ctx.pool, {
      email,
      password: 'H1Nosite#123',
      role: 'supervisor',
      projectId: fx.projectId,
    });
    noSiteToken = await loginAs(ctx, email, 'H1Nosite#123');
    cadFileId =
      (
        await ctx.pool.query<{ cad_file_id: string }>(
          'SELECT cad_file_id FROM design_revisions WHERE id = $1',
          [fx.revisionId],
        )
      ).rows[0]?.cad_file_id ?? '';
  }, 180_000);

  it('answers 403 on CAD, design, drawing and work-order reads, with or without sites', async () => {
    const p = `/projects/${fx.projectId}`;
    const urls = [
      ['get', `${p}/cad-files`],
      ['get', `${p}/cad-files/${cadFileId}`],
      ['get', `${p}/cad-files/${cadFileId}/content`],
      ['get', `${p}/design-revisions`],
      ['get', `${p}/design-revisions/${fx.revisionId}`],
      ['get', `${p}/design-revisions/${fx.revisionId}/features`],
      ['post', `${p}/design-revisions/${fx.revisionId}/tile-url`],
      ['get', `${p}/site-drawings`],
      ['get', `${p}/work-orders`],
      ['get', `${p}/work-orders/${fx.workOrderId}`],
      ['get', `${p}/work-orders/${fx.workOrderId}/sites`],
    ] as const;
    for (const token of [noSiteToken, fx.tokens.supervisorA]) {
      for (const [method, url] of urls) {
        const res = await http()[method](url).set(auth(token));
        expect(res.status, `${method} ${url}`).toBe(403);
      }
    }
    // The same routes still answer the PM, so the 403 is the role and not a wrong path.
    expect((await http().get(`${p}/design-revisions`).set(auth(fx.tokens.pm))).status).toBe(200);
    expect(
      (await http().get(`${p}/work-orders/${fx.workOrderId}/sites`).set(auth(fx.tokens.pm))).status,
    ).toBe(200);
    // What he needs still works: bundle, changes and As-Built reads.
    expect((await bootstrap(fx, fx.tokens.supervisorA)).status).toBe(200);
    expect((await bootstrap(fx, noSiteToken)).status).toBe(200);
    for (const suffix of ['state', 'lengths', 'edits']) {
      expect(
        (await http().get(`${p}/asbuilt/${suffix}`).set(auth(fx.tokens.supervisorA))).status,
        suffix,
      ).toBe(200);
    }
  });
});

describe('what a supervisor sees and records', () => {
  let fx: ExecutionFixture;
  let unassignedDrawing: string;
  let unassignedFeature: string;

  beforeAll(async () => {
    fx = await createExecutionFixture(ctx);
    // A drawing without a site («بدون موقع», trial data), published long ago.
    unassignedFeature = randomUUID();
    const revision = await publishRevision(
      ctx.pool,
      fx.projectId,
      [
        {
          id: unassignedFeature,
          type: 'box',
          wkt: `POINT(${E0 + 70} ${N0 + 7})`,
          code: 'U-1',
          isNew: true,
        },
      ],
      3,
      'general',
      { siteId: null },
    );
    await ctx.pool.query(
      `UPDATE design_revisions SET published_at = now() - interval '2 hours' WHERE id = $1`,
      [revision],
    );
    unassignedDrawing =
      (
        await ctx.pool.query<{ drawing_id: string }>(
          'SELECT drawing_id FROM design_revisions WHERE id = $1',
          [revision],
        )
      ).rows[0]?.drawing_id ?? '';
  }, 180_000);

  it('gives a supervisor only the drawings and features of his sites', async () => {
    const res = await bootstrap(fx, fx.tokens.supervisorA);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bundle = OfflineBundleSchema.parse(res.body);
    expect(bundle.scope).toEqual({ kind: 'sites', siteIds: [fx.siteA] });
    expect(bundle.drawings.map((d) => d.drawingId)).toEqual([fx.drawingA]);
    expect(bundle.drawings.every((d) => d.siteId === fx.siteA)).toBe(true);
    expect(bundle.revision?.id).toBe(fx.revisionId);
    expect(bundle.features.map((f) => f.id).sort()).toEqual([fx.boxA, fx.routeA].sort());

    // No other site's name, drawing or revision reaches him, and no unassigned drawing.
    const names = (
      await ctx.pool.query<{ name: string }>(
        'SELECT name FROM work_order_sites WHERE id = $1 AND project_id = $2',
        [fx.siteB, fx.projectId],
      )
    ).rows.map((row) => row.name);
    const raw = JSON.stringify(res.body);
    for (const text of [
      ...names,
      fx.siteB,
      fx.drawingB,
      fx.revisionB,
      fx.boxB,
      unassignedDrawing,
      unassignedFeature,
    ]) {
      expect(raw).not.toContain(text);
    }
    expect(raw).not.toMatch(/بدون موقع/);

    const forB = OfflineBundleSchema.parse((await bootstrap(fx, fx.tokens.supervisorB)).body);
    expect(forB.drawings.map((d) => d.drawingId)).toEqual([fx.drawingB]);
    expect(forB.revision?.id).toBe(fx.revisionB);
    expect(forB.features.map((f) => f.id)).toEqual([fx.boxB]);
  });

  it('answers a picked drawing of another site or without a site like an unknown drawing (404)', async () => {
    const own = await bootstrap(fx, fx.tokens.supervisorA, { drawingId: fx.drawingA });
    expect(own.status).toBe(200);
    const statuses = [];
    for (const drawingId of [fx.drawingB, unassignedDrawing, randomUUID()]) {
      const res = await bootstrap(fx, fx.tokens.supervisorA, { drawingId });
      statuses.push([res.status, res.body.code]);
    }
    expect(statuses).toEqual([
      [404, 'NOT_FOUND'],
      [404, 'NOT_FOUND'],
      [404, 'NOT_FOUND'],
    ]);
  });

  it('keeps PM, QC and the admin project-wide', async () => {
    for (const token of [fx.tokens.pm, fx.tokens.qc, fx.tokens.admin]) {
      const bundle = OfflineBundleSchema.parse((await bootstrap(fx, token)).body);
      expect(bundle.scope).toEqual({ kind: 'project' });
      expect(bundle.drawings.map((d) => d.drawingId).sort()).toEqual(
        [fx.drawingA, fx.drawingB, unassignedDrawing].sort(),
      );
      expect(bundle.drawings.find((d) => d.drawingId === unassignedDrawing)?.siteId).toBeNull();
    }
    const pickedB = OfflineBundleSchema.parse(
      (await bootstrap(fx, fx.tokens.qc, { drawingId: fx.drawingB })).body,
    );
    expect(pickedB.features.map((f) => f.id)).toEqual([fx.boxB]);
    // The PM updates a feature of any site.
    expect((await pushOne(fx, fx.tokens.pm, updateOp(fx, fx.boxB, fx.revisionB))).outcome).toBe(
      'applied',
    );
  });

  it('gives a supervisor only the work-order lines of his sites (M1)', async () => {
    // One work order per project: a supervisor with a site gets its lines, one without gets none.
    const withSite = OfflineBundleSchema.parse((await bootstrap(fx, fx.tokens.supervisorA)).body);
    expect(withSite.catalog.map((line) => line.id).sort()).toEqual(
      [fx.items.civilMetres, fx.items.civilPieces, fx.items.installation].sort(),
    );
    const email = `nosite-${randomUUID().slice(0, 8)}@ftth.local`;
    await ensureMember(ctx.pool, {
      email,
      password: 'NoSite#12345',
      role: 'supervisor',
      projectId: fx.projectId,
    });
    const token = await loginAs(ctx, email, 'NoSite#12345');
    const none = OfflineBundleSchema.parse((await bootstrap(fx, token)).body);
    expect(none.catalog).toEqual([]);
    expect(none.features).toEqual([]);
    // Project-wide roles keep the whole catalog.
    const pm = OfflineBundleSchema.parse((await bootstrap(fx, fx.tokens.pm)).body);
    expect(pm.catalog).toHaveLength(3);
  });

  it('flags OUTSIDE_DRAWING on a supervisor edit far from the drawing, never rejects (M2)', async () => {
    const move = (token: string, x: number, y: number) =>
      pushOne(fx, token, {
        kind: 'asbuilt_edit.record',
        clientOpId: randomUUID(),
        capturedAt: new Date().toISOString(),
        payload: {
          designRevisionId: fx.revisionId,
          note: null,
          gps: null,
          kind: 'move',
          featureId: fx.boxA,
          baseVersion: 0,
          geometry: { type: 'Point', coordinates: [x, y] },
        },
      });
    const flagsOf = async (result: OpResult): Promise<string[]> => {
      if (result.outcome !== 'applied') throw new Error(JSON.stringify(result));
      const { rows } = await ctx.pool.query<{ flags: string[] }>(
        'SELECT flags FROM asbuilt_edits WHERE id = $1',
        [result.updateId],
      );
      return rows[0]?.flags ?? [];
    };
    // Inside the extent of site A's features (plus 50 m): no flag.
    expect(await flagsOf(await move(fx.tokens.supervisorA, E0 + 51, N0 + 5))).toEqual([]);
    // Kilometres away (the extent of site B's drawing, say): applied with the flag.
    expect(await flagsOf(await move(fx.tokens.supervisorA, E0 + 1000, N0 + 1000))).toEqual([
      'OUTSIDE_DRAWING',
    ]);
    // Project-wide callers are not checked.
    expect(await flagsOf(await move(fx.tokens.pm, E0 + 1000, N0 + 1000))).toEqual([]);
  });

  it('lets two supervisors of one site both record on it', async () => {
    const first = await pushOne(fx, fx.tokens.supervisorA, updateOp(fx, fx.boxA, fx.revisionId));
    const second = await pushOne(fx, fx.tokens.supervisorA2, updateOp(fx, fx.boxA, fx.revisionId));
    expect(first.outcome).toBe('applied');
    expect(second.outcome).toBe('applied');
    // Both see both updates on the phone's changes feed.
    for (const token of [fx.tokens.supervisorA, fx.tokens.supervisorA2]) {
      const res = await http()
        .get(`/projects/${fx.projectId}/sync/changes`)
        .query({ cursor: '0', limit: 500 })
        .set(auth(token));
      const changes = SyncChangesResponseSchema.parse(res.body);
      const onBoxA = changes.updates.filter((u) => u.featureId === fx.boxA);
      expect(onBoxA.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('rejects a push on a feature of another site, or of a drawing without a site, with FEATURE_OUT_OF_SCOPE', async () => {
    const onB = await pushOne(fx, fx.tokens.supervisorA, updateOp(fx, fx.boxB, fx.revisionB));
    expect(rejectedWith(onB)).toBe('FEATURE_OUT_OF_SCOPE');
    const onA = await pushOne(fx, fx.tokens.supervisorB, updateOp(fx, fx.boxA, fx.revisionId));
    expect(rejectedWith(onA)).toBe('FEATURE_OUT_OF_SCOPE');
    const { rows } = await ctx.pool.query<{ revision_id: string }>(
      'SELECT id AS revision_id FROM design_revisions WHERE drawing_id = $1',
      [unassignedDrawing],
    );
    const onUnassigned = await pushOne(
      fx,
      fx.tokens.supervisorA,
      updateOp(fx, unassignedFeature, rows[0]?.revision_id ?? ''),
    );
    expect(rejectedWith(onUnassigned)).toBe('FEATURE_OUT_OF_SCOPE');
    // A rejection stores nothing.
    const stored = await ctx.pool.query(
      'SELECT 1 FROM execution_updates WHERE client_op_id = ANY($1::uuid[])',
      [[onB, onA, onUnassigned].map((r) => r.clientOpId)],
    );
    expect(stored.rowCount).toBe(0);
  });

  it('takes a site away: the next push on it is rejected, and giving it back accepts again', async () => {
    const userId = fx.userIds.supervisorA2;
    expect((await putSites(fx, fx.tokens.admin, userId, [fx.siteB])).status).toBe(200);
    const after = await pushOne(fx, fx.tokens.supervisorA2, updateOp(fx, fx.boxA, fx.revisionId));
    expect(rejectedWith(after)).toBe('FEATURE_OUT_OF_SCOPE');
    // His bundle follows at once: only the new site.
    const bundle = OfflineBundleSchema.parse((await bootstrap(fx, fx.tokens.supervisorA2)).body);
    expect(bundle.scope).toEqual({ kind: 'sites', siteIds: [fx.siteB] });
    expect(bundle.drawings.map((d) => d.drawingId)).toEqual([fx.drawingB]);

    expect((await putSites(fx, fx.tokens.admin, userId, [fx.siteA])).status).toBe(200);
    const back = await pushOne(fx, fx.tokens.supervisorA2, updateOp(fx, fx.boxA, fx.revisionId));
    expect(back.outcome).toBe('applied');
  });

  it('gives a supervisor without sites an empty bundle and changes feed, not a 403', async () => {
    const userId = fx.userIds.supervisorB;
    expect((await putSites(fx, fx.tokens.pm, userId, [])).status).toBe(200);
    const res = await bootstrap(fx, fx.tokens.supervisorB);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bundle = OfflineBundleSchema.parse(res.body);
    expect(bundle.scope).toEqual({ kind: 'sites', siteIds: [] });
    expect(bundle.drawings).toEqual([]);
    expect(bundle.features).toEqual([]);
    expect(bundle.revision).toBeNull();
    expect(bundle.asBuilt).toEqual([]);
    const changes = await http()
      .get(`/projects/${fx.projectId}/sync/changes`)
      .query({ cursor: '0', limit: 500 })
      .set(auth(fx.tokens.supervisorB));
    expect(changes.status).toBe(200);
    const parsed = SyncChangesResponseSchema.parse(changes.body);
    expect(parsed.updates).toEqual([]);
    expect(parsed.asBuiltEdits).toEqual([]);
    // He cannot record anywhere, and /auth/me shows the empty list.
    const push = await pushOne(fx, fx.tokens.supervisorB, updateOp(fx, fx.boxB, fx.revisionB));
    expect(rejectedWith(push)).toBe('FEATURE_OUT_OF_SCOPE');
    const me = MeResponseSchema.parse(
      (await http().get('/auth/me').set(auth(fx.tokens.supervisorB))).body,
    );
    expect(me.memberships).toEqual([
      expect.objectContaining({
        projectId: fx.projectId,
        role: 'supervisor',
        zoneIds: [],
        siteIds: [],
      }),
    ]);
  });

  it('shows /auth/me the sites of a supervisor and none for a PM', async () => {
    const supervisor = MeResponseSchema.parse(
      (await http().get('/auth/me').set(auth(fx.tokens.supervisorA))).body,
    );
    expect(supervisor.memberships).toEqual([
      expect.objectContaining({ role: 'supervisor', zoneIds: [], siteIds: [fx.siteA] }),
    ]);
    const pm = MeResponseSchema.parse((await http().get('/auth/me').set(auth(fx.tokens.pm))).body);
    expect(pm.memberships).toEqual([expect.objectContaining({ role: 'pm', siteIds: [] })]);
  });

  it('removes his sites with his supervisor assignment, and keeps them while another supervisor row remains', async () => {
    const userId = fx.userIds.supervisorA;
    expect(await heldSites(fx, userId)).toEqual([fx.siteA]);
    // A second (old, zone-bearing style) supervisor row: removing one row keeps his sites.
    const { rows: assignmentRows } = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM assignments WHERE user_id = $1 AND project_id = $2 AND role = 'supervisor'`,
      [userId, fx.projectId],
    );
    const zone = await ctx.pool.query<{ id: string }>(
      `INSERT INTO zones (project_id, name) VALUES ($1, 'Old zone') RETURNING id`,
      [fx.projectId],
    );
    await ctx.pool.query(
      `INSERT INTO assignments (user_id, project_id, role, zone_id) VALUES ($1, $2, 'supervisor', $3)`,
      [userId, fx.projectId, zone.rows[0]?.id],
    );
    const removeFirst = await http()
      .delete(`/admin/projects/${fx.projectId}/assignments/${assignmentRows[0]?.id}`)
      .set(auth(fx.tokens.admin));
    expect(removeFirst.status).toBe(204);
    expect(await heldSites(fx, userId)).toEqual([fx.siteA]);
    // The old zone row still lets him in as a plain supervisor with his site.
    const still = OfflineBundleSchema.parse((await bootstrap(fx, fx.tokens.supervisorA)).body);
    expect(still.scope).toEqual({ kind: 'sites', siteIds: [fx.siteA] });

    const { rows: last } = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM assignments WHERE user_id = $1 AND project_id = $2 AND role = 'supervisor'`,
      [userId, fx.projectId],
    );
    const removeLast = await http()
      .delete(`/admin/projects/${fx.projectId}/assignments/${last[0]?.id}`)
      .set(auth(fx.tokens.admin));
    expect(removeLast.status).toBe(204);
    expect(await heldSites(fx, userId)).toEqual([]);
    // No assignment any more: no access to the project at all.
    expect((await bootstrap(fx, fx.tokens.supervisorA)).status).toBe(403);
    // Another supervisor's sites are untouched.
    expect(await heldSites(fx, fx.userIds.supervisorB)).toEqual([]);
    expect(await heldSites(fx, fx.userIds.supervisorA2)).toEqual([fx.siteA]);
  });

  it('removes a site from every supervisor when the site is deleted (cascade)', async () => {
    const site = randomUUID();
    await ctx.pool.query(
      `INSERT INTO work_order_sites (id, project_id, work_order_id, name, name_key, position)
       VALUES ($1, $2, $3, 'Temp site', 'temp site', 9)`,
      [site, fx.projectId, fx.workOrderId],
    );
    expect(
      (await putSites(fx, fx.tokens.admin, fx.userIds.supervisorA2, [fx.siteA, site])).status,
    ).toBe(200);
    await ctx.pool.query('DELETE FROM work_order_sites WHERE id = $1', [site]);
    expect(await heldSites(fx, fx.userIds.supervisorA2)).toEqual([fx.siteA]);
  });
});
