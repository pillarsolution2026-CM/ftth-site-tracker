import { randomUUID } from 'node:crypto';
import {
  WorkOrderDetailSchema,
  WorkOrderSiteListResponseSchema,
  WorkOrderSitesPreviewResponseSchema,
} from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildXlsx } from '../src/modules/work-orders/testing/xlsx-builder.js';
import {
  createApprovedContract,
  createProjectIn,
  createWorkOrderFrom,
} from './support/contract-fixtures.js';
import { ensureMember, eventTypes, loginAs, SEED_LOGINS } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

/** ADR-049 part A: the work order's central and sites, on a real PostGIS database. */
let ctx: TestContext;
let admin: string;
let pm: string;
let qc: string;

const USERS = {
  pm: ['sites-pm@ftth.local', 'SitesPm#12345', 'pm'],
  qc: ['sites-qc@ftth.local', 'SitesQc#12345', 'qc'],
} as const;

const LINES = [{ code: 'A', quantity: '10', unitPrice: '1', workType: 'civil' as const }];

async function workOrder(): Promise<{ projectId: string; workOrderId: string }> {
  const contract = await createApprovedContract(ctx.pool, LINES, { approve: true });
  const projectId = await createProjectIn(ctx.pool, contract.contractId);
  for (const [email, password, role] of Object.values(USERS)) {
    await ensureMember(ctx.pool, { email, password, role, projectId });
  }
  const { workOrderId } = await createWorkOrderFrom(ctx.pool, projectId, contract, { A: '1' });
  return { projectId, workOrderId };
}

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
  await workOrder();
  pm = await loginAs(ctx, USERS.pm[0], USERS.pm[1]);
  qc = await loginAs(ctx, USERS.qc[0], USERS.qc[1]);
});
afterAll(async () => {
  await ctx.close();
});

const http = () => request(ctx.app.getHttpServer());
const sitesUrl = (p: string, w: string) => `/projects/${p}/work-orders/${w}/sites`;

async function versionOf(projectId: string, workOrderId: string): Promise<number> {
  const res = await http()
    .get(sitesUrl(projectId, workOrderId))
    .set('Authorization', `Bearer ${pm}`)
    .expect(200);
  return WorkOrderSiteListResponseSchema.parse(res.body).version;
}

