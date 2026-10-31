import { createHash, randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ContractItemAvailabilityResponseSchema,
  WorkOrderAttachmentSchema,
  WorkOrderDetailSchema,
  WorkOrderImportPreviewResponseSchema,
  WorkOrderListResponseSchema,
  type WorkOrderDetail,
} from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  buildWorkOrderSheet,
  CONTRACT_LINES,
  ITEM_ROWS,
  setCell,
  workOrderSheetRows,
} from '../src/modules/work-orders/testing/work-order-contract-sheets.js';
import { buildXlsx } from '../src/modules/work-orders/testing/xlsx-builder.js';
import {
  createApprovedContract,
  createProjectIn,
  createWorkOrderFrom,
  type FixtureContract,
  type FixtureLine,
} from './support/contract-fixtures.js';
import { eventTypes, ensureMember, loginAs, SEED_LOGINS } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

let ctx: TestContext;
let admin: string;
let pm: string;
let supervisor: string;
let qc: string;
let contractor: string;

/**
 * Users of this suite. They are separate from the seed users so that adding them to the many
 * projects of the scenarios does not change the memberships other suites assert on.
 */
const USERS = {
  pm: ['wo-pm@ftth.local', 'WoPm#123456', 'pm'],
  supervisor: ['wo-sup@ftth.local', 'WoSup#12345', 'supervisor'],
  qc: ['wo-qc@ftth.local', 'WoQc#123456', 'qc'],
  contractor: ['wo-con@ftth.local', 'WoCon#12345', 'contractor'],
} as const;

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'), { MAX_UPLOAD_MB: '1' });
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
  // A first project creates the users; scenario() adds them to the others.
  await joinAll(await createProjectIn(ctx.pool, null));
  pm = await loginAs(ctx, USERS.pm[0], USERS.pm[1]);
  supervisor = await loginAs(ctx, USERS.supervisor[0], USERS.supervisor[1]);
  qc = await loginAs(ctx, USERS.qc[0], USERS.qc[1]);
  contractor = await loginAs(ctx, USERS.contractor[0], USERS.contractor[1]);
});
afterAll(async () => {
  await ctx.close();
});

const http = () => request(ctx.app.getHttpServer());
const base = (project: string) => `/projects/${project}/work-orders`;
const uniqueNumber = (prefix = 'WO') => `${prefix}-${randomUUID().slice(0, 8)}`;
const auth = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

