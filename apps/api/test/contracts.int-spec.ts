import { createHash, randomUUID } from 'node:crypto';
import {
  ContractAttachmentSchema,
  ContractDetailSchema,
  ContractImportPreviewResponseSchema,
  ContractListResponseSchema,
  type ContractDetail,
} from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildOwnerBoqXlsx } from '../src/modules/work-orders/testing/owner-boq-sheet.js';
import { buildXlsx, ENGLISH_HEADER } from '../src/modules/work-orders/testing/xlsx-builder.js';
import { ensureMember, eventTypes, loginAs, SEED_LOGINS } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

let ctx: TestContext;
let admin: string;
let pm: string;
let supervisor: string;
let qc: string;
let ownerBoq: Buffer;

const MISSING = '99999999-9999-4999-8999-999999999999';
const http = () => request(ctx.app.getHttpServer());
const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer ${admin}`);
const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

const OWNER_MAPPING = {
  code: 0,
  workType: 1,
  description: 2,
  unit: 3,
  quantity: 4,
  unitPrice: 5,
  amount: 6,
};

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'), { MAX_UPLOAD_MB: '1' });
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
  pm = await loginAs(ctx, ...SEED_LOGINS.pm);
  supervisor = await loginAs(ctx, ...SEED_LOGINS.supervisor);
  ownerBoq = await buildOwnerBoqXlsx();
});
afterAll(async () => {
  await ctx.close();
});

async function createContract(overrides: Record<string, unknown> = {}): Promise<ContractDetail> {
  const res = await asAdmin(http().post('/admin/contracts')).send({
    number: unique('C'),
    name: 'عقد الشبكة',
    client: 'العميل',
    currency: 'EGP',
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ContractDetailSchema.parse(res.body);
}

const priced = (code: string, quantity = '2', unitPrice = '10.5') => ({
  kind: 'item',
  code,
  description: `بند ${code}`,
  unit: 'م.ط',
  quantity,
  unitPrice,
  workType: 'civil',
});

async function addItem(
  contract: ContractDetail,
  item: object,
  extra: Record<string, unknown> = {},
): Promise<ContractDetail> {
  const res = await asAdmin(http().post(`/admin/contracts/${contract.id}/items`)).send({
    item,
    expectedVersion: contract.version,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ContractDetailSchema.parse(res.body);
}

const getContract = async (id: string) =>
  ContractDetailSchema.parse((await asAdmin(http().get(`/admin/contracts/${id}`))).body);

const importPreview = (id: string, file: Buffer, payload: object = {}, token = admin) =>
  http()
    .post(`/admin/contracts/${id}/import/preview`)
    .set('Authorization', `Bearer ${token}`)
    .field('payload', JSON.stringify(payload))
    .attach('file', file, 'boq.xlsx');

const importCommit = (id: string, file: Buffer, payload: object) =>
  http()
    .post(`/admin/contracts/${id}/import`)
    .set('Authorization', `Bearer ${admin}`)
    .field('payload', JSON.stringify(payload))
    .attach('file', file, 'boq.xlsx');

const commitPayload = (file: Buffer, version: number, overrides: object = {}) => ({
  fileSha256: createHash('sha256').update(file).digest('hex'),
  sheetName: 'BOQ',
  headerRow: 3,
  mapping: OWNER_MAPPING,
  excludedRowNumbers: [],
  acceptedDuplicateCodes: [],
  expectedVersion: version,
  ...overrides,
});

describe('contract header', () => {
  it('creates an empty draft, lists it and records a project-less event', async () => {
    const contract = await createContract({
      startsOn: '2026-11-01',
      durationDays: 365,
      notes: 'ملاحظات',
    });
    expect(contract).toMatchObject({
      status: 'draft',
      version: 1,
      currency: 'EGP',
      itemCount: 0,
      total: '0',
      projectCount: 0,
      startsOn: '2026-11-01',
      durationDays: 365,
      items: [],
      attachments: [],
      duplicateCodes: [],
    });
    expect(await eventTypes(ctx.pool, contract.id)).toEqual(['contract.created']);
    const { rows } = await ctx.pool.query(
      `SELECT project_id, entity FROM events WHERE entity_id = $1`,
      [contract.id],
    );
    expect(rows).toEqual([{ project_id: null, entity: 'contract' }]);

    const list = ContractListResponseSchema.parse(
      (await asAdmin(http().get('/admin/contracts'))).body,
    );
    expect(list.items.find((c) => c.id === contract.id)).toMatchObject({ number: contract.number });
  });

  it('validates the body, refuses a duplicate number and answers 404 for an unknown id', async () => {
    const first = await createContract();
    const dup = await asAdmin(http().post('/admin/contracts')).send({
      number: first.number,
      name: 'x',
      client: 'x',
      currency: 'EGP',
    });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'CONFLICT', details: { reason: 'DUPLICATE_NUMBER' } });

    for (const body of [
      { number: unique('C'), name: 'x', client: 'x', currency: 'egp' },
      { number: unique('C'), name: 'x', client: 'x' },
      { number: unique('C'), name: '  ', client: 'x', currency: 'EGP' },
      { number: unique('C'), name: 'x', client: 'x', currency: 'EGP', status: 'approved' },
    ]) {
      expect((await asAdmin(http().post('/admin/contracts')).send(body)).status).toBe(400);
    }
    expect((await asAdmin(http().get(`/admin/contracts/${MISSING}`))).status).toBe(404);
    expect((await asAdmin(http().get('/admin/contracts/not-a-uuid'))).status).toBe(400);
  });

  it('edits the header with a before/after event, 409 on a stale version or taken number, never the currency', async () => {
    const contract = await createContract();
    const other = await createContract();
    const patch = (body: object) =>
      asAdmin(http().patch(`/admin/contracts/${contract.id}`)).send(body);

    const ok = await patch({ expectedVersion: 1, name: 'اسم جديد', durationDays: 30 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: 'اسم جديد', durationDays: 30, version: 2 });
    const event = await ctx.pool.query(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'contract.updated'`,
      [contract.id],
    );
    expect(event.rows[0].payload).toMatchObject({
      before: { name: 'عقد الشبكة', durationDays: null },
      after: { name: 'اسم جديد', durationDays: 30 },
      version: 2,
    });

    const stale = await patch({ expectedVersion: 1, name: 'x' });
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({ reason: 'STALE_VERSION', currentVersion: 2 });

    const taken = await patch({ expectedVersion: 2, number: other.number });
    expect(taken.status).toBe(409);
    expect(taken.body.details).toMatchObject({ reason: 'DUPLICATE_NUMBER' });

    for (const body of [
      { expectedVersion: 2, currency: 'USD' },
      { expectedVersion: 2 },
      { name: 'x' },
    ]) {
      expect((await patch(body)).status).toBe(400);
    }
    const { rows } = await ctx.pool.query('SELECT currency FROM contracts WHERE id = $1', [
      contract.id,
    ]);
    expect(rows[0].currency.trim()).toBe('EGP');
  });
});