describe('work-order central (ADR-049)', () => {
  it('is set and changed with the header and recorded in the update event', async () => {
    const { projectId, workOrderId } = await workOrder();
    const url = `/projects/${projectId}/work-orders/${workOrderId}`;
    const before = WorkOrderDetailSchema.parse(
      (await http().get(url).set('Authorization', `Bearer ${pm}`).expect(200)).body,
    );
    expect(before.central).toBeNull();
    const res = await http()
      .patch(url)
      .set('Authorization', `Bearer ${pm}`)
      .send({ central: 'سنترال 1', expectedVersion: before.version })
      .expect(200);
    expect(WorkOrderDetailSchema.parse(res.body).central).toBe('سنترال 1');
    const { rows } = await ctx.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'work_order.updated'`,
      [workOrderId],
    );
    expect(rows[0]?.payload).toMatchObject({
      before: { central: null },
      after: { central: 'سنترال 1' },
    });
  });

  it('is accepted when the work order is created', async () => {
    const contract = await createApprovedContract(ctx.pool, LINES, { approve: true });
    const projectId = await createProjectIn(ctx.pool, contract.contractId);
    const res = await http()
      .post(`/projects/${projectId}/work-orders`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ number: `WO-${randomUUID().slice(0, 6)}`, central: 'سنترال 2' })
      .expect(201);
    expect(WorkOrderDetailSchema.parse(res.body).central).toBe('سنترال 2');
  });
});

describe('work-order sites (ADR-049)', () => {
  it('adds, renames, reorders and removes sites, keeping ids, with one event per change', async () => {
    const { projectId, workOrderId } = await workOrder();
    const url = sitesUrl(projectId, workOrderId);
    let version = await versionOf(projectId, workOrderId);

    const added = WorkOrderSiteListResponseSchema.parse(
      (
        await http()
          .put(url)
          .set('Authorization', `Bearer ${pm}`)
          .send({ expectedVersion: version, sites: [{ name: 'موقع أ' }, { name: 'موقع  ب' }] })
          .expect(200)
      ).body,
    );
    expect(added.items.map((site) => [site.name, site.position])).toEqual([
      ['موقع أ', 1],
      ['موقع ب', 2],
    ]);
    expect(added.version).toBe(version + 1);
    version = added.version;
    const [a, b] = added.items;

    // Swap the two names (deferred unique key) and drop nothing.
    const swapped = WorkOrderSiteListResponseSchema.parse(
      (
        await http()
          .put(url)
          .set('Authorization', `Bearer ${admin}`)
          .send({
            expectedVersion: version,
            sites: [
              { id: a?.id, name: 'موقع ب' },
              { id: b?.id, name: 'موقع أ' },
            ],
          })
          .expect(200)
      ).body,
    );
    expect(swapped.items.map((site) => [site.id, site.name])).toEqual([
      [a?.id, 'موقع ب'],
      [b?.id, 'موقع أ'],
    ]);
    version = swapped.version;

    const removed = WorkOrderSiteListResponseSchema.parse(
      (
        await http()
          .put(url)
          .set('Authorization', `Bearer ${pm}`)
          .send({ expectedVersion: version, sites: [{ id: b?.id, name: 'موقع أ' }] })
          .expect(200)
      ).body,
    );
    expect(removed.items.map((site) => [site.id, site.position])).toEqual([[b?.id, 1]]);

    const types = await eventTypes(ctx.pool, workOrderId);
    expect(types.filter((type) => type === 'work_order.sites_changed')).toHaveLength(3);
  });

  it('saving the same list changes nothing and records no event', async () => {
    const { projectId, workOrderId } = await workOrder();
    const url = sitesUrl(projectId, workOrderId);
    const first = WorkOrderSiteListResponseSchema.parse(
      (
        await http()
          .put(url)
          .set('Authorization', `Bearer ${pm}`)
          .send({
            expectedVersion: await versionOf(projectId, workOrderId),
            sites: [{ name: 'x' }],
          })
          .expect(200)
      ).body,
    );
    const again = WorkOrderSiteListResponseSchema.parse(
      (
        await http()
          .put(url)
          .set('Authorization', `Bearer ${pm}`)
          .send({
            expectedVersion: first.version,
            sites: [{ id: first.items[0]?.id, name: 'x' }],
          })
          .expect(200)
      ).body,
    );
    expect(again.version).toBe(first.version);
    const types = await eventTypes(ctx.pool, workOrderId);
    expect(types.filter((type) => type === 'work_order.sites_changed')).toHaveLength(1);
  });

  it('refuses a repeated name, a stale version and an id of another work order', async () => {
    const { projectId, workOrderId } = await workOrder();
    const other = await workOrder();
    const url = sitesUrl(projectId, workOrderId);
    const version = await versionOf(projectId, workOrderId);
    await http()
      .put(url)
      .set('Authorization', `Bearer ${pm}`)
      .send({ expectedVersion: version, sites: [{ name: 'أم شيحان' }, { name: 'ام  شيحان' }] })
      .expect(400);
    await http()
      .put(url)
      .set('Authorization', `Bearer ${pm}`)
      .send({ expectedVersion: version + 5, sites: [{ name: 'x' }] })
      .expect(409);
    const foreign = WorkOrderSiteListResponseSchema.parse(
      (
        await http()
          .put(sitesUrl(other.projectId, other.workOrderId))
          .set('Authorization', `Bearer ${admin}`)
          .send({
            expectedVersion: await versionOf(other.projectId, other.workOrderId),
            sites: [{ name: 'y' }],
          })
          .expect(200)
      ).body,
    );
    const res = await http()
      .put(url)
      .set('Authorization', `Bearer ${pm}`)
      .send({ expectedVersion: version, sites: [{ id: foreign.items[0]?.id, name: 'y' }] })
      .expect(409);
    expect(res.body.details.reason).toBe('SITE_NOT_FOUND');
  });

  it('lets QC read the sites but not change them', async () => {
    const { projectId, workOrderId } = await workOrder();
    const url = sitesUrl(projectId, workOrderId);
    await http().get(url).set('Authorization', `Bearer ${qc}`).expect(200);
    await http()
      .put(url)
      .set('Authorization', `Bearer ${qc}`)
      .send({ expectedVersion: 1, sites: [] })
      .expect(403);
  });

  it('reads the names of a sites table without saving them', async () => {
    const { projectId, workOrderId } = await workOrder();
    const file = await buildXlsx([
      {
        name: 'المواقع',
        rows: [
          [null, 'اسم الموقع'],
          [null, 'موقع 1'],
          [null, null],
          [null, 'موقع 2'],
          [null, 'موقع  1'],
        ],
      },
    ]);
    const res = await http()
      .post(`${sitesUrl(projectId, workOrderId)}/preview`)
      .set('Authorization', `Bearer ${pm}`)
      .attach('file', file, 'sites.xlsx')
      .expect(200);
    expect(WorkOrderSitesPreviewResponseSchema.parse(res.body)).toEqual({
      sheetName: 'المواقع',
      names: ['موقع 1', 'موقع 2'],
      repeated: ['موقع 1'],
      tooLongRows: [],
    });
    const list = await http()
      .get(sitesUrl(projectId, workOrderId))
      .set('Authorization', `Bearer ${pm}`)
      .expect(200);
    expect(list.body.items).toEqual([]);
    await http()
      .post(`${sitesUrl(projectId, workOrderId)}/preview`)
      .set('Authorization', `Bearer ${pm}`)
      .attach('file', Buffer.from('not a workbook'), 'sites.xlsx')
      .expect(415);
  });

  it('removes the sites with their work order', async () => {
    const { projectId, workOrderId } = await workOrder();
    await http()
      .put(sitesUrl(projectId, workOrderId))
      .set('Authorization', `Bearer ${pm}`)
      .send({ expectedVersion: await versionOf(projectId, workOrderId), sites: [{ name: 'z' }] })
      .expect(200);
    await http()
      .delete(`/projects/${projectId}/work-orders/${workOrderId}`)
      .set('Authorization', `Bearer ${pm}`)
      .expect(204);
    const { rows } = await ctx.pool.query(
      'SELECT 1 FROM work_order_sites WHERE work_order_id = $1',
      [workOrderId],
    );
    expect(rows).toHaveLength(0);
  });
});