async function zoneOf(projectId: string): Promise<string> {
  const existing = await ctx.pool.query<{ id: string }>(
    'SELECT id FROM zones WHERE project_id = $1 LIMIT 1',
    [projectId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO zones (project_id, name) VALUES ($1, 'Zone') RETURNING id`,
    [projectId],
  );
  return rows[0]?.id ?? '';
}

/** The suite's pm, supervisor, qc and contractor as members of a project. */
async function joinAll(projectId: string): Promise<void> {
  const zoneId = await zoneOf(projectId);
  for (const [email, password, role] of Object.values(USERS)) {
    await ensureMember(ctx.pool, {
      email,
      password,
      role,
      projectId,
      ...(role === 'supervisor' || role === 'contractor' ? { zoneId } : {}),
    });
  }
}

const LINES: FixtureLine[] = [
  { heading: '1' },
  {
    code: 'A',
    description: 'بند A',
    quantity: '100',
    unitPrice: '10.5',
    workType: 'civil',
    unit: 'م.ط',
  },
  { code: 'B', quantity: '50', unitPrice: '0.25', workType: 'planning' },
  { code: 'C', quantity: '20', unitPrice: '2.5', workType: 'installation', unit: 'عدد' },
];

interface Scenario {
  contract: FixtureContract;
  projectId: string;
  /** Contract item id by code. */
  ids: Record<string, string>;
}

/** A contract and one project of it, with the seed users as members. */
async function scenario(
  lines: FixtureLine[] = LINES,
  approve = true,
  withMembers = true,
): Promise<Scenario> {
  const contract = await createApprovedContract(ctx.pool, lines, { approve });
  const projectId = await createProjectIn(ctx.pool, contract.contractId);
  if (withMembers) await joinAll(projectId);
  return { contract, projectId, ids: contract.itemIds };
}

/** Another project of the same contract. */
async function siblingProject(of: Scenario): Promise<string> {
  const projectId = await createProjectIn(ctx.pool, of.contract.contractId);
  await joinAll(projectId);
  return projectId;
}

const lineBody = (s: Scenario, quantities: Record<string, string>) =>
  Object.entries(quantities).map(([code, quantity]) => ({
    contractItemId: s.ids[code],
    quantity,
  }));

async function createOrder(
  s: Scenario | { projectId: string; ids: Record<string, string> },
  quantities: Record<string, string> = { A: '2', B: '1' },
  body: Record<string, unknown> = {},
  token = pm,
): Promise<WorkOrderDetail> {
  const res = await http()
    .post(base(s.projectId))
    .set('Authorization', `Bearer ${token}`)
    .send({ number: uniqueNumber(), lines: lineBody(s as Scenario, quantities), ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return WorkOrderDetailSchema.parse(res.body);
}

const post = (projectId: string, body: object, token = pm) =>
  http().post(base(projectId)).set('Authorization', `Bearer ${token}`).send(body);

describe('work order from contract lines', () => {
  it('creates a work order whose lines copy the contract item and carry its id', async () => {
    const s = await scenario();
    const number = uniqueNumber();
    const order = await createOrder(s, { A: '2', B: '1' }, { number, title: 'المرحلة الأولى' });

    expect(order).toMatchObject({
      projectId: s.projectId,
      number,
      currency: 'EGP',
      source: 'manual',
      version: 1,
      itemCount: 2,
      total: '21.25',
      duplicateCodes: [],
    });
    expect(order.items.map((i) => [i.lineNo, i.code, i.amount, i.contractItemId])).toEqual([
      [1, 'A', '21', s.ids.A],
      [2, 'B', '0.25', s.ids.B],
    ]);
    expect(order.items[0]).toMatchObject({
      description: 'بند A',
      unit: 'م.ط',
      unitPrice: '10.5',
      workType: 'civil',
    });
    expect(await eventTypes(ctx.pool, order.id)).toEqual(['work_order.created']);
    const { rows } = await ctx.pool.query(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'work_order.created'`,
      [order.id],
    );
    expect(rows[0]?.payload).toMatchObject({
      contractId: s.contract.contractId,
      contractItemIds: [s.ids.A, s.ids.B],
    });
  });

  it('keeps totals equal to SUM(amount) in the database, even with awkward decimals', async () => {
    const s = await scenario([
      { code: 'A', quantity: '99999999999999.9999', unitPrice: '0.2' },
      { code: 'B', quantity: '3', unitPrice: '33.3333' },
      { code: 'C', quantity: '99999999999999.9999', unitPrice: '0.0001' },
      { code: 'D', quantity: '0.0001', unitPrice: '0.0001' },
      { code: 'F', quantity: '3', unitPrice: '5.59936' },
      { code: 'G', quantity: '99999999999999.9999', unitPrice: '99999999999999.999999' },
    ]);
    const order = await createOrder(s, {
      A: '0.1',
      B: '3',
      C: '99999999999999.9999',
      D: '0.0001',
      F: '3',
      G: '99999999999999.9999',
    });
    const { rows } = await ctx.pool.query<{ total: string; matches: boolean }>(
      `SELECT SUM(amount)::text AS total, SUM(amount) = $2::numeric AS matches
       FROM work_order_items WHERE work_order_id = $1`,
      [order.id, order.total],
    );
    expect(rows[0]?.matches, `db ${rows[0]?.total} vs api ${order.total}`).toBe(true);
    expect(order.items.find((i) => i.code === 'F')).toMatchObject({
      unitPrice: '5.59936',
      amount: '16.79808',
    });
  });

  it('lists the one work order of the project and never another project', async () => {
    const s = await scenario();
    const other = await scenario();
    const mine = await createOrder(s);
    const theirs = await createOrder(other);
    const res = await auth(pm)(http().get(base(s.projectId)));
    expect(res.status).toBe(200);
    const ids = WorkOrderListResponseSchema.parse(res.body).items.map((x) => x.id);
    expect(ids).toEqual([mine.id]);
    expect(ids).not.toContain(theirs.id);
  });

  it('refuses a project without a contract, with a draft contract, and a second work order', async () => {
    const legacy = await createProjectIn(ctx.pool, null);
    const noContract = await post(legacy, { number: 'X', lines: [] }, admin);
    expect(noContract.status).toBe(409);
    expect(noContract.body).toMatchObject({ code: 'CONFLICT', details: { reason: 'NO_CONTRACT' } });

    const draft = await scenario(LINES, false);
    const refused = await post(draft.projectId, {
      number: 'X',
      lines: lineBody(draft, { A: '1' }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.details.reason).toBe('CONTRACT_NOT_APPROVED');

    const s = await scenario();
    await createOrder(s);
    const second = await post(s.projectId, { number: uniqueNumber(), lines: [] });
    expect(second.status).toBe(409);
    expect(second.body.details.reason).toBe('WORK_ORDER_EXISTS');
  });

  it('refuses items outside the contract and the headings, and a repeated item', async () => {
    const s = await scenario();
    const other = await scenario();
    const heading = (
      await ctx.pool.query<{ id: string }>(
        `SELECT id FROM contract_items WHERE contract_id = $1 AND kind = 'heading'`,
        [s.contract.contractId],
      )
    ).rows[0]?.id;
    for (const contractItemId of [randomUUID(), other.ids.A, heading]) {
      const res = await post(s.projectId, {
        number: uniqueNumber(),
        lines: [{ contractItemId, quantity: '1' }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details.reason).toBe('NOT_IN_CONTRACT');
    }
    // The same item twice is refused by the schema already (400), and again by the domain on add.
    const twice = await post(s.projectId, {
      number: uniqueNumber(),
      lines: lineBody(s, { A: '1' }).concat(lineBody(s, { A: '2' })),
    });
    expect(twice.status).toBe(400);
    expect(twice.body.code).toBe('VALIDATION_FAILED');
    expect(await workOrderCount(s.projectId)).toBe(0);
  });

  it('refuses a quantity above the contract with contract, reserved, requested and available', async () => {
    const s = await scenario();
    const res = await post(s.projectId, {
      number: uniqueNumber(),
      lines: lineBody(s, { C: '20.0001' }),
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'CONFLICT',
      details: {
        reason: 'QUANTITY_EXCEEDS_CONTRACT',
        contractItemId: s.ids.C,
        code: 'C',
        contractQuantity: '20',
        reservedQuantity: '0',
        requestedQuantity: '20.0001',
        availableQuantity: '20',
      },
    });
    expect(await workOrderCount(s.projectId)).toBe(0);
    // Exactly the contract quantity is allowed.
    await createOrder(s, { C: '20' });
  });

  it('rejects invalid bodies with 400', async () => {
    const s = await scenario();
    for (const body of [
      { number: '' },
      { number: 'x', lines: [{ contractItemId: s.ids.A, quantity: '1.23456' }] },
      { number: 'x', lines: [{ contractItemId: s.ids.A, quantity: 5 }] },
      { number: 'x', lines: [{ contractItemId: 'nope', quantity: '1' }] },
      // The price and the other fields come from the contract and cannot be sent.
      { number: 'x', lines: [{ contractItemId: s.ids.A, quantity: '1', unitPrice: '1' }] },
    ]) {
      const res = await post(s.projectId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('updates the header with optimistic concurrency', async () => {
    const s = await scenario();
    const order = await createOrder(s);
    const patch = (body: Record<string, unknown>) =>
      http()
        .patch(`${base(s.projectId)}/${order.id}`)
        .set('Authorization', `Bearer ${pm}`)
        .send(body);

    const ok = await patch({ title: 'جديد', notes: 'ملاحظة', expectedVersion: 1 });
    expect(ok.status).toBe(200);
    expect(WorkOrderDetailSchema.parse(ok.body)).toMatchObject({
      title: 'جديد',
      notes: 'ملاحظة',
      version: 2,
    });
    const stale = await patch({ title: 'متأخر', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'CONFLICT', details: { reason: 'VERSION_MISMATCH' } });
    const cleared = await patch({ title: null, expectedVersion: 2 });
    expect(cleared.body).toMatchObject({ title: null, version: 3 });
    expect((await patch({ expectedVersion: 3 })).status).toBe(400);
    expect(await eventTypes(ctx.pool, order.id)).toEqual([
      'work_order.created',
      'work_order.updated',
      'work_order.updated',
    ]);
  });

  it('answers 400 for a malformed id', async () => {
    const s = await scenario();
    const res = await auth(pm)(http().get(`${base(s.projectId)}/not-a-uuid`));
    expect(res.status).toBe(400);
  });

  it('rejects a JSON body above 5 MB with 413 FILE_TOO_LARGE', async () => {
    const s = await scenario();
    const res = await post(s.projectId, {
      number: uniqueNumber(),
      notes: 'x'.repeat(5.5 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });
});

async function workOrderCount(projectId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM work_orders WHERE project_id = $1',
    [projectId],
  );
  return rows[0]?.n ?? 0;
}

async function reservedOf(contractItemId: string): Promise<string> {
  const { rows } = await ctx.pool.query<{ s: string }>(
    'SELECT COALESCE(sum(quantity), 0)::text AS s FROM work_order_items WHERE contract_item_id = $1',
    [contractItemId],
  );
  return rows[0]?.s ?? '0';
}

describe('lines: add, edit quantity, delete', () => {
  it('adds a line from a contract item, edits only its quantity and removes it', async () => {
    const s = await scenario();
    const order = await createOrder(s, { A: '2' });
    const url = `${base(s.projectId)}/${order.id}`;
    const authed = auth(pm);

    const added = await authed(http().post(`${url}/items`)).send({
      contractItemId: s.ids.C,
      quantity: '4',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({
      lineNo: 2,
      code: 'C',
      unitPrice: '2.5',
      amount: '10',
      workOrderId: order.id,
      contractItemId: s.ids.C,
      source: 'manual',
    });

    const edited = await authed(http().patch(`${url}/items/${added.body.id}`)).send({
      quantity: '8',
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ quantity: '8', unitPrice: '2.5', amount: '20' });

    // Nothing but the quantity can be edited.
    for (const body of [
      { unitPrice: '1' },
      { code: 'Z' },
      { quantity: '1', workType: 'civil' },
      {},
    ]) {
      const res = await authed(http().patch(`${url}/items/${added.body.id}`)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    const removed = await authed(http().delete(`${url}/items/${order.items[0]?.id}`));
    expect(removed.status).toBe(204);
    const detail = WorkOrderDetailSchema.parse((await authed(http().get(url))).body);
    expect(detail.items.map((i) => i.lineNo)).toEqual([2]);
    expect(detail.total).toBe('20');
    expect(detail.version).toBe(4);
    const itemEvents = await ctx.pool.query<{ type: string }>(
      `SELECT type FROM events WHERE payload->>'workOrderId' = $1 ORDER BY id`,
      [order.id],
    );
    expect(itemEvents.rows.map((r) => r.type)).toEqual([
      'work_order_item.added',
      'work_order_item.updated',
      'work_order_item.removed',
    ]);
  });

  it('add refuses every contract reason with 409', async () => {
    const s = await scenario();
    const other = await scenario();
    const order = await createOrder(s, { A: '2' });
    const url = `${base(s.projectId)}/${order.id}/items`;
    const add = (body: object) => auth(pm)(http().post(url)).send(body);

    const outside = await add({ contractItemId: other.ids.B, quantity: '1' });
    expect([outside.status, outside.body.details.reason]).toEqual([409, 'NOT_IN_CONTRACT']);
    const repeated = await add({ contractItemId: s.ids.A, quantity: '1' });
    expect([repeated.status, repeated.body.details.reason]).toEqual([
      409,
      'CONTRACT_ITEM_REPEATED',
    ]);
    const above = await add({ contractItemId: s.ids.B, quantity: '50.5' });
    expect(above.status).toBe(409);
    expect(above.body.details).toMatchObject({
      reason: 'QUANTITY_EXCEEDS_CONTRACT',
      contractQuantity: '50',
      availableQuantity: '50',
    });
    const taken = await add({ contractItemId: s.ids.B, quantity: '1', lineNo: 1 });
    expect([taken.status, taken.body.details.reason]).toEqual([409, 'LINE_TAKEN']);
  });

  it('edit checks the reservation without counting the line itself', async () => {
    const s = await scenario();
    const order = await createOrder(s, { A: '10' });
    const sibling = await siblingProject(s);
    await createOrder({ projectId: sibling, ids: s.ids }, { A: '5' });
    const patch = (quantity: string) =>
      auth(pm)(http().patch(`${base(s.projectId)}/${order.id}/items/${order.items[0]?.id}`)).send({
        quantity,
      });

    expect((await patch('95')).status).toBe(200); // 95 + 5 = 100
    const above = await patch('95.0001');
    expect(above.status).toBe(409);
    expect(above.body.details).toMatchObject({
      reason: 'QUANTITY_EXCEEDS_CONTRACT',
      reservedQuantity: '5',
      requestedQuantity: '95.0001',
      availableQuantity: '95',
    });
    expect(await reservedOf(s.ids.A ?? '')).toBe('100.0000');
  });

  it('refuses to edit a line saved before contract lines (LEGACY_ITEM) but lets it be deleted', async () => {
    const s = await scenario();
    const order = await createOrder(s, { A: '2' });
    // A legacy line: written while the trigger of migration 0008 is switched off, in one
    // transaction (ALTER TABLE locks out every other session until the commit).
    const client = await ctx.pool.connect();
    let legacyId = '';
    try {
      await client.query('BEGIN');
      await client.query(
        'ALTER TABLE work_order_items DISABLE TRIGGER work_order_items_contract_check',
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO work_order_items (project_id, work_order_id, line_no, code, description, unit,
                                       quantity, unit_price, work_type)
         VALUES ($1, $2, 9, 'OLD', 'old line', 'm', 1, 7, 'civil') RETURNING id`,
        [s.projectId, order.id],
      );
      legacyId = rows[0]?.id ?? '';
      await client.query(
        'ALTER TABLE work_order_items ENABLE TRIGGER work_order_items_contract_check',
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const url = `${base(s.projectId)}/${order.id}/items/${legacyId}`;
    const detail = WorkOrderDetailSchema.parse(
      (await auth(pm)(http().get(`${base(s.projectId)}/${order.id}`))).body,
    );
    expect(detail.items.find((i) => i.id === legacyId)?.contractItemId).toBeNull();

    const refused = await auth(pm)(http().patch(url)).send({ quantity: '2' });
    expect(refused.status).toBe(409);
    expect(refused.body.details.reason).toBe('LEGACY_ITEM');
    expect((await auth(pm)(http().delete(url))).status).toBe(204);
  });

  it('deletes a work order, its lines and files, keeps a snapshot, and frees the quantity', async () => {
    const s = await scenario();
    const order = await createOrder(s, { A: '100' });
    const pdf = await auth(pm)(http().post(`${base(s.projectId)}/${order.id}/attachments`)).attach(
      'file',
      Buffer.from('%PDF-1.7 content'),
      'scope.pdf',
    );
    expect(pdf.status).toBe(201);
    const stored = join(ctx.storageRoot, 'projects', s.projectId, 'work-orders', order.id);
    await access(stored);

    const sibling = await siblingProject(s);
    const blocked = await post(sibling, { number: uniqueNumber(), lines: lineBody(s, { A: '1' }) });
    expect(blocked.status).toBe(409);

    const res = await auth(pm)(http().delete(`${base(s.projectId)}/${order.id}`));
    expect(res.status).toBe(204);
    expect((await auth(pm)(http().get(`${base(s.projectId)}/${order.id}`))).status).toBe(404);
    await expect(access(join(stored, 'attachments', `${pdf.body.id}.pdf`))).rejects.toThrow();
    expect(await reservedOf(s.ids.A ?? '')).toBe('0');
    const { rows } = await ctx.pool.query(
      "SELECT payload FROM events WHERE entity_id = $1 AND type = 'work_order.deleted'",
      [order.id],
    );
    expect(rows[0]?.payload).toMatchObject({
      number: order.number,
      total: '1050',
      items: [expect.objectContaining({ code: 'A', contractItemId: s.ids.A })],
    });

    // The quantity is free again for another project, and this project may start over.
    const now = await post(sibling, { number: uniqueNumber(), lines: lineBody(s, { A: '100' }) });
    expect(now.status, JSON.stringify(now.body)).toBe(201);
    await createOrder(s, { B: '1' });
  });

  it('deleting one line frees exactly its quantity', async () => {
    const s = await scenario();
    const order = await createOrder(s, { A: '70', B: '1' });
    const sibling = await siblingProject(s);
    const ask = (quantity: string) =>
      post(sibling, { number: uniqueNumber(), lines: lineBody(s, { A: quantity }) });
    expect((await ask('30.0001')).status).toBe(409);
    await auth(pm)(http().delete(`${base(s.projectId)}/${order.id}/items/${order.items[0]?.id}`));
    expect((await ask('100')).status).toBe(201);
  });
});

describe('reservation across projects and concurrency', () => {
  it('gives the second project of the same contract only the remainder', async () => {
    const s = await scenario();
    const second = await siblingProject(s);
    await createOrder(s, { A: '60.5' });

    const refused = await post(second, { number: uniqueNumber(), lines: lineBody(s, { A: '40' }) });
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({
      reason: 'QUANTITY_EXCEEDS_CONTRACT',
      reservedQuantity: '60.5',
      requestedQuantity: '40',
      availableQuantity: '39.5',
    });
    const fits = await post(second, { number: uniqueNumber(), lines: lineBody(s, { A: '39.5' }) });
    expect(fits.status, JSON.stringify(fits.body)).toBe(201);
    expect(await reservedOf(s.ids.A ?? '')).toBe('100.0000');
  });

  it('serialises concurrent saves: of two requests for 60 of 100 exactly one succeeds', async () => {
    const s = await scenario();
    const second = await siblingProject(s);
    const results = await Promise.all(
      [s.projectId, second].map((projectId) =>
        post(projectId, { number: uniqueNumber(), lines: lineBody(s, { A: '60' }) }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.details.reason).toBe(
      'QUANTITY_EXCEEDS_CONTRACT',
    );
    expect(await reservedOf(s.ids.A ?? '')).toBe('60.0000');
  });

  it('serialises concurrent transactions in the database: the second insert fails after the first commits', async () => {
    const s = await scenario();
    const second = await siblingProject(s);
    const contract = s.contract;
    const insert = (
      client: { query: (sql: string, values: unknown[]) => Promise<unknown> },
      projectId: string,
    ) =>
      client.query(
        `WITH wo AS (
           INSERT INTO work_orders (project_id, number, currency) VALUES ($1, $2, 'EGP') RETURNING id)
         INSERT INTO work_order_items (project_id, work_order_id, line_no, code, description, unit,
                                       quantity, unit_price, work_type, contract_id, contract_item_id)
         SELECT $1, wo.id, 1, ci.code, ci.description, ci.unit, 60, ci.unit_price, ci.work_type,
                ci.contract_id, ci.id
         FROM contract_items ci, wo WHERE ci.id = $3`,
        [projectId, uniqueNumber(), contract.itemIds.A],
      );
    const first = await ctx.pool.connect();
    const other = await ctx.pool.connect();
    try {
      await first.query('BEGIN');
      await other.query('BEGIN');
      await insert(first, s.projectId);
      // Blocks on the contract row lock held by `first` until it commits.
      const pending = insert(other, second).then(
        () => 'inserted',
        (error: Error) => error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      await first.query('COMMIT');
      expect(await pending).toMatch(/quantity above the contract/);
      await other.query('ROLLBACK');
    } finally {
      first.release();
      other.release();
    }
    expect(await reservedOf(s.ids.A ?? '')).toBe('60.0000');
  });
});

describe('database guarantees (migration 0008)', () => {
  const insertLine = (
    s: Scenario,
    workOrderId: string,
    overrides: {
      lineNo?: number;
      code?: string;
      description?: string;
      unit?: string;
      unitPrice?: string;
      quantity?: string;
      contractId?: string | null;
      contractItemId?: string | null;
      workType?: string;
    },
  ) =>
    ctx.pool.query(
      `INSERT INTO work_order_items (project_id, work_order_id, line_no, code, description, unit,
                                     quantity, unit_price, work_type, contract_id, contract_item_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        s.projectId,
        workOrderId,
        overrides.lineNo ?? 9,
        overrides.code ?? 'B',
        overrides.description ?? 'Test item B',
        overrides.unit ?? 'م.ط',
        overrides.quantity ?? '1',
        overrides.unitPrice ?? '0.25',
        overrides.workType ?? 'planning',
        overrides.contractId === undefined ? s.contract.contractId : overrides.contractId,
        overrides.contractItemId === undefined ? s.ids.B : overrides.contractItemId,
      ],
    );

  async function withOrder(): Promise<{ s: Scenario; workOrderId: string }> {
    const s = await scenario();
    const { workOrderId } = await createWorkOrderFrom(ctx.pool, s.projectId, s.contract, {
      A: '1',
    });
    return { s, workOrderId };
  }

  it('accepts a line equal to its contract item', async () => {
    const { s, workOrderId } = await withOrder();
    await expect(insertLine(s, workOrderId, {})).resolves.toBeDefined();
  });

  it('rejects a new line without a contract item', async () => {
    const { s, workOrderId } = await withOrder();
    await expect(
      insertLine(s, workOrderId, { contractId: null, contractItemId: null }),
    ).rejects.toThrow(/must come from a contract item/);
  });

  it('rejects a line with a different price, unit, description, code or work type', async () => {
    const { s, workOrderId } = await withOrder();
    for (const changed of [
      { unitPrice: '0.26' },
      { unit: 'كم' },
      { description: 'other' },
      { code: 'Z' },
      { workType: 'civil' },
    ]) {
      await expect(insertLine(s, workOrderId, changed), JSON.stringify(changed)).rejects.toThrow(
        /must equal its contract item/,
      );
    }
  });

  it('rejects a heading and an item of another contract', async () => {
    const { s, workOrderId } = await withOrder();
    const heading = (
      await ctx.pool.query<{ id: string }>(
        `SELECT id FROM contract_items WHERE contract_id = $1 AND kind = 'heading'`,
        [s.contract.contractId],
      )
    ).rows[0]?.id;
    await expect(insertLine(s, workOrderId, { contractItemId: heading })).rejects.toThrow(
      /heading/,
    );
    const other = await scenario();
    await expect(
      insertLine(s, workOrderId, {
        contractId: other.contract.contractId,
        contractItemId: other.ids.B,
      }),
    ).rejects.toThrow(/another contract/);
  });

  it('rejects lines under a draft contract', async () => {
    const draft = await scenario(LINES, false);
    await expect(
      createWorkOrderFrom(ctx.pool, draft.projectId, draft.contract, { A: '1' }),
    ).rejects.toThrow(/approved contract/);
  });

  it('rejects a quantity above the contract and a contract item twice in one order', async () => {
    const { s, workOrderId } = await withOrder();
    await expect(insertLine(s, workOrderId, { quantity: '50.0001' })).rejects.toThrow(
      /quantity above the contract/,
    );
    await insertLine(s, workOrderId, { quantity: '50' });
    await expect(insertLine(s, workOrderId, { lineNo: 10, quantity: '0' })).rejects.toThrow(
      /work_order_items_order_contract_item_key/,
    );
  });

  it('allows one work order per project', async () => {
    const { s } = await withOrder();
    await expect(
      ctx.pool.query(
        `INSERT INTO work_orders (project_id, number, currency) VALUES ($1, 'SECOND', 'EGP')`,
        [s.projectId],
      ),
    ).rejects.toThrow(/work_orders_one_per_project/);
  });

  it('keeps the contract link of a line immutable', async () => {
    const { s, workOrderId } = await withOrder();
    await expect(
      ctx.pool.query(`UPDATE work_order_items SET contract_item_id = $2 WHERE work_order_id = $1`, [
        workOrderId,
        s.ids.B,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('contract item availability', () => {
  it('lists priced items in line order with contract, reserved and available quantity', async () => {
    const s = await scenario();
    const second = await siblingProject(s);
    const mine = await createOrder(s, { A: '12.5' });
    await createOrder({ projectId: second, ids: s.ids }, { A: '2', C: '20' });

    const res = await auth(pm)(http().get(`${base(s.projectId)}/contract-items`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const parsed = ContractItemAvailabilityResponseSchema.parse(res.body);
    expect(parsed).toMatchObject({
      contractId: s.contract.contractId,
      contractNumber: s.contract.number,
    });
    expect(
      parsed.items.map((i) => [
        i.code,
        i.contractQuantity,
        i.reservedQuantity,
        i.availableQuantity,
        i.workOrderItemId,
      ]),
    ).toEqual([
      ['A', '100', '14.5', '85.5', mine.items[0]?.id],
      ['B', '50', '0', '50', null],
      ['C', '20', '20', '0', null],
    ]);
    expect(parsed.items[0]).toMatchObject({
      lineNo: 2,
      contractItemId: s.ids.A,
      description: 'بند A',
      unit: 'م.ط',
      unitPrice: '10.5',
      workType: 'civil',
    });
  });

  it('answers 409 NO_CONTRACT and CONTRACT_NOT_APPROVED', async () => {
    const legacy = await createProjectIn(ctx.pool, null);
    const none = await auth(admin)(http().get(`${base(legacy)}/contract-items`));
    expect([none.status, none.body.details.reason]).toEqual([409, 'NO_CONTRACT']);
    const draft = await scenario(LINES, false);
    const refused = await auth(pm)(http().get(`${base(draft.projectId)}/contract-items`));
    expect([refused.status, refused.body.details.reason]).toEqual([409, 'CONTRACT_NOT_APPROVED']);
  });

  it('is for work_orders:write only: 403 for qc, supervisor and contractor, 401 anonymous', async () => {
    const s = await scenario();
    const url = `${base(s.projectId)}/contract-items`;
    for (const token of [qc, supervisor, contractor]) {
      const res = await auth(token)(http().get(url));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    expect((await http().get(url)).status).toBe(401);
    expect((await auth(admin)(http().get(url))).status).toBe(200);
  });
});

describe('access control', () => {
  it('answers NOT_FOUND (never FORBIDDEN) for ids that belong to another project', async () => {
    const mine = await scenario();
    // A project the suite's pm is not a member of.
    const theirs = await scenario(LINES, true, false);
    const inB = await createOrder(theirs, { A: '1' }, {}, admin);
    const url = `${base(mine.projectId)}/${inB.id}`;
    const withPm = auth(pm);

    for (const res of [
      await withPm(http().get(url)),
      await withPm(http().patch(url)).send({ title: 'hijack', expectedVersion: 1 }),
      await withPm(http().delete(url)),
      await withPm(http().post(`${url}/items`)).send({
        contractItemId: mine.ids.B,
        quantity: '1',
      }),
      await withPm(http().patch(`${url}/items/${inB.items[0]?.id}`)).send({ quantity: '2' }),
      await withPm(http().delete(`${url}/items/${inB.items[0]?.id}`)),
      await withPm(http().get(`${url}/attachments`)),
    ]) {
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    const untouched = await ctx.pool.query('SELECT version, title FROM work_orders WHERE id = $1', [
      inB.id,
    ]);
    expect(untouched.rows[0]).toMatchObject({ version: 1, title: null });
    // pm is not a member of the other project at all.
    expect((await withPm(http().get(`${base(theirs.projectId)}/${inB.id}`))).status).toBe(403);
  });

  it('lets a supervisor and qc read but not write', async () => {
    const s = await scenario();
    const order = await createOrder(s);
    for (const token of [supervisor, qc]) {
      const authed = auth(token);
      expect((await authed(http().get(base(s.projectId)))).status).toBe(200);
      expect((await authed(http().get(`${base(s.projectId)}/${order.id}`))).status).toBe(200);
      for (const res of [
        await authed(http().post(base(s.projectId))).send({ number: uniqueNumber() }),
        await authed(http().patch(`${base(s.projectId)}/${order.id}`)).send({
          title: 'x',
          expectedVersion: 1,
        }),
        await authed(http().delete(`${base(s.projectId)}/${order.id}`)),
        await authed(http().post(`${base(s.projectId)}/${order.id}/items`)).send({
          contractItemId: s.ids.C,
          quantity: '1',
        }),
        await authed(
          http().patch(`${base(s.projectId)}/${order.id}/items/${order.items[0]?.id}`),
        ).send({ quantity: '1' }),
        await authed(http().post(`${base(s.projectId)}/import/preview`)).attach(
          'file',
          Buffer.from('x'),
          'a.xlsx',
        ),
      ]) {
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    }
  });

  it('denies a contractor everything, and anonymous callers 401', async () => {
    const s = await scenario();
    const order = await createOrder(s);
    const authed = auth(contractor);
    expect((await authed(http().get(base(s.projectId)))).status).toBe(403);
    expect((await authed(http().get(`${base(s.projectId)}/${order.id}`))).status).toBe(403);
    expect((await authed(http().post(base(s.projectId))).send({ number: 'x' })).status).toBe(403);
    expect((await http().get(base(s.projectId))).status).toBe(401);
  });

  it('lets a platform admin act in any project', async () => {
    const s = await scenario();
    const order = await createOrder(s, { A: '1' }, {}, admin);
    const res = await auth(admin)(http().get(`${base(s.projectId)}/${order.id}`));
    expect(res.status).toBe(200);
  });
});

describe('PDF attachments', () => {
  it('uploads, lists, downloads byte for byte, and deletes', async () => {
    const s = await scenario();
    const order = await createOrder(s);
    const url = `${base(s.projectId)}/${order.id}/attachments`;
    const content = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300_000, 7)]);

    const up = await http()
      .post(url)
      .set('Authorization', `Bearer ${pm}`)
      .attach('file', content, { filename: 'أمر التكليف.pdf', contentType: 'application/pdf' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const attachment = WorkOrderAttachmentSchema.parse(up.body);
    expect(attachment).toMatchObject({
      workOrderId: order.id,
      kind: 'document',
      fileName: 'أمر التكليف.pdf',
      sizeBytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });

    const list = await auth(supervisor)(http().get(url));
    expect(list.body.items.map((a: { id: string }) => a.id)).toEqual([attachment.id]);

    const download = await http()
      .get(`${url}/${attachment.id}/content`)
      .set('Authorization', `Bearer ${supervisor}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect((download.body as Buffer).equals(content)).toBe(true);

    const detail = await auth(pm)(http().get(`${base(s.projectId)}/${order.id}`));
    expect(detail.body.attachmentCount).toBe(1);

    const removed = await auth(pm)(http().delete(`${url}/${attachment.id}`));
    expect(removed.status).toBe(204);
    const stored = await readFile(
      join(
        ctx.storageRoot,
        'projects',
        s.projectId,
        'work-orders',
        order.id,
        'attachments',
        `${attachment.id}.pdf`,
      ),
    ).catch(() => null);
    expect(stored).toBeNull();
    expect(await eventTypes(ctx.pool, attachment.id)).toEqual([
      'work_order_attachment.added',
      'work_order_attachment.removed',
    ]);
  });

  it('refuses non-PDF content with 415 and oversize files with 413, storing nothing', async () => {
    const s = await scenario();
    const order = await createOrder(s);
    const url = `${base(s.projectId)}/${order.id}/attachments`;
    const send = (content: Buffer, name: string) =>
      http().post(url).set('Authorization', `Bearer ${pm}`).attach('file', content, name);

    const text = await send(Buffer.from('just text'), 'a.pdf');
    expect(text.status).toBe(415);
    expect(text.body.code).toBe('UNSUPPORTED_FILE');
    expect((await send(Buffer.from('%PDF-1.7'), 'a.docx')).status).toBe(415);
    const big = await send(
      Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(1_100_000)]),
      'big.pdf',
    );
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('FILE_TOO_LARGE');
    const missing = await http().post(url).set('Authorization', `Bearer ${pm}`).field('other', 'x');
    expect(missing.status).toBe(400);
    expect((await auth(pm)(http().get(url))).body.items).toEqual([]);
  });
});

describe('Excel import against the contract (owner layout)', () => {
  const WORK_TYPE_CODES = { مدني: 'civil', تركيبات: 'installation', تخطيط: 'planning' } as const;
  /** The contract of the synthetic owner sheet: 5 priced items and 3 headings. */
  const sheetContract: FixtureLine[] = CONTRACT_LINES.map((line) =>
    line.unit === undefined
      ? { heading: line.code, description: line.description }
      : {
          code: line.code,
          description: line.description,
          unit: line.unit,
          quantity: String(line.quantity),
          unitPrice: String(line.unitPrice),
          workType: WORK_TYPE_CODES[(line.workType ?? 'مدني') as keyof typeof WORK_TYPE_CODES],
        },
  );
  const importScenario = () => scenario(sheetContract);

  const preview = (projectId: string, file: Buffer, payload: object = {}, token = pm) =>
    http()
      .post(`${base(projectId)}/import/preview`)
      .set('Authorization', `Bearer ${token}`)
      .field('payload', JSON.stringify(payload))
      .attach('file', file, 'wo.xlsx');
  const commit = (projectId: string, file: Buffer, payload: object, token = pm, name = 'wo.xlsx') =>
    http()
      .post(`${base(projectId)}/import`)
      .set('Authorization', `Bearer ${token}`)
      .field('payload', JSON.stringify(payload))
      .attach('file', file, name);
  const commitPayload = (file: Buffer, overrides: object = {}) => ({
    fileSha256: createHash('sha256').update(file).digest('hex'),
    sheetName: 'WO',
    headerRow: 3,
    mapping: {
      code: 0,
      workType: 1,
      description: 2,
      unit: 3,
      quantity: 4,
      unitPrice: 5,
      amount: 6,
    },
    workOrder: { number: uniqueNumber('IMP'), title: 'Imported' },
    ...overrides,
  });
  const issuesOf = (
    body: { rows: { rowNumber: number; issues: { code: string }[] }[] },
    row: number,
  ) => body.rows.find((r) => r.rowNumber === row)?.issues.map((i) => i.code) ?? [];

  it('previews a matching sheet with no errors, then commits lines linked to contract items', async () => {
    const s = await importScenario();
    const file = await buildWorkOrderSheet();
    const before = await workOrderCount(s.projectId);

    const prev = await preview(s.projectId, file);
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    const parsed = WorkOrderImportPreviewResponseSchema.parse(prev.body);
    expect(parsed).toMatchObject({
      sheetName: 'WO',
      headerRow: 3,
      summary: { rowCount: 8, headingCount: 3, errorRowCount: 0, total: '81289' },
      file: { name: 'wo.xlsx', sha256: createHash('sha256').update(file).digest('hex') },
    });
    expect(await workOrderCount(s.projectId)).toBe(before);

    const res = await commit(s.projectId, file, commitPayload(file));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = WorkOrderDetailSchema.parse(res.body);
    expect(order).toMatchObject({
      source: 'import',
      currency: 'EGP',
      total: '81289',
      itemCount: 5,
    });
    expect(order.items.map((i) => [i.lineNo, i.code, i.sourceRow, i.contractItemId])).toEqual(
      Object.entries(ITEM_ROWS).map(([, row], index) => {
        const code = CONTRACT_LINES[row - 4]?.code ?? '';
        return [index + 1, code, row, s.ids[code]];
      }),
    );
    expect(order.attachments).toHaveLength(1);
    expect(order.attachments[0]).toMatchObject({ kind: 'import_source', fileName: 'wo.xlsx' });
    expect(await eventTypes(ctx.pool, order.id)).toEqual(['work_order.imported']);

    // The stored xlsx can be downloaded, but not deleted.
    const url = `${base(s.projectId)}/${order.id}/attachments/${order.attachments[0]?.id}`;
    const del = await auth(pm)(http().delete(url));
    expect(del.status).toBe(409);
  });

  it('reports every difference as an error with the contract value, and commit refuses them', async () => {
    const s = await importScenario();
    const rows = workOrderSheetRows();
    setCell(rows, ITEM_ROWS.trench, 'unitPrice', 13); // price
    setCell(rows, ITEM_ROWS.chamber, 'unit', 'كم'); // unit
    setCell(rows, ITEM_ROWS.cable, 'description', 'كابل آخر'); // description
    setCell(rows, ITEM_ROWS.joint, 'workType', 'مدني'); // work type
    setCell(rows, ITEM_ROWS.building, 'code', '9-9-9'); // not in the contract
    const file = await buildWorkOrderSheet(rows);

    const prev = await preview(s.projectId, file);
    expect(prev.status).toBe(200);
    expect(prev.body.summary.errorRowCount).toBe(5);
    // Errors only: a changed price also makes the sheet amount disagree (a warning).
    const issue = (row: number) =>
      prev.body.rows
        .find((r: { rowNumber: number }) => r.rowNumber === row)
        .issues.filter((found: { severity: string }) => found.severity === 'error');
    expect(issue(ITEM_ROWS.trench)).toEqual([
      expect.objectContaining({
        code: 'CONTRACT_MISMATCH',
        field: 'unitPrice',
        params: { contractValue: '12.5' },
      }),
    ]);
    expect(issue(ITEM_ROWS.chamber)[0]).toMatchObject({
      field: 'unit',
      params: { contractValue: 'عدد' },
    });
    expect(issue(ITEM_ROWS.cable)[0]).toMatchObject({
      field: 'description',
      params: { contractValue: 'كابل رئيسي' },
    });
    expect(issue(ITEM_ROWS.joint)[0]).toMatchObject({
      field: 'workType',
      params: { contractValue: 'installation' },
    });
    expect(issue(ITEM_ROWS.building)[0]).toMatchObject({ code: 'NOT_IN_CONTRACT' });

    const refused = await commit(s.projectId, file, commitPayload(file));
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      code: 'IMPORT_INVALID',
      details: { reason: 'ROW_ERRORS' },
    });
    expect(refused.body.details.rows).toHaveLength(5);
    expect(await workOrderCount(s.projectId)).toBe(0);
    expect(
      (
        await ctx.pool.query('SELECT 1 FROM work_order_attachments WHERE project_id = $1', [
          s.projectId,
        ])
      ).rowCount,
    ).toBe(0);

    // Every item row has an error, so excluding them all leaves nothing to import.
    const rest = await commit(
      s.projectId,
      file,
      commitPayload(file, { excludedRowNumbers: Object.values(ITEM_ROWS) }),
    );
    expect(rest.status).toBe(422);
    expect(rest.body.details.reason).toBe('NO_ROWS_INCLUDED');
  });

  it('treats 8000 and 8000.00 as the same price', async () => {
    const s = await importScenario();
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.chamber, 'unitPrice', '8000.00');
    const file = await buildWorkOrderSheet(rows);
    const prev = await preview(s.projectId, file);
    expect(prev.body.summary.errorRowCount).toBe(0);
  });

  it('marks a repeated code on both rows and a quantity above the contract', async () => {
    const s = await importScenario();
    const rows = workOrderSheetRows();
    setCell(rows, ITEM_ROWS.joint, 'code', '2-9-1'); // same code as the cable row, other fields differ too
    setCell(rows, ITEM_ROWS.building, 'quantity', 7); // contract 6
    const file = await buildWorkOrderSheet(rows);

    const prev = (await preview(s.projectId, file)).body;
    expect(issuesOf(prev, ITEM_ROWS.cable)).toContain('CODE_REPEATED');
    expect(issuesOf(prev, ITEM_ROWS.joint)).toContain('CODE_REPEATED');
    expect(
      prev.rows
        .flatMap((r: { issues: { code: string }[] }) => r.issues)
        .some((i: { code: string }) => i.code === 'DUPLICATE_CODE'),
    ).toBe(false);
    const over = prev.rows
      .find((r: { rowNumber: number }) => r.rowNumber === ITEM_ROWS.building)
      .issues.find((i: { code: string }) => i.code === 'QUANTITY_EXCEEDS_CONTRACT');
    expect(over.params).toEqual({
      availableQuantity: '6',
      contractQuantity: '6',
      reservedQuantity: '0',
    });

    // acceptedDuplicateCodes does not help.
    const refused = await commit(
      s.projectId,
      file,
      commitPayload(file, { acceptedDuplicateCodes: ['2-9-1'] }),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.details.reason).toBe('ROW_ERRORS');
  });

  it('subtracts what another project of the contract reserved', async () => {
    const s = await importScenario();
    const second = await siblingProject(s);
    const file = await buildWorkOrderSheet();
    expect((await commit(s.projectId, file, commitPayload(file))).status).toBe(201);

    // Second project: the trench has 300 − 100 = 200 left, so the same sheet fits again (100)...
    const again = await commit(second, file, commitPayload(file));
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    // ...and a third gets 100, a fourth does not (300 reserved in all).
    const third = await siblingProject(s);
    expect((await commit(third, file, commitPayload(file))).status).toBe(201);
    const fourth = await siblingProject(s);
    const prev = (await preview(fourth, file)).body;
    expect(issuesOf(prev, ITEM_ROWS.trench)).toContain('QUANTITY_EXCEEDS_CONTRACT');
    const refused = await commit(fourth, file, commitPayload(file));
    expect(refused.status).toBe(422);
    expect(await workOrderCount(fourth)).toBe(0);
  });

  it('answers 409 before reading the file: no contract, draft contract, work order exists', async () => {
    const legacy = await createProjectIn(ctx.pool, null);
    await joinAll(legacy);
    const garbage = Buffer.from('not an xlsx');
    const noContract = await preview(legacy, garbage);
    expect([noContract.status, noContract.body.details.reason]).toEqual([409, 'NO_CONTRACT']);
    const noCommit = await commit(legacy, garbage, commitPayload(garbage));
    expect([noCommit.status, noCommit.body.details.reason]).toEqual([409, 'NO_CONTRACT']);

    const draft = await scenario(sheetContract, false);
    const draftRes = await preview(draft.projectId, garbage);
    expect([draftRes.status, draftRes.body.details.reason]).toEqual([409, 'CONTRACT_NOT_APPROVED']);
    expect((await commit(draft.projectId, garbage, commitPayload(garbage))).status).toBe(409);

    const s = await importScenario();
    const file = await buildWorkOrderSheet();
    expect((await commit(s.projectId, file, commitPayload(file))).status).toBe(201);
    const exists = await preview(s.projectId, garbage);
    expect([exists.status, exists.body.details.reason]).toEqual([409, 'WORK_ORDER_EXISTS']);
    const existsCommit = await commit(s.projectId, file, commitPayload(file));
    expect([existsCommit.status, existsCommit.body.details.reason]).toEqual([
      409,
      'WORK_ORDER_EXISTS',
    ]);
  });

  it('refuses a changed file (FILE_CHANGED) and leaves no work order and no stored file', async () => {
    const s = await importScenario();
    const file = await buildWorkOrderSheet();
    const other = await buildWorkOrderSheet(
      setCell(workOrderSheetRows(), ITEM_ROWS.cable, 'quantity', 4),
    );
    const changed = await commit(s.projectId, other, commitPayload(file));
    expect(changed.status).toBe(422);
    expect(changed.body.details.reason).toBe('FILE_CHANGED');
    expect(await workOrderCount(s.projectId)).toBe(0);
  });

  it('refuses .xls, .csv and disguised files with 415 UNSUPPORTED_FILE', async () => {
    const s = await importScenario();
    const file = await buildWorkOrderSheet();
    const asXls = await commit(s.projectId, file, commitPayload(file), pm, 'wo.xls');
    expect(asXls.status).toBe(415);
    expect(asXls.body.code).toBe('UNSUPPORTED_FILE');
    expect(
      (await commit(s.projectId, Buffer.from('a,b\n1,2'), commitPayload(file), pm, 'wo.csv'))
        .status,
    ).toBe(415);
    expect(
      (await commit(s.projectId, Buffer.from('PK\u0003\u0004junk'), commitPayload(file), pm))
        .status,
    ).toBe(415);
  });

  it('validates the payload field and the upload size', async () => {
    const s = await importScenario();
    const file = await buildWorkOrderSheet();
    const noPayload = await http()
      .post(`${base(s.projectId)}/import`)
      .set('Authorization', `Bearer ${pm}`)
      .attach('file', file, 'wo.xlsx');
    expect(noPayload.status).toBe(400);
    const badJson = await http()
      .post(`${base(s.projectId)}/import`)
      .set('Authorization', `Bearer ${pm}`)
      .field('payload', '{nope')
      .attach('file', file, 'wo.xlsx');
    expect(badJson.status).toBe(400);
    const noFile = await http()
      .post(`${base(s.projectId)}/import/preview`)
      .set('Authorization', `Bearer ${pm}`)
      .field('payload', '{}');
    expect(noFile.status).toBe(400);
    const huge = await preview(s.projectId, Buffer.concat([file, Buffer.alloc(1_200_000)]));
    expect(huge.status).toBe(413);
    expect(huge.body.code).toBe('FILE_TOO_LARGE');
  });

  it('reports file-level problems in the preview instead of failing', async () => {
    const s = await importScenario();
    const file = await buildXlsx([{ name: 'Empty', rows: [['nothing here']] }]);
    const res = await preview(s.projectId, file);
    expect(res.status).toBe(200);
    expect(res.body.fileIssues).toEqual([{ code: 'HEADER_ROW_NOT_FOUND', field: null }]);
    expect(res.body.rows).toEqual([]);
  });
});
