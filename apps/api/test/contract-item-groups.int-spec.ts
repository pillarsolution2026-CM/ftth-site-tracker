import { randomUUID } from 'node:crypto';
import { ContractDetailSchema, WorkOrderDetailSchema, type ContractDetail } from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createApprovedContract,
  createProjectIn,
  createWorkOrderFrom,
} from './support/contract-fixtures.js';
import { ensureMember, eventTypes, loginAs, SEED_LOGINS } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

let ctx: TestContext;
let admin: string;
let pm: string;

const MISSING = '99999999-9999-4999-8999-999999999999';
const http = () => request(ctx.app.getHttpServer());
const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer ${admin}`);

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
  pm = await loginAs(ctx, ...SEED_LOGINS.pm);
});
afterAll(async () => {
  await ctx.close();
});

const line = (code: string, description: string) => ({
  kind: 'item',
  code,
  description,
  unit: 'م.ط',
  quantity: '2',
  unitPrice: '10.5',
  workType: 'civil',
});

async function createContract(): Promise<ContractDetail> {
  const res = await asAdmin(http().post('/admin/contracts')).send({
    number: `C-${randomUUID().slice(0, 8)}`,
    name: 'عقد',
    client: 'العميل',
    currency: 'EGP',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ContractDetailSchema.parse(res.body);
}

async function addItem(contract: ContractDetail, item: object): Promise<ContractDetail> {
  const res = await asAdmin(http().post(`/admin/contracts/${contract.id}/items`)).send({
    item,
    expectedVersion: contract.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ContractDetailSchema.parse(res.body);
}

const putGroup = (contractId: string, itemId: string, body: object, token = admin) =>
  http()
    .put(`/admin/contracts/${contractId}/items/${itemId}/group`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

/** A draft contract: a heading, a line the rule groups (end caps) and one nobody can group. */
async function draftWithLines() {
  let contract = await createContract();
  contract = await addItem(contract, { kind: 'heading', code: '1', description: 'قسم' });
  contract = await addItem(contract, line('1-1', 'end caps'));
  contract = await addItem(contract, line('1-2', 'zzz'));
  const id = (code: string) => contract.items.find((i) => i.code === code)?.id ?? '';
  return { contract, heading: id('1'), ruled: id('1-1'), unruled: id('1-2') };
}

describe('contract item groups (ADR-048)', () => {
  it('shows rule, none and the ungrouped count; headings have no group', async () => {
    const { contract } = await draftWithLines();
    expect(contract.ungroupedItemCount).toBe(1);
    const byCode = (code: string) => contract.items.find((i) => i.code === code)?.group;
    expect(byCode('1')).toBeNull();
    expect(byCode('1-1')).toMatchObject({ source: 'rule', group: { main: 'طبات', sub: null } });
    expect(byCode('1-2')).toMatchObject({ source: 'none', group: null });
  });

  it('sets, changes and clears a manual group in a draft; events record before and after', async () => {
    const { contract, ruled, unruled } = await draftWithLines();
    const set = await putGroup(contract.id, unruled, {
      main: 'مخصص',
      sub: 'فرعي',
      expectedVersion: contract.version,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const detail = ContractDetailSchema.parse(set.body);
    expect(detail.version).toBe(contract.version + 1);
    expect(detail.ungroupedItemCount).toBe(0);
    expect(detail.items.find((i) => i.id === unruled)?.group).toMatchObject({
      source: 'manual',
      group: { main: 'مخصص', sub: 'فرعي' },
    });

    // A manual choice wins over the rule; main null goes back to it.
    const over = await putGroup(contract.id, ruled, {
      main: 'يدوي',
      expectedVersion: detail.version,
    });
    expect(over.status).toBe(200);
    const back = await putGroup(contract.id, ruled, {
      main: null,
      expectedVersion: detail.version + 1,
    });
    expect(back.status).toBe(200);
    expect(
      ContractDetailSchema.parse(back.body).items.find((i) => i.id === ruled)?.group,
    ).toMatchObject({ source: 'rule', group: { main: 'طبات' } });

    expect(await eventTypes(ctx.pool, ruled)).toEqual([
      'contract_item.added',
      'contract_item.group_set',
      'contract_item.group_set',
    ]);
    const { rows } = await ctx.pool.query<{ payload: unknown }>(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'contract_item.group_set' ORDER BY id`,
      [ruled],
    );
    expect(rows[1]?.payload).toMatchObject({
      code: '1-1',
      before: { main: 'يدوي', sub: null },
      after: null,
    });
  });

  it('refuses a heading, a missing item, a stale version, a bad body and non-admins', async () => {
    const { contract, heading, ruled } = await draftWithLines();
    const body = { main: 'أ', expectedVersion: contract.version };
    const onHeading = await putGroup(contract.id, heading, body);
    expect(onHeading.status).toBe(400);
    expect(onHeading.body.details).toMatchObject({ reason: 'ITEM_IS_HEADING' });
    expect((await putGroup(contract.id, MISSING, body)).status).toBe(404);
    const stale = await putGroup(contract.id, ruled, {
      ...body,
      expectedVersion: contract.version - 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details.reason).toBe('STALE_VERSION');
    expect(
      (await putGroup(contract.id, ruled, { main: 'x'.repeat(81), expectedVersion: 1 })).status,
    ).toBe(400);
    expect(
      (await putGroup(contract.id, ruled, { main: null, sub: 'ب', expectedVersion: 1 })).status,
    ).toBe(400);
    expect((await putGroup(contract.id, ruled, body, pm)).status).toBe(403);
    const { rows } = await ctx.pool.query(
      'SELECT 1 FROM contract_item_group_choices WHERE contract_id = $1',
      [contract.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses approval while a line is ungrouped, approves after a manual group, then still allows changes', async () => {
    const { contract, unruled } = await draftWithLines();
    const refused = await asAdmin(http().post(`/admin/contracts/${contract.id}/approve`)).send({
      expectedVersion: contract.version,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({
      reason: 'CONTRACT_ITEMS_UNGROUPED',
      codes: ['1-2'],
    });

    const set = await putGroup(contract.id, unruled, {
      main: 'أ',
      expectedVersion: contract.version,
    });
    const version = ContractDetailSchema.parse(set.body).version;
    const approved = await asAdmin(http().post(`/admin/contracts/${contract.id}/approve`)).send({
      expectedVersion: version,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const after = await putGroup(contract.id, unruled, {
      main: 'ب',
      sub: 'ج',
      expectedVersion: approved.body.version,
    });
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(ContractDetailSchema.parse(after.body)).toMatchObject({
      status: 'approved',
      version: approved.body.version + 1,
    });
  });

  it('shows the groups on the lines of a work order', async () => {
    const contract = await createApprovedContract(ctx.pool, [
      { heading: '1' },
      { code: '1-1', description: 'end caps', quantity: '5' },
      { code: '1-2', description: 'zzz', quantity: '5' },
    ]);
    const projectId = await createProjectIn(ctx.pool, contract.contractId);
    // A PM of its own: assigning the seeded PM here would add a membership other suites count.
    const pmEmail = `pm-groups-${randomUUID().slice(0, 8)}@ftth.local`;
    const pmPassword = 'Pm#123456';
    await ensureMember(ctx.pool, { email: pmEmail, password: pmPassword, role: 'pm', projectId });
    const projectPm = await loginAs(ctx, pmEmail, pmPassword);
    const { workOrderId, itemIdsByCode } = await createWorkOrderFrom(
      ctx.pool,
      projectId,
      contract,
      {
        '1-1': '1',
        '1-2': '1',
      },
    );
    const read = async () => {
      const res = await http()
        .get(`/projects/${projectId}/work-orders/${workOrderId}`)
        .set('Authorization', `Bearer ${projectPm}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return WorkOrderDetailSchema.parse(res.body);
    };
    const groupOf = (order: Awaited<ReturnType<typeof read>>, id: string | undefined) =>
      order.items.find((i) => i.id === id)?.group;

    let order = await read();
    expect(groupOf(order, itemIdsByCode['1-1'])).toEqual({ main: 'طبات', sub: null });
    expect(groupOf(order, itemIdsByCode['1-2'])).toBeNull();

    // An admin choice on an approved contract reaches the work-order line.
    const version = (await asAdmin(http().get(`/admin/contracts/${contract.contractId}`))).body
      .version;
    const set = await putGroup(contract.contractId, contract.itemIds['1-2'] ?? '', {
      main: 'جديد',
      sub: 'فرعي',
      expectedVersion: version,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    order = await read();
    expect(groupOf(order, itemIdsByCode['1-2'])).toEqual({ main: 'جديد', sub: 'فرعي' });
  });
});

describe('contract_item_group_choices table', () => {
  async function seedChoice() {
    const contract = await createApprovedContract(
      ctx.pool,
      [{ code: 'X-1', description: 'zzz', quantity: '1' }],
      { approve: false },
    );
    const itemId = contract.itemIds['X-1'] ?? '';
    const choiceId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO contract_item_group_choices (id, contract_id, contract_item_id, main_group, sub_group)
       VALUES ($1, $2, $3, 'أ', 'ب')`,
      [choiceId, contract.contractId, itemId],
    );
    return { contract, itemId, choiceId };
  }
  const countOf = async (contractId: string) =>
    (
      await ctx.pool.query('SELECT 1 FROM contract_item_group_choices WHERE contract_id = $1', [
        contractId,
      ])
    ).rowCount;

  it('is append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
    const { contract, choiceId } = await seedChoice();
    await expect(
      ctx.pool.query(`UPDATE contract_item_group_choices SET main_group = 'ز' WHERE id = $1`, [
        choiceId,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      ctx.pool.query(`DELETE FROM contract_item_group_choices WHERE id = $1`, [choiceId]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(ctx.pool.query('TRUNCATE contract_item_group_choices')).rejects.toMatchObject({
      code: '23001',
    });
    expect(await countOf(contract.contractId)).toBe(1);
  });

  it('checks the shape: a sub group needs a main group, names are 1 to 80 characters', async () => {
    const { contract, itemId } = await seedChoice();
    const insert = (main: string | null, sub: string | null) =>
      ctx.pool.query(
        `INSERT INTO contract_item_group_choices (id, contract_id, contract_item_id, main_group, sub_group)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), contract.contractId, itemId, main, sub],
      );
    await expect(insert(null, 'ب')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('', null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('x'.repeat(81), null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('أ', 'y'.repeat(81))).rejects.toMatchObject({ code: '23514' });
    await expect(insert(null, null)).resolves.toBeDefined();
  });

  it('goes with its contract item when a draft line is removed, and with a deleted draft contract', async () => {
    const { contract, itemId } = await seedChoice();
    await ctx.pool.query(`DELETE FROM contract_items WHERE id = $1`, [itemId]);
    expect(await countOf(contract.contractId)).toBe(0);

    const other = await seedChoice();
    await ctx.pool.query(`DELETE FROM contracts WHERE id = $1`, [other.contract.contractId]);
    expect(await countOf(other.contract.contractId)).toBe(0);
  });

  it('goes with a draft line removed through the API', async () => {
    const { contract, unruled } = await draftWithLines();
    const set = await putGroup(contract.id, unruled, {
      main: 'أ',
      expectedVersion: contract.version,
    });
    const removed = await asAdmin(
      http().delete(`/admin/contracts/${contract.id}/items/${unruled}`),
    ).query({ expectedVersion: ContractDetailSchema.parse(set.body).version });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(await countOf(contract.id)).toBe(0);
  });
});
