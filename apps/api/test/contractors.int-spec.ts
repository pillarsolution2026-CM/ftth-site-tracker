import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ContractorImportPreviewResponseSchema,
  ContractorListResponseSchema,
  ContractorSchema,
  ProjectContractorsResponseSchema,
  scopeKeyOf,
  type ProjectContractorsResponse,
} from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createApprovedContract,
  createProjectIn,
  createWorkOrderFrom,
} from './support/contract-fixtures.js';
import { buildXlsx } from '../src/modules/work-orders/testing/xlsx-builder.js';
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
  /** Work-order line id by contract code: A (100 at 10.5), B (50 at 0.25), BOX (225 at 2033.12). */
  lines: { A: string; B: string; BOX: string };
}

/** A project with an approved contract and a work order of the whole contract, with members. */
async function world(): Promise<World> {
  const contract = await createApprovedContract(ctx.pool, [
    { code: 'A', quantity: '100', unitPrice: '10.5', workType: 'civil' },
    { code: 'B', quantity: '50', unitPrice: '0.25', workType: 'installation' },
    {
      code: 'BOX',
      description: 'بوكس توزيع',
      unit: 'عدد',
      quantity: '225',
      unitPrice: '2033.12',
      workType: 'installation',
    },
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
  const order = await createWorkOrderFrom(ctx.pool, projectId, contract, {
    A: '100',
    B: '50',
    BOX: '225',
  });
  return {
    projectId,
    workOrderId: order.workOrderId,
    lines: {
      A: order.itemIdsByCode.A ?? '',
      B: order.itemIdsByCode.B ?? '',
      BOX: order.itemIdsByCode.BOX ?? '',
    },
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

/** Row of a contractor sheet: code, scope (null = whole line), quantity, price. */
type SheetRow = [
  code: 'A' | 'B' | 'BOX',
  scope: string | null,
  quantity: number | null,
  price: number | null,
];
const TEXT: Record<SheetRow[0], [string, string]> = {
  A: ['Test item A', 'م.ط'],
  B: ['Test item B', 'م.ط'],
  BOX: ['بوكس توزيع', 'عدد'],
};
const SCOPE_A = 'تركيب الخوصة';
const SCOPE_B = 'تركيب البوكس';
const SCOPE_C = 'لحام البوكس';

const sheetOf = (rows: SheetRow[]): Promise<Buffer> =>
  buildXlsx([
    {
      name: 'Sheet1',
      rows: [
        ['البند', 'الوصف', 'الوحدة', 'نطاق الشغل', 'الكمية', 'السعر'],
        ...rows.map(([code, scope, quantity, price]) => [
          code,
          TEXT[code][0],
          TEXT[code][1],
          scope,
          quantity,
          price,
        ]),
      ],
    },
  ]);

type Target =
  | { kind: 'new'; contractorId: string; registeredOn: string }
  | { kind: 'append'; registrationId: string };
const newTarget = (contractorId: string, registeredOn = '2026-11-01'): Target => ({
  kind: 'new',
  contractorId,
  registeredOn,
});

const importUrl = (projectId: string, suffix = '') => adminUrl(projectId, `/import${suffix}`);
const previewReq = (projectId: string, file: Buffer, target: Target, token = admin) =>
  http()
    .post(importUrl(projectId, '/preview'))
    .set('Authorization', `Bearer ${token}`)
    .field('payload', JSON.stringify({ target }))
    .attach('file', file, 'contractor.xlsx');
const commitPayload = (file: Buffer, target: Target, excluded: number[] = []) => ({
  fileSha256: createHash('sha256').update(file).digest('hex'),
  sheetName: 'Sheet1',
  headerRow: 1,
  mapping: {
    code: 0,
    description: 1,
    unit: 2,
    scope: 3,
    quantity: 4,
    unitPrice: 5,
    workType: null,
    amount: null,
  },
  excludedRowNumbers: excluded,
  target,
});
const commitReq = (projectId: string, file: Buffer, payload: object, token = admin) =>
  http()
    .post(importUrl(projectId))
    .set('Authorization', `Bearer ${token}`)
    .field('payload', JSON.stringify(payload))
    .attach('file', file, 'contractor.xlsx');

interface Registered {
  registrationId: string;
  /** Contractor line id by `code|scope` (scope as typed, empty for the whole line). */
  lineIds: Record<string, string>;
  view: ProjectContractorsResponse;
}

/** Uploads a sheet as a new registration (or appends) and expects 201. */
async function upload(w: World, target: Target, rows: SheetRow[]): Promise<Registered> {
  const file = await sheetOf(rows);
  const res = await commitReq(w.projectId, file, commitPayload(file, target));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const view = ProjectContractorsResponseSchema.parse(res.body);
  const registration = view.registrations.find((r) =>
    target.kind === 'new'
      ? r.contractor.id === target.contractorId
      : r.id === target.registrationId,
  );
  const lineIds: Registered['lineIds'] = {};
  for (const line of registration?.lines ?? [])
    lineIds[`${line.code}|${line.scope ?? ''}`] = line.id;
  return { registrationId: registration?.id ?? '', lineIds, view };
}

/** Uploads a sheet that must be refused with 422 ROW_ERRORS; returns the issues of each row. */
async function refusedRows(w: World, target: Target, rows: SheetRow[]) {
  const file = await sheetOf(rows);
  const res = await commitReq(w.projectId, file, commitPayload(file, target));
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body.code).toBe('IMPORT_INVALID');
  expect(res.body.details.reason).toBe('ROW_ERRORS');
  return res.body.details.rows as {
    rowNumber: number;
    issues: { code: string; params?: Record<string, unknown> }[];
  }[];
}

const reasonOf = (res: request.Response): unknown => res.body.details?.reason;

describe('uploading a contractor sheet', () => {
  it('previews, commits a new registration, stores the sheet, and reads as admin and pm', async () => {
    const w = await world();
    const contractorId = await newContractor();
    const target = newTarget(contractorId, '2026-11-03');
    const file = await sheetOf([
      ['BOX', SCOPE_A, 225, 300],
      ['BOX', SCOPE_B, 100, 900],
      ['A', null, 60, 10],
    ]);

    const shown = await previewReq(w.projectId, file, target);
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    const preview = ContractorImportPreviewResponseSchema.parse(shown.body);
    expect(preview.rows.map((r) => [r.kind, r.scope, r.issues.length])).toEqual([
      ['item', SCOPE_A, 0],
      ['item', SCOPE_B, 0],
      ['item', null, 0],
    ]);
    expect(preview.suggestedMapping).toMatchObject({ scope: 3, quantity: 4, unitPrice: 5 });
    const nothing = await ctx.pool.query(
      `SELECT 1 FROM contractor_registrations WHERE project_id = $1`,
      [w.projectId],
    );
    expect(nothing.rowCount).toBe(0);

    const res = await commitReq(w.projectId, file, commitPayload(file, target));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const view = ProjectContractorsResponseSchema.parse(res.body);
    const registration = view.registrations[0];
    expect(registration).toMatchObject({
      registeredOn: '2026-11-03',
      contractor: { id: contractorId },
    });
    expect(
      registration?.lines.map((l) => [
        l.code,
        l.scope,
        l.quantity,
        l.sourceRow,
        l.prices[0]?.effectiveFrom,
      ]),
    ).toEqual([
      ['A', null, '60', 4, '2026-11-03'],
      ['BOX', SCOPE_A, '225', 2, '2026-11-03'],
      ['BOX', SCOPE_B, '100', 3, '2026-11-03'],
    ]);

    // The sheet is stored, listed on the registration, and written once.
    expect(registration?.files).toHaveLength(1);
    const stored = await ctx.pool.query<{ storage_key: string; sha256: string }>(
      `SELECT storage_key, sha256 FROM contractor_import_files WHERE registration_id = $1`,
      [registration?.id],
    );
    expect(stored.rows[0]?.sha256).toBe(registration?.files[0]?.sha256);
    expect(stored.rows[0]?.sha256).toBe(createHash('sha256').update(file).digest('hex'));
    expect(await readFile(join(ctx.storageRoot, stored.rows[0]?.storage_key ?? ''))).toEqual(file);

    const box = view.availability.find((a) => a.code === 'BOX');
    expect(box).toMatchObject({ mode: 'scoped', scopesPriceTotal: '1200', priceRoom: '833.12' });
    expect(box?.scopes).toEqual([
      { scope: SCOPE_A, reservedQuantity: '225', availableQuantity: '0', highestPrice: '300' },
      { scope: SCOPE_B, reservedQuantity: '100', availableQuantity: '125', highestPrice: '900' },
    ]);
    expect(view.availability.find((a) => a.code === 'A')?.mode).toBe('whole');
    expect(view.availability.find((a) => a.code === 'B')?.mode).toBe('free');

    const asPm = await as(pm)(http().get(`/projects/${w.projectId}/contractors`));
    expect(ProjectContractorsResponseSchema.parse(asPm.body).registrations[0]?.files).toHaveLength(
      1,
    );
    const list = ContractorListResponseSchema.parse(
      (await asAdmin(http().get('/admin/contractors'))).body,
    );
    expect(list.items.find((c) => c.id === contractorId)?.workOrderCount).toBe(1);

    const events = await ctx.pool.query<{
      type: string;
      project_id: string | null;
      payload: Record<string, unknown>;
    }>(`SELECT type, project_id, payload FROM events WHERE entity_id = $1 ORDER BY id`, [
      registration?.id,
    ]);
    expect(events.rows.map((e) => [e.type, e.project_id])).toEqual([
      ['contractor_registration.registered', w.projectId],
    ]);
    expect(events.rows[0]?.payload).toMatchObject({
      fileSha256: createHash('sha256').update(file).digest('hex'),
      sheetName: 'Sheet1',
      rowCount: 3,
      lineCount: 3,
      excludedRowCount: 0,
    });
  });

  it('shows every kind of row issue in the preview and refuses the commit', async () => {
    const w = await world();
    const contractorId = await newContractor();
    const file = await buildXlsx([
      {
        name: 'Sheet1',
        rows: [
          ['البند', 'الوصف', 'الوحدة', 'نطاق الشغل', 'الكمية', 'السعر'],
          ['A', 'Test item A', 'م.ط', null, 101, 10],
          ['B', 'غير ذلك', 'كم', null, 1, 0.1],
          ['ZZ', 'x', 'y', null, 1, 1],
          ['B', 'Test item B', 'م.ط', null, null, 0.1],
          ['H', null, null, null, null, null],
        ],
      },
    ]);
    const shown = await previewReq(w.projectId, file, newTarget(contractorId));
    const rows = ContractorImportPreviewResponseSchema.parse(shown.body).rows;
    expect(rows.map((r) => [r.kind, r.issues.map((i) => i.code)])).toEqual([
      ['item', ['QUANTITY_EXCEEDS_WORK_ORDER']],
      ['item', ['WORK_ORDER_MISMATCH', 'WORK_ORDER_MISMATCH']],
      ['item', ['NOT_IN_WORK_ORDER']],
      ['skipped', ['EMPTY_QUANTITY_SKIPPED']],
      ['heading', []],
    ]);
    expect(rows[0]?.issues[0]?.params).toEqual({
      scope: '',
      workOrderQuantity: '100',
      reservedQuantity: '0',
      availableQuantity: '100',
    });
    expect(rows[1]?.issues[0]?.params).toEqual({ workOrderValue: 'Test item B' });

    const refused = await commitReq(
      w.projectId,
      file,
      commitPayload(file, newTarget(contractorId)),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.details.reason).toBe('ROW_ERRORS');
    expect(refused.body.details.rows.map((r: { rowNumber: number }) => r.rowNumber)).toEqual([
      2, 3, 4,
    ]);
    // Excluding the bad rows lets the clean remainder through (here: nothing left).
    const empty = await commitReq(
      w.projectId,
      file,
      commitPayload(file, newTarget(contractorId), [2, 3, 4]),
    );
    expect(empty.status).toBe(422);
    expect(empty.body.details.reason).toBe('NO_ROWS_INCLUDED');
  });

  it('refuses a changed file (FILE_CHANGED) and stores nothing', async () => {
    const w = await world();
    const contractorId = await newContractor();
    const file = await sheetOf([['A', null, 10, 10]]);
    const other = await sheetOf([['A', null, 11, 10]]);
    const res = await commitReq(w.projectId, other, commitPayload(file, newTarget(contractorId)));
    expect(res.status).toBe(422);
    expect(res.body.details.reason).toBe('FILE_CHANGED');
    const rows = await ctx.pool.query(
      `SELECT 1 FROM contractor_registrations WHERE project_id = $1`,
      [w.projectId],
    );
    expect(rows.rowCount).toBe(0);
    await expect(
      readdir(join(ctx.storageRoot, 'projects', w.projectId, 'contractors')),
    ).rejects.toThrow();
  });

  it('refuses a non-xlsx file with 415', async () => {
    const w = await world();
    const contractorId = await newContractor();
    const res = await http()
      .post(importUrl(w.projectId, '/preview'))
      .set('Authorization', `Bearer ${admin}`)
      .field('payload', JSON.stringify({ target: newTarget(contractorId) }))
      .attach('file', Buffer.from('a,b'), 'c.csv');
    expect(res.status).toBe(415);
  });

  it('answers 409 NO_WORK_ORDER, 404 unknown project and contractor, 409 when already registered', async () => {
    const contractorId = await newContractor();
    const file = await sheetOf([['A', null, 1, 1]]);
    const projectId = await createProjectIn(ctx.pool, null);
    const noOrder = await previewReq(projectId, file, newTarget(contractorId));
    expect(noOrder.status).toBe(409);
    expect(reasonOf(noOrder)).toBe('NO_WORK_ORDER');
    expect((await previewReq(MISSING, file, newTarget(contractorId))).status).toBe(404);

    const w = await world();
    expect((await previewReq(w.projectId, file, newTarget(MISSING))).status).toBe(404);
    await upload(w, newTarget(contractorId), [['A', null, 1, 1]]);
    for (const res of [
      await previewReq(w.projectId, file, newTarget(contractorId)),
      await commitReq(w.projectId, file, commitPayload(file, newTarget(contractorId))),
    ]) {
      expect(res.status).toBe(409);
      expect(reasonOf(res)).toBe('CONTRACTOR_ALREADY_REGISTERED');
    }
  });

  it('refuses a line saved before contracts (LEGACY_WORK_ORDER_LINE)', async () => {
    const w = await world();
    // A legacy line (ADR-016 data has no contract link): the trigger of migration 0008 refuses new
    // ones, so it is switched off for the insert only, as in the work-orders suite.
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'ALTER TABLE work_order_items DISABLE TRIGGER work_order_items_contract_check',
      );
      await client.query(
        `INSERT INTO work_order_items (project_id, work_order_id, line_no, code, description, unit,
                                       quantity, unit_price, work_type)
         VALUES ($1, $2, 99, 'OLD', 'Old line', 'm', 5, 3, 'civil')`,
        [w.projectId, w.workOrderId],
      );
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
    const view = ProjectContractorsResponseSchema.parse(
      (await asAdmin(http().get(adminUrl(w.projectId)))).body,
    );
    expect(view.availability.find((a) => a.code === 'OLD')?.assignable).toBe(false);
    const file = await buildXlsx([
      {
        name: 'Sheet1',
        rows: [
          ['البند', 'الوصف', 'الوحدة', 'نطاق الشغل', 'الكمية', 'السعر'],
          ['OLD', 'Old line', 'm', null, 1, 1],
        ],
      },
    ]);
    const shown = await previewReq(w.projectId, file, newTarget(await newContractor()));
    const rows = ContractorImportPreviewResponseSchema.parse(shown.body).rows;
    expect(rows[0]?.issues.map((i) => i.code)).toEqual(['LEGACY_WORK_ORDER_LINE']);
  });

  it('applies the owner example across contractors and sheets', async () => {
    const w = await world();
    const one = await upload(w, newTarget(await newContractor()), [
      ['BOX', SCOPE_A, 225, 300],
      ['BOX', SCOPE_B, 225, 900],
    ]);
    expect(one.view.availability.find((a) => a.code === 'BOX')?.priceRoom).toBe('833.12');
    await upload(w, newTarget(await newContractor()), [['BOX', SCOPE_C, 150, 500]]);
    const three = newTarget(await newContractor());

    const quantity = await refusedRows(w, three, [['BOX', 'لحام  البوكس', 76, 833.12]]);
    expect(quantity[0]?.issues).toMatchObject([
      {
        code: 'QUANTITY_EXCEEDS_WORK_ORDER',
        params: {
          scope: 'لحام  البوكس',
          workOrderQuantity: '225',
          reservedQuantity: '150',
          availableQuantity: '75',
        },
      },
    ]);
    const price = await refusedRows(w, three, [['BOX', 'لحام  البوكس', 75, 834]]);
    expect(price[0]?.issues).toMatchObject([
      {
        code: 'PRICE_EXCEEDS_CONTRACT',
        params: { contractPrice: '2033.12', otherScopesPrice: '1200', maxAllowedPrice: '833.12' },
      },
    ]);
    const whole = await refusedRows(w, three, [['BOX', null, 1, 1]]);
    expect(whole[0]?.issues.map((i) => i.code)).toContain('WHOLE_AND_SCOPES_MIXED');
    const repeated = await refusedRows(w, three, [
      ['BOX', SCOPE_C, 5, 1],
      ['BOX', 'لحام البوكس ', 5, 1],
    ]);
    expect(repeated.map((r) => r.issues.map((i) => i.code))).toEqual([
      expect.arrayContaining(['CODE_SCOPE_REPEATED']),
      expect.arrayContaining(['CODE_SCOPE_REPEATED']),
    ]);

    // Exactly the quantity and the price room left: accepted, the scope key ignores the spacing.
    const ok = await upload(w, three, [['BOX', 'لحام  البوكس', 75, 833.12]]);
    expect(ok.view.availability.find((a) => a.code === 'BOX')).toMatchObject({
      scopesPriceTotal: '2033.12',
      priceRoom: '0',
    });
    expect(
      ok.view.availability.find((a) => a.code === 'BOX')?.scopes.find((s) => s.scope === SCOPE_C),
    ).toMatchObject({ reservedQuantity: '225', availableQuantity: '0', highestPrice: '833.12' });
  });

  it('caps a whole line across contractors: the exact remainder is accepted, one more is refused', async () => {
    const w = await world();
    await upload(w, newTarget(await newContractor()), [['A', null, 60.25, 10.5]]);
    const second = newTarget(await newContractor());
    const refused = await refusedRows(w, second, [['A', null, 39.7501, 10]]);
    expect(refused[0]?.issues[0]).toMatchObject({
      code: 'QUANTITY_EXCEEDS_WORK_ORDER',
      params: { workOrderQuantity: '100', reservedQuantity: '60.25', availableQuantity: '39.75' },
    });
    const exact = await upload(w, second, [['A', null, 39.75, 10]]);
    expect(exact.view.availability.find((a) => a.code === 'A')?.scopes[0]).toMatchObject({
      reservedQuantity: '100',
      availableQuantity: '0',
    });
  });

  it('appends to a registration with one file per sheet; a repeated line and scope is refused', async () => {
    const w = await world();
    const first = await upload(w, newTarget(await newContractor(), '2026-11-05'), [
      ['BOX', SCOPE_A, 100, 300],
    ]);
    const append: Target = { kind: 'append', registrationId: first.registrationId };
    const second = await upload(w, append, [
      ['BOX', SCOPE_B, 50, 900],
      ['A', null, 5, 10],
    ]);
    const registration = second.view.registrations[0];
    expect(registration?.lines).toHaveLength(3);
    expect(registration?.files).toHaveLength(2);
    // Appended lines start on the registration date.
    expect(registration?.lines.every((l) => l.prices[0]?.effectiveFrom === '2026-11-05')).toBe(
      true,
    );

    const repeated = await refusedRows(w, append, [['BOX', 'تركيب  البوكس', 1, 900]]);
    expect(repeated[0]?.issues.map((i) => i.code)).toContain('LINE_ALREADY_ASSIGNED');

    const events = await ctx.pool.query<{ type: string }>(
      `SELECT type FROM events WHERE entity = 'contractor_line' AND type = 'contractor_line.added'
         AND payload->>'registrationId' = $1`,
      [first.registrationId],
    );
    expect(events.rowCount).toBe(2);
  });
});

describe('contractor line and price edits', () => {
  it('changes a quantity per scope, removes a line (never the last), removes a registration', async () => {
    const w = await world();
    const { registrationId, lineIds } = await upload(w, newTarget(await newContractor()), [
      ['BOX', SCOPE_A, 100, 300],
      ['BOX', SCOPE_B, 100, 900],
    ]);
    const url = (lineId: string) => adminUrl(w.projectId, `/${registrationId}/lines/${lineId}`);
    const lineA = lineIds[`BOX|${SCOPE_A}`] ?? '';
    const lineB = lineIds[`BOX|${SCOPE_B}`] ?? '';

    const tooMany = await asAdmin(http().patch(url(lineA))).send({ quantity: '225.0001' });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.details).toMatchObject({
      reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
      scope: SCOPE_A,
      reservedQuantity: '0',
      availableQuantity: '225',
    });
    // Scope B's 100 does not count against scope A: the whole 225 is available to it.
    const raised = await asAdmin(http().patch(url(lineA))).send({ quantity: '225' });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);

    const removed = await asAdmin(http().delete(url(lineB)));
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const last = await asAdmin(http().delete(url(lineA)));
    expect(last.status).toBe(409);
    expect(reasonOf(last)).toBe('LAST_LINE');
    const snapshot = await ctx.pool.query<{ payload: { scope: string; prices: unknown[] } }>(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'contractor_line.removed'`,
      [lineB],
    );
    expect(snapshot.rows[0]?.payload).toMatchObject({ scope: SCOPE_B });
    expect(snapshot.rows[0]?.payload.prices).toHaveLength(1);

    const gone = await asAdmin(http().delete(adminUrl(w.projectId, `/${registrationId}`)));
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(ProjectContractorsResponseSchema.parse(gone.body).registrations).toHaveLength(0);
    const event = await ctx.pool.query<{ payload: { lines: unknown[]; files: unknown[] } }>(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'contractor_registration.removed'`,
      [registrationId],
    );
    expect(event.rows[0]?.payload.lines).toHaveLength(1);
    expect(event.rows[0]?.payload.files).toHaveLength(1);
    const files = await ctx.pool.query(
      `SELECT 1 FROM contractor_import_files WHERE registration_id = $1`,
      [registrationId],
    );
    expect(files.rowCount).toBe(0);
  });

  it('keeps a dated price history and blocks a raise that the scopes sum cannot carry', async () => {
    const w = await world();
    const one = await upload(w, newTarget(await newContractor()), [
      ['BOX', SCOPE_A, 225, 300],
      ['BOX', SCOPE_B, 225, 900],
    ]);
    await upload(w, newTarget(await newContractor()), [['BOX', SCOPE_C, 150, 500]]);
    const url = adminUrl(
      w.projectId,
      `/${one.registrationId}/lines/${one.lineIds[`BOX|${SCOPE_A}`]}/prices`,
    );

    // Others: B 900 + C 500 = 1400, so scope A may reach 633.12.
    const blocked = await asAdmin(http().post(url)).send({
      effectiveFrom: '2026-12-01',
      unitPrice: '633.13',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toMatchObject({
      reason: 'PRICE_EXCEEDS_CONTRACT',
      scope: SCOPE_A,
      contractPrice: '2033.12',
      otherScopesPrice: '1400',
      maxAllowedPrice: '633.12',
      requestedPrice: '633.13',
    });
    const up = await asAdmin(http().post(url)).send({
      effectiveFrom: '2026-12-01',
      unitPrice: '633.12',
    });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    // A lower price is allowed; the scope still counts at the highest price ever recorded.
    const down = await asAdmin(http().post(url)).send({
      effectiveFrom: '2027-01-01',
      unitPrice: '100',
    });
    expect(down.status, JSON.stringify(down.body)).toBe(201);
    const view = ProjectContractorsResponseSchema.parse(down.body);
    const line = view.registrations.flatMap((r) => r.lines).find((l) => l.scope === SCOPE_A);
    expect(line?.prices.map((p) => [p.effectiveFrom, p.unitPrice])).toEqual([
      ['2026-11-01', '300'],
      ['2026-12-01', '633.12'],
      ['2027-01-01', '100'],
    ]);
    expect(view.availability.find((a) => a.code === 'BOX')).toMatchObject({
      scopesPriceTotal: '2033.12',
      priceRoom: '0',
    });

    for (const effectiveFrom of ['2027-01-01', '2026-10-01']) {
      const refused = await asAdmin(http().post(url)).send({ effectiveFrom, unitPrice: '50' });
      expect(refused.status).toBe(409);
      expect(refused.body.details).toMatchObject({
        reason: 'PRICE_DATE_NOT_AFTER_LATEST',
        latestEffectiveFrom: '2027-01-01',
      });
    }
    const events = await ctx.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM events WHERE type = 'contractor_line.price_added' AND entity_id = $1 ORDER BY id`,
      [one.lineIds[`BOX|${SCOPE_A}`]],
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0]?.payload).toMatchObject({
      scope: SCOPE_A,
      effectiveFrom: '2026-12-01',
      unitPrice: '633.12',
      previous: { effectiveFrom: '2026-11-01', unitPrice: '300' },
    });
  });
});

describe('access', () => {
  it('lets only platform admins write; pm, supervisor and qc get 403 on every admin route', async () => {
    const w = await world();
    const contractorId = await newContractor();
    const { registrationId, lineIds } = await upload(w, newTarget(contractorId), [
      ['A', null, 1, 1],
      ['B', null, 1, 0.1],
    ]);
    const lineA = lineIds['A|'] ?? '';
    const file = await sheetOf([['BOX', SCOPE_A, 1, 1]]);
    const routes: [string, string, object | undefined][] = [
      ['get', '/admin/contractors', undefined],
      ['post', '/admin/contractors', { name: 'X', contactName: 'X', contactPhone: '0100000' }],
      ['get', `/admin/contractors/${contractorId}`, undefined],
      ['patch', `/admin/contractors/${contractorId}`, { expectedVersion: 1, name: 'Y' }],
      ['get', adminUrl(w.projectId), undefined],
      ['delete', adminUrl(w.projectId, `/${registrationId}`), undefined],
      ['patch', adminUrl(w.projectId, `/${registrationId}/lines/${lineA}`), { quantity: '2' }],
      ['delete', adminUrl(w.projectId, `/${registrationId}/lines/${lineA}`), undefined],
      [
        'post',
        adminUrl(w.projectId, `/${registrationId}/lines/${lineA}/prices`),
        { effectiveFrom: '2027-01-01', unitPrice: '1' },
      ],
    ];
    for (const token of [pm, supervisor, qc]) {
      for (const [method, url, body] of routes) {
        const req = http()[method as 'get'](url).set('Authorization', `Bearer ${token}`);
        const res = await (body ? req.send(body) : req);
        expect(res.status, `${method} ${url}`).toBe(403);
      }
      const target: Target = { kind: 'append', registrationId };
      expect((await previewReq(w.projectId, file, target, token)).status).toBe(403);
      expect((await commitReq(w.projectId, file, commitPayload(file, target), token)).status).toBe(
        403,
      );
    }
    for (const [method, url] of routes) {
      expect((await http()[method as 'get'](url)).status, `${method} ${url}`).toBe(401);
    }
    const view = ProjectContractorsResponseSchema.parse(
      (await asAdmin(http().get(adminUrl(w.projectId)))).body,
    );
    expect(view.registrations[0]?.lines).toHaveLength(2);
  });

  it('removed the typed routes: registering and adding a line by JSON no longer exist', async () => {
    const w = await world();
    const contractorId = await newContractor();
    const { registrationId } = await upload(w, newTarget(contractorId), [['A', null, 1, 1]]);
    const post = await asAdmin(http().post(adminUrl(w.projectId))).send({});
    expect(post.status).toBe(404);
    const line = await asAdmin(http().post(adminUrl(w.projectId, `/${registrationId}/lines`))).send(
      {},
    );
    expect(line.status).toBe(404);
  });

  it('lets admin and pm read a project; supervisor and qc get 403; a non-member pm gets 403', async () => {
    const w = await world();
    await upload(w, newTarget(await newContractor()), [['A', null, 1, 1]]);
    const url = `/projects/${w.projectId}/contractors`;
    for (const token of [admin, pm]) {
      expect((await as(token)(http().get(url))).status).toBe(200);
    }
    for (const token of [supervisor, qc]) {
      const res = await as(token)(http().get(url));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    const outsiderProject = await createProjectIn(ctx.pool, null);
    expect((await as(pm)(http().get(`/projects/${outsiderProject}/contractors`))).status).toBe(403);
  });

  it('answers 404 for a registration or line reached through another project (no IDOR)', async () => {
    const w = await world();
    const other = await world();
    const { registrationId, lineIds } = await upload(w, newTarget(await newContractor()), [
      ['A', null, 5, 10],
    ]);
    const lineA = lineIds['A|'] ?? '';
    const otherUrl = (suffix: string) => adminUrl(other.projectId, suffix);
    const attempts: [string, string, object | undefined][] = [
      ['delete', otherUrl(`/${registrationId}`), undefined],
      ['patch', otherUrl(`/${registrationId}/lines/${lineA}`), { quantity: '2' }],
      ['delete', otherUrl(`/${registrationId}/lines/${lineA}`), undefined],
      [
        'post',
        otherUrl(`/${registrationId}/lines/${lineA}/prices`),
        { effectiveFrom: '2027-01-01', unitPrice: '1' },
      ],
      ['patch', adminUrl(w.projectId, `/${registrationId}/lines/${MISSING}`), { quantity: '2' }],
    ];
    for (const [method, url, body] of attempts) {
      const req = asAdmin(http()[method as 'get'](url));
      const res = await (body ? req.send(body) : req);
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    // An append from another project's endpoint finds no registration either.
    const file = await sheetOf([['B', null, 1, 0.1]]);
    const target: Target = { kind: 'append', registrationId };
    expect((await previewReq(other.projectId, file, target)).status).toBe(404);
    expect((await commitReq(other.projectId, file, commitPayload(file, target))).status).toBe(404);
    const view = ProjectContractorsResponseSchema.parse(
      (await asAdmin(http().get(adminUrl(w.projectId)))).body,
    );
    expect(view.registrations[0]?.lines[0]?.quantity).toBe('5');
  });
});

describe('work order protection', () => {
  const woUrl = (w: World, suffix = '') =>
    `/projects/${w.projectId}/work-orders/${w.workOrderId}${suffix}`;

  it('refuses a work-order quantity below the largest scope sum, and accepts exactly that', async () => {
    const w = await world();
    // Scope A holds 225 over two contractors (150 + 75), scope B 100: the largest sum is 225.
    await upload(w, newTarget(await newContractor()), [
      ['BOX', SCOPE_A, 150, 300],
      ['BOX', SCOPE_B, 100, 900],
    ]);
    await upload(w, newTarget(await newContractor()), [['BOX', SCOPE_A, 75, 300]]);
    const patch = (quantity: string) =>
      as(pm)(http().patch(woUrl(w, `/items/${w.lines.BOX}`))).send({ quantity });

    const refused = await patch('224.9999');
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.details).toMatchObject({
      reason: 'QUANTITY_BELOW_CONTRACTORS',
      workOrderItemId: w.lines.BOX,
      code: 'BOX',
      contractorsQuantity: '225',
      requestedQuantity: '224.9999',
    });
    const exact = await patch('225');
    expect(exact.status, JSON.stringify(exact.body)).toBe(200);
  });

  it('refuses to remove a line given to a contractor and to delete the work order, until the registration goes', async () => {
    const w = await world();
    const { registrationId } = await upload(w, newTarget(await newContractor()), [
      ['A', null, 10, 10],
    ]);
    const line = await as(pm)(http().delete(woUrl(w, `/items/${w.lines.A}`)));
    expect(line.status).toBe(409);
    expect(reasonOf(line)).toBe('LINE_HAS_CONTRACTORS');
    const order = await as(pm)(http().delete(woUrl(w)));
    expect(order.status).toBe(409);
    expect(reasonOf(order)).toBe('WORK_ORDER_HAS_CONTRACTORS');

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
    const { lineIds } = await upload(w, newTarget(await newContractor()), [['A', null, 10, 10]]);
    await expect(
      ctx.pool.query(
        `UPDATE contractor_line_prices SET unit_price = 1 WHERE contractor_line_id = $1`,
        [lineIds['A|']],
      ),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      ctx.pool.query(`DELETE FROM contractor_line_prices WHERE contractor_line_id = $1`, [
        lineIds['A|'],
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(ctx.pool.query(`TRUNCATE contractor_line_prices`)).rejects.toMatchObject({
      code: '23001',
    });
  });

  it('fails a contractor line without a price at commit', async () => {
    const w = await world();
    const { registrationId } = await upload(w, newTarget(await newContractor()), [
      ['A', null, 10, 10],
    ]);
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

  it('enforces quantity, scopes and prices below the application', async () => {
    const w = await world();
    await upload(w, newTarget(await newContractor()), [
      ['A', null, 90, 10],
      ['BOX', SCOPE_A, 100, 1000],
      ['BOX', SCOPE_B, 100, 1000],
    ]);
    const other = await newContractor();
    const {
      rows: [registration],
    } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO contractor_registrations (project_id, work_order_id, contractor_id, registered_on)
       VALUES ($1, $2, $3, '2026-11-01') RETURNING id`,
      [w.projectId, w.workOrderId, other],
    );
    const insertLine = (item: string, quantity: string, scope: string | null) =>
      ctx.pool.query(
        `INSERT INTO contractor_lines (project_id, registration_id, work_order_item_id, scope, scope_key, quantity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [w.projectId, registration?.id, item, scope, scopeKeyOf(scope), quantity],
      );
    // Quantity per whole line.
    await expect(insertLine(w.lines.A, '10.0001', null)).rejects.toMatchObject({ code: '23514' });
    // Whole and scoped never mix.
    await expect(insertLine(w.lines.A, '1', 'نطاق')).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('whole and scoped'),
    });
    await expect(insertLine(w.lines.BOX, '1', null)).rejects.toMatchObject({ code: '23514' });
    // Quantity per scope: scope A holds 100 of 225.
    await expect(insertLine(w.lines.BOX, '125.0001', SCOPE_A)).rejects.toMatchObject({
      code: '23514',
    });

    // Price sum: scopes A and B at 1000 each; a third scope may cost 33.12 at most.
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO contractor_lines (project_id, registration_id, work_order_item_id, scope, scope_key, quantity)
         VALUES ($1, $2, $3, 'ثالث', 'ثالث', 1) RETURNING id`,
        [w.projectId, registration?.id, w.lines.BOX],
      );
      await expect(
        client.query(
          `INSERT INTO contractor_line_prices (contractor_line_id, effective_from, unit_price)
           VALUES ($1, '2026-11-01', 33.13)`,
          [inserted.rows[0]?.id],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('other scopes'),
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    // The work-order line never drops below the largest scope sum.
    await expect(
      ctx.pool.query(`UPDATE work_order_items SET quantity = 89.9999 WHERE id = $1`, [w.lines.A]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      ctx.pool.query(`UPDATE work_order_items SET quantity = 99.9999 WHERE id = $1`, [w.lines.BOX]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