describe('BOQ lines', () => {
  it('adds items and headings, derives the parent by code and totals items only', async () => {
    let contract = await createContract();
    contract = await addItem(contract, { kind: 'heading', code: '2', description: 'تركيبات' });
    contract = await addItem(contract, priced('2-9-1', '10', '2'));
    contract = await addItem(contract, priced('2-9-1-1', '5', '3.000001'));
    contract = await addItem(contract, { kind: 'heading', code: '2-12' });

    expect(contract).toMatchObject({ itemCount: 2, total: '35.000005', version: 5 });
    expect(contract.items.map((i) => [i.lineNo, i.kind, i.code, i.parentCode])).toEqual([
      [1, 'heading', '2', null],
      [2, 'item', '2-9-1', '2'],
      [3, 'item', '2-9-1-1', '2-9-1'],
      [4, 'heading', '2-12', '2'],
    ]);
    expect(contract.items[2]).toMatchObject({
      quantity: '5',
      unitPrice: '3.000001',
      amount: '15.000005',
      workType: 'civil',
      source: 'manual',
    });
    expect(contract.items[3]).toMatchObject({
      description: null,
      unit: null,
      quantity: null,
      amount: null,
    });
    expect(await eventTypes(ctx.pool, contract.items[1]?.id ?? '')).toEqual([
      'contract_item.added',
    ]);
  });

  it('accepts zero quantity and price', async () => {
    const contract = await addItem(await createContract(), priced('Z', '0', '0'));
    expect(contract.items[0]).toMatchObject({ quantity: '0', unitPrice: '0', amount: '0' });
    expect(contract.itemCount).toBe(1);
  });

  it('refuses a duplicate code unless accepted, and a line number that is taken', async () => {
    let contract = await addItem(await createContract(), priced('A'));
    const res = await asAdmin(http().post(`/admin/contracts/${contract.id}/items`)).send({
      item: priced('A'),
      expectedVersion: contract.version,
    });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'DUPLICATE_CODE', codes: ['A'] });

    contract = await addItem(contract, priced('A'), { acceptDuplicateCode: true });
    expect(contract.duplicateCodes).toEqual([{ code: 'A', lineNos: [1, 2] }]);

    const taken = await asAdmin(http().post(`/admin/contracts/${contract.id}/items`)).send({
      item: priced('B'),
      lineNo: 2,
      expectedVersion: contract.version,
    });
    expect(taken.status).toBe(409);
    expect(taken.body.details).toMatchObject({ reason: 'LINE_TAKEN' });
  });

  it('updates a line (also its kind) and removes one, with versions and events', async () => {
    let contract = await addItem(await createContract(), priced('A', '2', '5'));
    const id = contract.items[0]?.id ?? '';

    const updated = await asAdmin(http().patch(`/admin/contracts/${contract.id}/items/${id}`)).send(
      {
        item: priced('A', '4', '5'),
        expectedVersion: contract.version,
      },
    );
    expect(updated.status).toBe(200);
    contract = ContractDetailSchema.parse(updated.body);
    expect(contract).toMatchObject({ total: '20', version: 3 });

    const stale = await asAdmin(http().patch(`/admin/contracts/${contract.id}/items/${id}`)).send({
      item: { kind: 'heading', code: 'A' },
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details.reason).toBe('STALE_VERSION');

    const asHeading = await asAdmin(
      http().patch(`/admin/contracts/${contract.id}/items/${id}`),
    ).send({ item: { kind: 'heading', code: 'A', description: 'قسم' }, expectedVersion: 3 });
    expect(asHeading.body).toMatchObject({ itemCount: 0, total: '0' });

    const missing = await asAdmin(
      http().patch(`/admin/contracts/${contract.id}/items/${MISSING}`),
    ).send({ item: priced('Q'), expectedVersion: 4 });
    expect(missing.status).toBe(404);

    const removed = await asAdmin(
      http().delete(`/admin/contracts/${contract.id}/items/${id}?expectedVersion=4`),
    );
    expect(removed.status).toBe(200);
    expect(removed.body.items).toEqual([]);
    expect(await eventTypes(ctx.pool, id)).toEqual([
      'contract_item.added',
      'contract_item.updated',
      'contract_item.updated',
      'contract_item.removed',
    ]);
    const noVersion = await asAdmin(http().delete(`/admin/contracts/${contract.id}/items/${id}`));
    expect(noVersion.status).toBe(400);
  });
});

