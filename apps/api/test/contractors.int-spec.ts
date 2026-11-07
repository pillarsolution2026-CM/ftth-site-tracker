import { randomUUID } from 'node:crypto';
import {
  ContractorListResponseSchema,
  ContractorSchema,
  ProjectContractorsResponseSchema,
  type ProjectContractorsResponse,
} from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createApprovedContract,
  createProjectIn,
  createWorkOrderFrom,
} from './support/contract-fixtures.js';
import { ensureMember, loginAs, SEED_LOGINS } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

let ctx: TestContext;
let admin: string;
let pm: string;
let supervisor: string;
let qc: string;

const MISSING = '99999999-9999-4999-8999-999999999999';
const PASSWORD = 'Contractors#12345';
/** Dedicated users: the seeded ones must keep exactly one membership (other suites count them). */
const USERS = {
  pm: ['pm-contractors@ftth.local', 'pm'],
  supervisor: ['supervisor-contractors@ftth.local', 'supervisor'],
  qc: ['qc-contractors@ftth.local', 'qc'],
} as const;

const http = () => request(ctx.app.getHttpServer());
const as = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
const asAdmin = (req: request.Test) => as(admin)(req);
const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
  // The first world creates the users; every other world adds them as members.
  await world();
  pm = await loginAs(ctx, USERS.pm[0], PASSWORD);
  supervisor = await loginAs(ctx, USERS.supervisor[0], PASSWORD);
  qc = await loginAs(ctx, USERS.qc[0], PASSWORD);
});
afterAll(async () => {
  await ctx.close();
});

interface World {
  projectId: string;
  workOrderId: string;
  /** Work-order line id by contract code: A (100 at 10.5) and B (50 at 0.25). */
  lines: { A: string; B: string };
}