describe('BOQ import', () => {
  it('previews the owner-style sheet with headings, zero items and unit variants', async () => {
    const contract = await createContract();
    const res = await importPreview(contract.id, ownerBoq);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const preview = ContractImportPreviewResponseSchema.parse(res.body);
    expect(preview.headerRow).toBe(3);
    expect(preview.mapping).toEqual(OWNER_MAPPING);
    expect(preview.summary).toMatchObject({
      rowCount: 10,
      headingCount: 4,
      errorRowCount: 0,
      warningRowCount: 2,
      total: '1335',
    });
    const variants = preview.rows.filter((row) =>
      row.issues.some((issue) => issue.code === 'UNIT_FORM_VARIANT'),
    );
    expect(variants.map((row) => row.rowNumber)).toEqual([12, 13]);
  });

  it('commits the sheet, replacing every line, and keeps the xlsx as import source', async () => {
    let contract = await createContract();
    contract = await addItem(contract, priced('OLD'));

    const res = await importCommit(contract.id, ownerBoq, commitPayload(ownerBoq, 2));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const imported = ContractDetailSchema.parse(res.body);
    expect(imported).toMatchObject({ itemCount: 6, total: '1335', version: 3 });
    expect(imported.items).toHaveLength(10);
    expect(imported.items.find((i) => i.code === 'OLD')).toBeUndefined();
    expect(imported.items.map((i) => i.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(imported.items.filter((i) => i.kind === 'heading').map((i) => i.code)).toEqual([
      '1',
      '1-2',
      '2',
      '2-12',
    ]);
    expect(imported.items.find((i) => i.code === '2-9-1-1')).toMatchObject({
      parentCode: '2-9-1',
      source: 'import',
      sourceRow: 10,
    });
    expect(imported.items.find((i) => i.code === '2-12')).toMatchObject({ description: null });
    expect(imported.items.find((i) => i.code === '4-2-5')?.unit).toBe(
      'BULDING\n(1 to 8 unit/flat per building)',
    );
    expect(imported.attachments).toHaveLength(1);
    expect(imported.attachments[0]).toMatchObject({ kind: 'import_source' });
    expect(await eventTypes(ctx.pool, contract.id)).toEqual([
      'contract.created',
      'contract.imported',
    ]);
    const { rows } = await ctx.pool.query(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'contract.imported'`,
      [contract.id],
    );
    expect(rows[0].payload).toMatchObject({ itemCount: 6, headingCount: 4, total: '1335' });
  });

  it('refuses IMPORT_INVALID reasons and 409 on stale versions without changing the BOQ', async () => {
    let contract = await createContract();
    contract = await addItem(contract, priced('KEEP'));

    const stale = await importCommit(contract.id, ownerBoq, commitPayload(ownerBoq, 1));
    expect(stale.status).toBe(409);
    expect(stale.body.details.reason).toBe('STALE_VERSION');

    const changed = await importCommit(
      contract.id,
      ownerBoq,
      commitPayload(ownerBoq, 2, { fileSha256: 'a'.repeat(64) }),
    );
    expect(changed.status).toBe(422);
    expect(changed.body).toMatchObject({
      code: 'IMPORT_INVALID',
      details: { reason: 'FILE_CHANGED' },
    });

    const bad = await buildXlsx([
      {
        name: 'BOQ',
        rows: [
          ENGLISH_HEADER.concat('Work'),
          ['A', 'd', 'u', 'abc', 2, 4, 'مدني'],
          ['B', 'd', 'u', 1, 2, 2, 'مدني'],
          ['B', 'd', 'u', 1, 2, 2, 'مدني'],
        ],
      },
    ]);
    const mapping = {
      code: 0,
      description: 1,
      unit: 2,
      quantity: 3,
      unitPrice: 4,
      amount: 5,
      workType: 6,
    };
    const base = commitPayload(bad, 2, { headerRow: 1, mapping });
    const errors = await importCommit(contract.id, bad, base);
    expect(errors.status).toBe(422);
    expect(errors.body.details.reason).toBe('ROW_ERRORS');

    const dups = await importCommit(contract.id, bad, { ...base, excludedRowNumbers: [2] });
    expect(dups.status).toBe(422);
    expect(dups.body.details).toMatchObject({
      reason: 'UNRESOLVED_DUPLICATES',
      duplicateCodes: ['B'],
    });

    const none = await importCommit(contract.id, bad, {
      ...base,
      excludedRowNumbers: [2, 3, 4],
    });
    expect(none.body.details.reason).toBe('NO_ROWS_INCLUDED');

    const accepted = await importCommit(contract.id, bad, {
      ...base,
      excludedRowNumbers: [2],
      acceptedDuplicateCodes: ['B'],
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.items.map((i: { code: string }) => i.code)).toEqual(['B', 'B']);
    expect(accepted.body.duplicateCodes).toEqual([{ code: 'B', lineNos: [1, 2] }]);

    const notXlsx = await importCommit(contract.id, Buffer.from('PK nope'), {
      ...base,
      expectedVersion: accepted.body.version,
    });
    expect(notXlsx.status).toBe(415);
    expect((await importPreview(MISSING, ownerBoq)).status).toBe(404);
  });

  it('refuses preview and commit once the contract is approved', async () => {
    const contract = await addItem(await createContract(), priced('A'));
    const approved = await asAdmin(http().post(`/admin/contracts/${contract.id}/approve`)).send({
      expectedVersion: contract.version,
    });
    expect(approved.status).toBe(200);
    for (const res of [
      await importPreview(contract.id, ownerBoq),
      await importCommit(contract.id, ownerBoq, commitPayload(ownerBoq, approved.body.version)),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.details.reason).toBe('CONTRACT_APPROVED');
    }
    expect((await getContract(contract.id)).items).toHaveLength(1);
  });
});

describe('approval', () => {
  it('needs a priced item, then locks the BOQ for the API and for direct SQL', async () => {
    let contract = await createContract();
    const approve = (version: number) =>
      asAdmin(http().post(`/admin/contracts/${contract.id}/approve`)).send({
        expectedVersion: version,
      });

    const empty = await approve(1);
    expect(empty.status).toBe(409);
    expect(empty.body.details.reason).toBe('NO_PRICED_ITEMS');

    contract = await addItem(contract, { kind: 'heading', code: 'H' });
    const headingsOnly = await approve(contract.version);
    expect(headingsOnly.body.details.reason).toBe('NO_PRICED_ITEMS');

    contract = await addItem(contract, priced('A', '2', '10.5'));
    expect((await approve(contract.version - 1)).body.details.reason).toBe('STALE_VERSION');

    const ok = await approve(contract.version);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const approved = ContractDetailSchema.parse(ok.body);
    expect(approved).toMatchObject({
      status: 'approved',
      total: '21',
      version: contract.version + 1,
    });
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.approvedById).not.toBeNull();

    const event = await ctx.pool.query(
      `SELECT project_id, payload FROM events WHERE entity_id = $1 AND type = 'contract.approved'`,
      [contract.id],
    );
    expect(event.rows[0].project_id).toBeNull();
    expect(event.rows[0].payload).toMatchObject({
      total: '21',
      itemCount: 1,
      headingCount: 1,
      currency: 'EGP',
    });
    expect(event.rows[0].payload.lines).toHaveLength(2);
    expect(event.rows[0].payload.lines[1]).toMatchObject({ code: 'A', amount: '21' });

    // API: every BOQ change is a 409 CONTRACT_APPROVED.
    const v = approved.version;
    const itemId = approved.items[1]?.id ?? '';
    const responses = [
      await approve(v),
      await asAdmin(http().post(`/admin/contracts/${contract.id}/items`)).send({
        item: priced('B'),
        expectedVersion: v,
      }),
      await asAdmin(http().patch(`/admin/contracts/${contract.id}/items/${itemId}`)).send({
        item: priced('A', '9'),
        expectedVersion: v,
      }),
      await asAdmin(
        http().delete(`/admin/contracts/${contract.id}/items/${itemId}?expectedVersion=${v}`),
      ),
      await importCommit(contract.id, ownerBoq, commitPayload(ownerBoq, v)),
    ];
    for (const res of responses) {
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details.reason).toBe('CONTRACT_APPROVED');
    }

    // Header fields other than the currency stay editable.
    const edited = await asAdmin(http().patch(`/admin/contracts/${contract.id}`)).send({
      expectedVersion: v,
      notes: 'بعد الاعتماد',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.status).toBe('approved');

    // Database: the trigger rejects what the API would never send (safety net).
    const trigger = (sql: string, params: unknown[] = [contract.id]) => ctx.pool.query(sql, params);
    await expect(
      trigger(`UPDATE contract_items SET quantity = 99 WHERE contract_id = $1`),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      trigger(`DELETE FROM contract_items WHERE contract_id = $1`),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      trigger(
        `INSERT INTO contract_items (contract_id, line_no, kind, code) VALUES ($1, 99, 'heading', 'X')`,
      ),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      trigger(`UPDATE contracts SET status = 'draft', approved_at = NULL WHERE id = $1`),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(trigger(`DELETE FROM contracts WHERE id = $1`)).rejects.toMatchObject({
      code: '23001',
    });
    const after = await getContract(contract.id);
    expect(after.items).toHaveLength(2);
    expect(after.status).toBe('approved');
  });

  it('keeps the currency immutable in the database', async () => {
    const contract = await createContract();
    await expect(
      ctx.pool.query(`UPDATE contracts SET currency = 'USD' WHERE id = $1`, [contract.id]),
    ).rejects.toMatchObject({ code: '23001' });
  });
});

describe('PDF attachments', () => {
  it('uploads, lists, downloads and deletes a PDF; protects the import source', async () => {
    const contract = await createContract();
    const content = Buffer.from('%PDF-1.7 عقد موقع');
    const up = await asAdmin(http().post(`/admin/contracts/${contract.id}/attachments`)).attach(
      'file',
      content,
      { filename: 'العقد.pdf', contentType: 'application/pdf' },
    );
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const attachment = ContractAttachmentSchema.parse(up.body);
    expect(attachment).toMatchObject({ kind: 'document', fileName: 'العقد.pdf' });
    expect(attachment.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect((await getContract(contract.id)).attachments).toHaveLength(1);

    const download = await asAdmin(
      http().get(`/admin/contracts/${contract.id}/attachments/${attachment.id}`),
    )
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect((download.body as Buffer).equals(content)).toBe(true);

    const notPdf = await asAdmin(http().post(`/admin/contracts/${contract.id}/attachments`)).attach(
      'file',
      Buffer.from('plain text'),
      'a.pdf',
    );
    expect(notPdf.status).toBe(415);
    const unknown = await asAdmin(http().post(`/admin/contracts/${MISSING}/attachments`)).attach(
      'file',
      content,
      'a.pdf',
    );
    expect(unknown.status).toBe(404);

    const del = await asAdmin(
      http().delete(`/admin/contracts/${contract.id}/attachments/${attachment.id}`),
    );
    expect(del.status).toBe(204);
    expect(
      (await asAdmin(http().get(`/admin/contracts/${contract.id}/attachments/${attachment.id}`)))
        .status,
    ).toBe(404);
    expect(await eventTypes(ctx.pool, attachment.id)).toEqual([
      'contract_attachment.added',
      'contract_attachment.removed',
    ]);

    const imported = ContractDetailSchema.parse(
      (await importCommit(contract.id, ownerBoq, commitPayload(ownerBoq, 1))).body,
    );
    const protectedSource = await asAdmin(
      http().delete(`/admin/contracts/${contract.id}/attachments/${imported.attachments[0]?.id}`),
    );
    expect(protectedSource.status).toBe(409);
    expect(protectedSource.body.details.reason).toBe('IMPORT_SOURCE_PROTECTED');
  });
});

describe('projects under a contract', () => {
  async function projectOf(contract: ContractDetail): Promise<string> {
    const res = await asAdmin(http().post('/admin/projects')).send({
      name: unique('P'),
      contractId: contract.id,
      crsEpsg: 32636,
      locale: 'ar',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  it('lets admin and pm read the contract of their project; supervisor and qc get 403', async () => {
    let contract = await createContract({ client: 'شركة المياه', currency: 'USD' });
    contract = await addItem(contract, priced('A', '2', '10.5'));
    const projectId = await projectOf(contract);
    // Dedicated users: the seeded ones must keep exactly one membership (auth tests count them).
    const zone = await asAdmin(http().post(`/admin/projects/${projectId}/zones`)).send({
      name: 'Zone 1',
    });
    const zoneId = zone.body.id as string;
    const password = 'Contracts#12345';
    const users = {
      pm: ['pm-contracts@ftth.local', 'pm', undefined],
      supervisor: ['supervisor-contracts@ftth.local', 'supervisor', zoneId],
      qc: ['qc-contracts@ftth.local', 'qc', undefined],
    } as const;
    for (const [email, role, zone] of Object.values(users)) {
      await ensureMember(ctx.pool, { email, password, role, projectId, zoneId: zone });
    }
    pm = await loginAs(ctx, users.pm[0], password);
    supervisor = await loginAs(ctx, users.supervisor[0], password);
    qc = await loginAs(ctx, users.qc[0], password);

    const url = `/projects/${projectId}/contract`;
    for (const token of [admin, pm]) {
      const res = await http().get(url).set('Authorization', `Bearer ${token}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(ContractDetailSchema.parse(res.body)).toMatchObject({
        id: contract.id,
        total: '21',
        projectCount: 1,
      });
    }
    for (const token of [supervisor, qc]) {
      const res = await http().get(url).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    expect((await http().get(url)).status).toBe(401);

    const list = ContractListResponseSchema.parse(
      (await asAdmin(http().get('/admin/contracts'))).body,
    );
    expect(list.items.find((c) => c.id === contract.id)).toMatchObject({
      projectCount: 1,
      itemCount: 1,
      total: '21',
    });
  });

  it('answers 404 when the project has no contract (created before Phase 2)', async () => {
    const { rows } = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM projects WHERE contract_id IS NULL LIMIT 1`,
    );
    const res = await http()
      .get(`/projects/${rows[0]?.id}/contract`)
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(404);
  });

  it('copies client and currency from the contract and the database enforces them', async () => {
    const contract = await createContract({ client: 'Acme', currency: 'USD' });
    const projectId = await projectOf(contract);
    const { rows } = await ctx.pool.query(
      `SELECT client, currency, contract_id FROM projects WHERE id = $1`,
      [projectId],
    );
    expect(rows[0]).toMatchObject({ client: 'Acme', currency: 'USD', contract_id: contract.id });

    // A project whose currency differs from its contract's is rejected by the trigger.
    await expect(
      ctx.pool.query(
        `INSERT INTO projects (name, client, crs_epsg, currency, contract_id)
         VALUES ('bad', 'Acme', 32636, 'EGP', $1)`,
        [contract.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // The contract of a project cannot change once set.
    const other = await createContract({ currency: 'USD' });
    await expect(
      ctx.pool.query(`UPDATE projects SET contract_id = $2 WHERE id = $1`, [projectId, other.id]),
    ).rejects.toMatchObject({ code: '23001' });
    // A contract with projects cannot be deleted.
    await expect(
      ctx.pool.query(`DELETE FROM contracts WHERE id = $1`, [contract.id]),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