/** A project with an approved contract and a work order of the whole contract, with members. */
async function world(): Promise<World> {
  const contract = await createApprovedContract(ctx.pool, [
    { code: 'A', quantity: '100', unitPrice: '10.5', workType: 'civil' },
    { code: 'B', quantity: '50', unitPrice: '0.25', workType: 'installation' },
  ]);
  const projectId = await createProjectIn(ctx.pool, contract.contractId);
  const {
    rows: [zone],
  } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO zones (project_id, name) VALUES ($1, 'Zone') RETURNING id`,
    [projectId],
  );
  for (const [email, role] of Object.values(USERS)) {
    await ensureMember(ctx.pool, {
      email,
      password: PASSWORD,
      role,
      projectId,
      ...(role === 'supervisor' ? { zoneId: zone?.id ?? '' } : {}),
    });
  }
  const order = await createWorkOrderFrom(ctx.pool, projectId, contract, { A: '100', B: '50' });
  return {
    projectId,
    workOrderId: order.workOrderId,
    lines: { A: order.itemIdsByCode.A ?? '', B: order.itemIdsByCode.B ?? '' },
  };
}

async function newContractor(name = unique('Contractor')): Promise<string> {
  const res = await asAdmin(http().post('/admin/contractors')).send({
    name,
    contactName: 'Hassan',
    contactPhone: '+20 100 000 0000',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ContractorSchema.parse(res.body).id;
}

const adminUrl = (projectId: string, suffix = '') =>
  `/admin/projects/${projectId}/contractors${suffix}`;

interface Registered {
  registrationId: string;
  lineIds: { A?: string; B?: string };
  view: ProjectContractorsResponse;
}

async function register(
  w: World,
  contractorId: string,
  lines: { A?: [string, string]; B?: [string, string] },
  registeredOn = '2026-11-01',
): Promise<Registered> {
  const res = await asAdmin(http().post(adminUrl(w.projectId))).send({
    contractorId,
    registeredOn,
    lines: Object.entries(lines).map(([code, [quantity, unitPrice]]) => ({
      workOrderItemId: w.lines[code as 'A' | 'B'],
      quantity,
      unitPrice,
    })),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const view = ProjectContractorsResponseSchema.parse(res.body);
  const registration = view.registrations.find((r) => r.contractor.id === contractorId);
  const lineIds: Registered['lineIds'] = {};
  for (const line of registration?.lines ?? []) {
    lineIds[line.code as 'A' | 'B'] = line.id;
  }
  return { registrationId: registration?.id ?? '', lineIds, view };
}

const reasonOf = (res: request.Response): unknown => res.body.details?.reason;

describe('contractor list', () => {
  it('creates, lists, reads and updates a contractor under the optimistic version', async () => {
    const name = unique('Alpha');
    const created = await asAdmin(http().post('/admin/contractors')).send({
      name,
      contactName: 'Mona',
      contactPhone: '٠١٠٠ ١٢٣ ٤٥٦٧',
      commercialRegister: 'CR-77',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const contractor = ContractorSchema.parse(created.body);
    expect(contractor).toMatchObject({
      name,
      commercialRegister: 'CR-77',
      taxCard: null,
      workOrderCount: 0,
      version: 1,
    });

    const list = ContractorListResponseSchema.parse(
      (await asAdmin(http().get('/admin/contractors'))).body,
    );
    expect(list.items.find((c) => c.id === contractor.id)).toBeDefined();
    const one = await asAdmin(http().get(`/admin/contractors/${contractor.id}`));
    expect(ContractorSchema.parse(one.body).id).toBe(contractor.id);

    const patched = await asAdmin(http().patch(`/admin/contractors/${contractor.id}`)).send({
      expectedVersion: 1,
      contactName: 'Salma',
      taxCard: 'TC-5',
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(ContractorSchema.parse(patched.body)).toMatchObject({
      contactName: 'Salma',
      taxCard: 'TC-5',
      version: 2,
    });
    const stale = await asAdmin(http().patch(`/admin/contractors/${contractor.id}`)).send({
      expectedVersion: 1,
      contactName: 'Other',
    });
    expect(stale.status).toBe(409);
    expect(reasonOf(stale)).toBe('STALE_VERSION');

    const { rows } = await ctx.pool.query<{ type: string; project_id: string | null }>(
      `SELECT type, project_id FROM events WHERE entity = 'contractor' AND entity_id = $1 ORDER BY id`,
      [contractor.id],
    );
    expect(rows).toEqual([
      { type: 'contractor.created', project_id: null },
      { type: 'contractor.updated', project_id: null },
    ]);
  });

  it('refuses a name that is taken, ignoring case, on create and on rename', async () => {
    const name = unique('Taken');
    await newContractor(name);
    const again = await asAdmin(http().post('/admin/contractors')).send({
      name: `  ${name.toUpperCase()} `,
      contactName: 'X',
      contactPhone: '0100000',
    });
    expect(again.status).toBe(409);
    expect(reasonOf(again)).toBe('CONTRACTOR_NAME_TAKEN');

    const other = await newContractor();
    const rename = await asAdmin(http().patch(`/admin/contractors/${other}`)).send({
      expectedVersion: 1,
      name,
    });
    expect(rename.status).toBe(409);
    expect(reasonOf(rename)).toBe('CONTRACTOR_NAME_TAKEN');
  });

  it('validates the body and 404s an unknown contractor', async () => {
    const bad = await asAdmin(http().post('/admin/contractors')).send({
      name: 'No phone',
      contactName: 'X',
      contactPhone: 'abc',
    });
    expect(bad.status).toBe(400);
    expect((await asAdmin(http().get(`/admin/contractors/${MISSING}`))).status).toBe(404);
    expect(
      (
        await asAdmin(http().patch(`/admin/contractors/${MISSING}`)).send({
          expectedVersion: 1,
          name: 'Zed',
        })
      ).status,
    ).toBe(404);
  });
});

describe('contractors on a project', () => {
  it('registers with two lines and reads it as admin and as pm, with availability', async () => {
    const w = await world();
    const contractorId = await newContractor();
    const { registrationId, view } = await register(w, contractorId, {
      A: ['60', '10'],
      B: ['50', '0.25'],
    });

    for (const token of [admin, pm]) {
      const url = token === admin ? adminUrl(w.projectId) : `/projects/${w.projectId}/contractors`;
      const res = await as(token)(http().get(url));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const parsed = ProjectContractorsResponseSchema.parse(res.body);
      expect(parsed).toMatchObject({
        projectId: w.projectId,
        workOrderId: w.workOrderId,
        currency: 'EGP',
      });
      expect(parsed.registrations).toHaveLength(1);
      const registration = parsed.registrations[0];
      expect(registration).toMatchObject({
        id: registrationId,
        registeredOn: '2026-11-01',
        contractor: { id: contractorId },
      });
      expect(registration?.lines.map((l) => [l.code, l.quantity, l.contractPrice])).toEqual([
        ['A', '60', '10.5'],
        ['B', '50', '0.25'],
      ]);
      expect(registration?.lines[0]?.prices).toMatchObject([
        { effectiveFrom: '2026-11-01', unitPrice: '10' },
      ]);
      expect(
        parsed.availability.map((a) => [a.code, a.reservedQuantity, a.availableQuantity]),
      ).toEqual([
        ['A', '60', '40'],
        ['B', '50', '0'],
      ]);
      expect(parsed.availability.every((a) => a.assignable)).toBe(true);
    }
    expect(view.registrations).toHaveLength(1);

    const list = ContractorListResponseSchema.parse(
      (await asAdmin(http().get('/admin/contractors'))).body,
    );
    expect(list.items.find((c) => c.id === contractorId)?.workOrderCount).toBe(1);

    const { rows } = await ctx.pool.query<{ type: string; project_id: string | null }>(
      `SELECT type, project_id FROM events WHERE entity_id = $1 ORDER BY id`,
      [registrationId],
    );
    expect(rows).toEqual([{ type: 'contractor_registration.registered', project_id: w.projectId }]);
  });

  it('answers an empty view for a project without a work order and 409 NO_WORK_ORDER on register', async () => {
    const projectId = await createProjectIn(ctx.pool, null);
    const res = await asAdmin(http().get(adminUrl(projectId)));
    expect(ProjectContractorsResponseSchema.parse(res.body)).toMatchObject({
      workOrderId: null,
      registrations: [],
      availability: [],
    });
    const contractorId = await newContractor();
    const refused = await asAdmin(http().post(adminUrl(projectId))).send({
      contractorId,
      registeredOn: '2026-11-01',
      lines: [{ workOrderItemId: MISSING, quantity: '1', unitPrice: '1' }],
    });
    expect(refused.status).toBe(409);
    expect(reasonOf(refused)).toBe('NO_WORK_ORDER');
  });

  it('404s an unknown project and an unknown contractor', async () => {
    expect((await asAdmin(http().get(adminUrl(MISSING)))).status).toBe(404);
    const w = await world();
    const res = await asAdmin(http().post(adminUrl(w.projectId))).send({
      contractorId: MISSING,
      registeredOn: '2026-11-01',
      lines: [{ workOrderItemId: w.lines.A, quantity: '1', unitPrice: '1' }],
    });
    expect(res.status).toBe(404);
  });

  it('refuses to register the same contractor twice on a work order', async () => {
    const w = await world();
    const contractorId = await newContractor();
    await register(w, contractorId, { A: ['1', '1'] });
    const again = await asAdmin(http().post(adminUrl(w.projectId))).send({
      contractorId,
      registeredOn: '2026-11-02',
      lines: [{ workOrderItemId: w.lines.B, quantity: '1', unitPrice: '0.2' }],
    });
    expect(again.status).toBe(409);
    expect(reasonOf(again)).toBe('CONTRACTOR_ALREADY_REGISTERED');
  });

  it('refuses a line of another work order and a repeated line in the request', async () => {
    const w = await world();
    const other = await world();
    const contractorId = await newContractor();
    const elsewhere = await asAdmin(http().post(adminUrl(w.projectId))).send({
      contractorId,
      registeredOn: '2026-11-01',
      lines: [{ workOrderItemId: other.lines.A, quantity: '1', unitPrice: '1' }],
    });
    expect(elsewhere.status).toBe(409);
    expect(reasonOf(elsewhere)).toBe('LINE_NOT_IN_WORK_ORDER');
    const repeated = await asAdmin(http().post(adminUrl(w.projectId))).send({
      contractorId,
      registeredOn: '2026-11-01',
      lines: [
        { workOrderItemId: w.lines.A, quantity: '1', unitPrice: '1' },
        { workOrderItemId: w.lines.A, quantity: '2', unitPrice: '1' },
      ],
    });
    expect(repeated.status).toBe(400);
  });

  it('refuses a line saved before contracts (LEGACY_ITEM)', async () => {
    const w = await world();
    // A legacy line (ADR-016 data has no contract link): the trigger of migration 0008 refuses new
    // ones, so it is switched off for the insert only, as in the work-orders suite.
    const client = await ctx.pool.connect();
    let legacyId: string | undefined;
    try {
      await client.query('BEGIN');
      await client.query(
        'ALTER TABLE work_order_items DISABLE TRIGGER work_order_items_contract_check',
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO work_order_items (project_id, work_order_id, line_no, code, description, unit,
                                       quantity, unit_price, work_type)
         VALUES ($1, $2, 99, 'OLD', 'Old line', 'm', 5, 3, 'civil') RETURNING id`,
        [w.projectId, w.workOrderId],
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
    const legacy = { id: legacyId };
    const view = ProjectContractorsResponseSchema.parse(
      (await asAdmin(http().get(adminUrl(w.projectId)))).body,
    );
    expect(view.availability.find((a) => a.code === 'OLD')?.assignable).toBe(false);
    const contractorId = await newContractor();
    const res = await asAdmin(http().post(adminUrl(w.projectId))).send({
      contractorId,
      registeredOn: '2026-11-01',
      lines: [{ workOrderItemId: legacy?.id, quantity: '1', unitPrice: '1' }],
    });
    expect(res.status).toBe(409);
    expect(reasonOf(res)).toBe('LEGACY_ITEM');
  });

  it('caps a line across contractors: the exact remainder is accepted, one more is refused with the numbers', async () => {
    const w = await world();
    const first = await register(w, await newContractor(), { A: ['60.25', '10.5'] });
    const second = await newContractor();
    const refused = await asAdmin(http().post(adminUrl(w.projectId))).send({
      contractorId: second,
      registeredOn: '2026-11-01',
      lines: [{ workOrderItemId: w.lines.A, quantity: '39.7501', unitPrice: '10' }],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CONFLICT');
    expect(refused.body.details).toMatchObject({
      reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
      workOrderItemId: w.lines.A,
      code: 'A',
      workOrderQuantity: '100',
      reservedQuantity: '60.25',
      requestedQuantity: '39.7501',
      availableQuantity: '39.75',
    });
    const exact = await register(w, second, { A: ['39.75', '10'] });
    expect(exact.view.availability.find((a) => a.code === 'A')).toMatchObject({
      reservedQuantity: '100',
      availableQuantity: '0',
    });

    // Raising the first contractor's quantity now counts the second one's.
    const raise = await asAdmin(
      http().patch(adminUrl(w.projectId, `/${first.registrationId}/lines/${first.lineIds.A}`)),
    ).send({ quantity: '60.2501' });
    expect(raise.status).toBe(409);
    expect(raise.body.details).toMatchObject({
      reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
      reservedQuantity: '39.75',
      availableQuantity: '60.25',
    });
    // Lowering frees quantity for others.
    const lower = await asAdmin(
      http().patch(adminUrl(w.projectId, `/${first.registrationId}/lines/${first.lineIds.A}`)),
    ).send({ quantity: '50' });
    expect(lower.status, JSON.stringify(lower.body)).toBe(200);
    const view = ProjectContractorsResponseSchema.parse(lower.body);
    expect(view.availability.find((a) => a.code === 'A')?.availableQuantity).toBe('10.25');
  });

  it('adds, repeats and caps a line of an existing registration', async () => {
    const w = await world();
    const { registrationId } = await register(w, await newContractor(), { A: ['10', '10'] });
    const url = adminUrl(w.projectId, `/${registrationId}/lines`);
    const added = await asAdmin(http().post(url)).send({
      workOrderItemId: w.lines.B,
      quantity: '50',
      unitPrice: '0.25',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const view = ProjectContractorsResponseSchema.parse(added.body);
    expect(view.registrations[0]?.lines.map((l) => l.code)).toEqual(['A', 'B']);
    expect(view.registrations[0]?.lines[1]?.prices[0]?.effectiveFrom).toBe('2026-11-01');

    const repeated = await asAdmin(http().post(url)).send({
      workOrderItemId: w.lines.B,
      quantity: '1',
      unitPrice: '0.25',
    });
    expect(repeated.status).toBe(409);
    expect(reasonOf(repeated)).toBe('LINE_REPEATED');
  });

  it('refuses a price above the contract price, on register, on a new line and on a new price', async () => {
    const w = await world();
    const contractorId = await newContractor();
    const above = await asAdmin(http().post(adminUrl(w.projectId))).send({
      contractorId,
      registeredOn: '2026-11-01',
      lines: [{ workOrderItemId: w.lines.A, quantity: '1', unitPrice: '10.500001' }],
    });
    expect(above.status).toBe(409);
    expect(above.body.details).toMatchObject({
      reason: 'PRICE_EXCEEDS_CONTRACT',
      workOrderItemId: w.lines.A,
      code: 'A',
      contractPrice: '10.5',
      requestedPrice: '10.500001',
    });
    // The contract price itself is allowed.
    const { registrationId, lineIds } = await register(w, contractorId, { A: ['1', '10.5'] });

    const newLine = await asAdmin(
      http().post(adminUrl(w.projectId, `/${registrationId}/lines`)),
    ).send({
      workOrderItemId: w.lines.B,
      quantity: '1',
      unitPrice: '0.26',
    });
    expect(newLine.status).toBe(409);
    expect(reasonOf(newLine)).toBe('PRICE_EXCEEDS_CONTRACT');

    const price = await asAdmin(
      http().post(adminUrl(w.projectId, `/${registrationId}/lines/${lineIds.A}/prices`)),
    ).send({ effectiveFrom: '2026-12-01', unitPrice: '10.6' });
    expect(price.status).toBe(409);
    expect(price.body.details).toMatchObject({
      reason: 'PRICE_EXCEEDS_CONTRACT',
      contractPrice: '10.5',
      requestedPrice: '10.6',
    });
  });

  it('keeps a dated price history: the same or an earlier date is refused, a later one is added', async () => {
    const w = await world();
    const { registrationId, lineIds } = await register(w, await newContractor(), {
      A: ['10', '10'],
    });
    const url = adminUrl(w.projectId, `/${registrationId}/lines/${lineIds.A}/prices`);

    for (const effectiveFrom of ['2026-11-01', '2026-10-01']) {
      const refused = await asAdmin(http().post(url)).send({ effectiveFrom, unitPrice: '9' });
      expect(refused.status).toBe(409);
      expect(refused.body.details).toMatchObject({
        reason: 'PRICE_DATE_NOT_AFTER_LATEST',
        latestEffectiveFrom: '2026-11-01',
      });
    }
    const later = await asAdmin(http().post(url)).send({
      effectiveFrom: '2026-12-15',
      unitPrice: '9.5',
    });
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    const afterwards = await asAdmin(http().post(url)).send({
      effectiveFrom: '2026-12-15',
      unitPrice: '9',
    });
    expect(afterwards.status).toBe(409);
    expect(afterwards.body.details.latestEffectiveFrom).toBe('2026-12-15');

    const view = ProjectContractorsResponseSchema.parse(
      (await asAdmin(http().get(adminUrl(w.projectId)))).body,
    );
    expect(
      view.registrations[0]?.lines[0]?.prices.map((p) => [p.effectiveFrom, p.unitPrice]),
    ).toEqual([
      ['2026-11-01', '10'],
      ['2026-12-15', '9.5'],
    ]);

    const { rows } = await ctx.pool.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM events WHERE entity_id = $1 ORDER BY id`,
      [lineIds.A],
    );
    expect(rows.map((r) => r.type)).toEqual(['contractor_line.price_added']);
    expect(rows[0]?.payload).toMatchObject({
      effectiveFrom: '2026-12-15',
      unitPrice: '9.5',
      previous: { effectiveFrom: '2026-11-01', unitPrice: '10' },
    });
  });

  it('removes a line and a registration, writing a full snapshot event each time', async () => {
    const w = await world();
    const { registrationId, lineIds } = await register(w, await newContractor(), {
      A: ['10', '10'],
      B: ['5', '0.25'],
    });
    await asAdmin(
      http().post(adminUrl(w.projectId, `/${registrationId}/lines/${lineIds.A}/prices`)),
    ).send({ effectiveFrom: '2026-12-01', unitPrice: '9' });
    const removedLine = await asAdmin(
      http().delete(adminUrl(w.projectId, `/${registrationId}/lines/${lineIds.A}`)),
    );
    expect(removedLine.status, JSON.stringify(removedLine.body)).toBe(200);
    expect(
      ProjectContractorsResponseSchema.parse(removedLine.body).registrations[0]?.lines,
    ).toHaveLength(1);
    const lineEvent = await ctx.pool.query<{ payload: { prices: unknown[]; quantity: string } }>(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'contractor_line.removed'`,
      [lineIds.A],
    );
    expect(lineEvent.rows[0]?.payload).toMatchObject({ quantity: '10' });
    expect(lineEvent.rows[0]?.payload.prices).toHaveLength(2);

    // The item list is required: the last line goes only with the registration.
    const last = await asAdmin(
      http().delete(adminUrl(w.projectId, `/${registrationId}/lines/${lineIds.B}`)),
    );
    expect(last.status).toBe(409);
    expect(last.body.details).toMatchObject({ reason: 'LAST_LINE' });

    const removed = await asAdmin(http().delete(adminUrl(w.projectId, `/${registrationId}`)));
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(ProjectContractorsResponseSchema.parse(removed.body).registrations).toHaveLength(0);
    const event = await ctx.pool.query<{ project_id: string; payload: { lines: unknown[] } }>(
      `SELECT project_id, payload FROM events
       WHERE entity_id = $1 AND type = 'contractor_registration.removed'`,
      [registrationId],
    );
    expect(event.rows[0]?.project_id).toBe(w.projectId);
    expect(event.rows[0]?.payload.lines).toHaveLength(1);
    const left = await ctx.pool.query(`SELECT 1 FROM contractor_lines WHERE registration_id = $1`, [
      registrationId,
    ]);
    expect(left.rowCount).toBe(0);
  });
});

describe('access', () => {
  it('lets only platform admins write; pm, supervisor and qc get 403 on every admin route', async () => {
    const w = await world();
    const contractorId = await newContractor();
    const { registrationId, lineIds } = await register(w, contractorId, { A: ['1', '1'] });
    const routes: [string, string, object | undefined][] = [
      ['get', '/admin/contractors', undefined],
      ['post', '/admin/contractors', { name: 'X', contactName: 'X', contactPhone: '0100000' }],
      ['get', `/admin/contractors/${contractorId}`, undefined],
      ['patch', `/admin/contractors/${contractorId}`, { expectedVersion: 1, name: 'Y' }],
      ['get', adminUrl(w.projectId), undefined],
      [
        'post',
        adminUrl(w.projectId),
        {
          contractorId,
          registeredOn: '2026-11-01',
          lines: [{ workOrderItemId: w.lines.B, quantity: '1', unitPrice: '0.1' }],
        },
      ],
      ['delete', adminUrl(w.projectId, `/${registrationId}`), undefined],
      [
        'post',
        adminUrl(w.projectId, `/${registrationId}/lines`),
        { workOrderItemId: w.lines.B, quantity: '1', unitPrice: '0.1' },
      ],
      ['patch', adminUrl(w.projectId, `/${registrationId}/lines/${lineIds.A}`), { quantity: '2' }],
      ['delete', adminUrl(w.projectId, `/${registrationId}/lines/${lineIds.A}`), undefined],
      [
        'post',
        adminUrl(w.projectId, `/${registrationId}/lines/${lineIds.A}/prices`),
        { effectiveFrom: '2027-01-01', unitPrice: '1' },
      ],
    ];
    for (const token of [pm, supervisor, qc]) {
      for (const [method, url, body] of routes) {
        const req = http()[method as 'get'](url).set('Authorization', `Bearer ${token}`);
        const res = await (body ? req.send(body) : req);
        expect(res.status, `${method} ${url}`).toBe(403);
      }
    }
    for (const [method, url] of routes) {
      const res = await http()[method as 'get'](url);
      expect(res.status, `${method} ${url}`).toBe(401);
    }
    // Nothing changed.
    const view = ProjectContractorsResponseSchema.parse(
      (await asAdmin(http().get(adminUrl(w.projectId)))).body,
    );
    expect(view.registrations[0]?.lines).toHaveLength(1);
  });

  it('lets admin and pm read a project; supervisor and qc get 403; a non-member pm gets 403', async () => {
    const w = await world();
    await register(w, await newContractor(), { A: ['1', '1'] });
    const url = `/projects/${w.projectId}/contractors`;
    for (const token of [admin, pm]) {
      expect((await as(token)(http().get(url))).status).toBe(200);
    }
    for (const token of [supervisor, qc]) {
      const res = await as(token)(http().get(url));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    // A project the pm is not a member of.
    const outsiderProject = await createProjectIn(ctx.pool, null);
    expect((await as(pm)(http().get(`/projects/${outsiderProject}/contractors`))).status).toBe(403);
  });

  it('answers 404 for a registration or line reached through another project (no IDOR)', async () => {
    const w = await world();
    const other = await world();
    const { registrationId, lineIds } = await register(w, await newContractor(), {
      A: ['5', '10'],
    });
    const otherUrl = (suffix: string) => adminUrl(other.projectId, suffix);
    const attempts: [string, string, object | undefined][] = [
      ['delete', otherUrl(`/${registrationId}`), undefined],
      [
        'post',
        otherUrl(`/${registrationId}/lines`),
        { workOrderItemId: other.lines.B, quantity: '1', unitPrice: '0.1' },
      ],
      ['patch', otherUrl(`/${registrationId}/lines/${lineIds.A}`), { quantity: '2' }],
      ['delete', otherUrl(`/${registrationId}/lines/${lineIds.A}`), undefined],
      [
        'post',
        otherUrl(`/${registrationId}/lines/${lineIds.A}/prices`),
        { effectiveFrom: '2027-01-01', unitPrice: '1' },
      ],
      // The registration is right but the line belongs to nothing here.
      ['patch', adminUrl(w.projectId, `/${registrationId}/lines/${MISSING}`), { quantity: '2' }],
    ];
    for (const [method, url, body] of attempts) {
      const req = asAdmin(http()[method as 'get'](url));
      const res = await (body ? req.send(body) : req);
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    const view = ProjectContractorsResponseSchema.parse(
      (await asAdmin(http().get(adminUrl(w.projectId)))).body,
    );
    expect(view.registrations).toHaveLength(1);
    expect(view.registrations[0]?.lines[0]?.quantity).toBe('5');
  });
});

describe('work order protection', () => {
  const woUrl = (w: World, suffix = '') =>
    `/projects/${w.projectId}/work-orders/${w.workOrderId}${suffix}`;

  it('refuses a work-order quantity below what contractors hold, and accepts exactly that', async () => {
    const w = await world();
    const first = await register(w, await newContractor(), { A: ['40', '10'] });
    await register(w, await newContractor(), { A: ['20.5', '10'] });
    const patch = (quantity: string) =>
      as(pm)(http().patch(woUrl(w, `/items/${w.lines.A}`))).send({ quantity });

    const refused = await patch('60.4999');
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.details).toMatchObject({
      reason: 'QUANTITY_BELOW_CONTRACTORS',
      workOrderItemId: w.lines.A,
      code: 'A',
      contractorsQuantity: '60.5',
      requestedQuantity: '60.4999',
    });
    const exact = await patch('60.5');
    expect(exact.status, JSON.stringify(exact.body)).toBe(200);

    // The cap now follows the lowered quantity.
    const raise = await asAdmin(
      http().patch(adminUrl(w.projectId, `/${first.registrationId}/lines/${first.lineIds.A}`)),
    ).send({ quantity: '40.0001' });
    expect(raise.status).toBe(409);
    expect(raise.body.details).toMatchObject({
      reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
      workOrderQuantity: '60.5',
    });
  });

  it('refuses to remove a line given to a contractor and to delete the work order, until the registration goes', async () => {
    const w = await world();
    const { registrationId } = await register(w, await newContractor(), { A: ['10', '10'] });

    const line = await as(pm)(http().delete(woUrl(w, `/items/${w.lines.A}`)));
    expect(line.status).toBe(409);
    expect(reasonOf(line)).toBe('LINE_HAS_CONTRACTORS');
    const order = await as(pm)(http().delete(woUrl(w)));
    expect(order.status).toBe(409);
    expect(reasonOf(order)).toBe('WORK_ORDER_HAS_CONTRACTORS');

    // A line no contractor holds can still be removed.
    const free = await as(pm)(http().delete(woUrl(w, `/items/${w.lines.B}`)));
    expect(free.status, JSON.stringify(free.body)).toBe(204);

    const removed = await asAdmin(http().delete(adminUrl(w.projectId, `/${registrationId}`)));
    expect(removed.status).toBe(200);
    expect((await as(pm)(http().delete(woUrl(w, `/items/${w.lines.A}`)))).status).toBe(204);
    expect((await as(pm)(http().delete(woUrl(w)))).status).toBe(204);
  });
});

describe('database rules (migration 0013)', () => {
  it('refuses UPDATE and DELETE of a price while its line exists, and TRUNCATE', async () => {
    const w = await world();
    const { lineIds } = await register(w, await newContractor(), { A: ['10', '10'] });
    await expect(
      ctx.pool.query(
        `UPDATE contractor_line_prices SET unit_price = 1 WHERE contractor_line_id = $1`,
        [lineIds.A],
      ),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      ctx.pool.query(`DELETE FROM contractor_line_prices WHERE contractor_line_id = $1`, [
        lineIds.A,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(ctx.pool.query(`TRUNCATE contractor_line_prices`)).rejects.toMatchObject({
      code: '23001',
    });
    const { rows } = await ctx.pool.query(
      `SELECT unit_price FROM contractor_line_prices WHERE contractor_line_id = $1`,
      [lineIds.A],
    );
    expect(rows).toHaveLength(1);
  });

  it('fails a contractor line without a price at commit', async () => {
    const w = await world();
    const contractorId = await newContractor();
    const { registrationId } = await register(w, contractorId, { A: ['10', '10'] });
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO contractor_lines (project_id, registration_id, work_order_item_id, quantity)
         VALUES ($1, $2, $3, 5)`,
        [w.projectId, registrationId, w.lines.B],
      );
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('needs a price'),
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    const { rowCount } = await ctx.pool.query(
      `SELECT 1 FROM contractor_lines WHERE registration_id = $1 AND work_order_item_id = $2`,
      [registrationId, w.lines.B],
    );
    expect(rowCount).toBe(0);
  });

  it('enforces the quantity cap and the price ceiling below the application', async () => {
    const w = await world();
    const { lineIds } = await register(w, await newContractor(), { A: ['90', '10'] });
    const other = await newContractor();
    const {
      rows: [registration],
    } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO contractor_registrations (project_id, work_order_id, contractor_id, registered_on)
       VALUES ($1, $2, $3, '2026-11-01') RETURNING id`,
      [w.projectId, w.workOrderId, other],
    );
    await expect(
      ctx.pool.query(
        `INSERT INTO contractor_lines (project_id, registration_id, work_order_item_id, quantity)
         VALUES ($1, $2, $3, 10.0001)`,
        [w.projectId, registration?.id, w.lines.A],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      ctx.pool.query(
        `INSERT INTO contractor_line_prices (contractor_line_id, effective_from, unit_price)
         VALUES ($1, '2026-12-01', 10.500001)`,
        [lineIds.A],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      ctx.pool.query(
        `INSERT INTO contractor_line_prices (contractor_line_id, effective_from, unit_price)
         VALUES ($1, '2026-11-01', 9)`,
        [lineIds.A],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      ctx.pool.query(`UPDATE work_order_items SET quantity = 89.9999 WHERE id = $1`, [w.lines.A]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
