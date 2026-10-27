import { createHash, randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  WorkOrderAttachmentSchema,
  WorkOrderDetailSchema,
  WorkOrderImportPreviewResponseSchema,
  WorkOrderListResponseSchema,
  type WorkOrderDetail,
} from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildXlsx, ENGLISH_HEADER } from '../src/modules/work-orders/testing/xlsx-builder.js';
import { eventTypes, ensureMember, loginAs, projectIds, SEED_LOGINS } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

let ctx: TestContext;
let projectA: string;
let projectB: string;
let admin: string;
let pm: string;
let supervisor: string;
let qc: string;
let contractor: string;

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'), { MAX_UPLOAD_MB: '1' });
  const ids = await projectIds(ctx.pool);
  projectA = ids.a;
  projectB = ids.b;
  await ensureMember(ctx.pool, {
    email: 'qc@ftth.local',
    password: 'Qc#1234567',
    role: 'qc',
    projectId: projectA,
  });
  await ensureMember(ctx.pool, {
    email: 'contractor@ftth.local',
    password: 'Contractor#123',
    role: 'contractor',
    projectId: projectA,
    zoneId: ids.zone,
  });
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
  pm = await loginAs(ctx, ...SEED_LOGINS.pm);
  supervisor = await loginAs(ctx, ...SEED_LOGINS.supervisor);
  qc = await loginAs(ctx, 'qc@ftth.local', 'Qc#1234567');
  contractor = await loginAs(ctx, 'contractor@ftth.local', 'Contractor#123');
});
afterAll(async () => {
  await ctx.close();
});

const http = () => request(ctx.app.getHttpServer());
const base = (project: string) => `/projects/${project}/work-orders`;
const uniqueNumber = (prefix = 'WO') => `${prefix}-${randomUUID().slice(0, 8)}`;
const item = (code: string, quantity = '2', unitPrice = '10.5') => ({
  code,
  description: `بند ${code}`,
  unit: 'م.ط',
  quantity,
  unitPrice,
});

async function createOrder(
  token: string,
  body: Record<string, unknown> = {},
  project = projectA,
): Promise<WorkOrderDetail> {
  const res = await http()
    .post(base(project))
    .set('Authorization', `Bearer ${token}`)
    .send({ number: uniqueNumber(), items: [item('A'), item('B', '1', '0.25')], ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return WorkOrderDetailSchema.parse(res.body);
}

describe('work order CRUD', () => {
  it('creates a work order with the project currency, numbered items and an exact total', async () => {
    const number = uniqueNumber();
    const order = await createOrder(pm, {
      number,
      title: 'المرحلة الأولى',
      issuedOn: '2026-10-01',
    });

    expect(order).toMatchObject({
      projectId: projectA,
      number,
      title: 'المرحلة الأولى',
      issuedOn: '2026-10-01',
      currency: 'EGP',
      source: 'manual',
      version: 1,
      itemCount: 2,
      total: '21.25',
      attachmentCount: 0,
      duplicateCodes: [],
    });
    expect(order.items.map((i) => [i.lineNo, i.code, i.amount])).toEqual([
      [1, 'A', '21'],
      [2, 'B', '0.25'],
    ]);
    expect(await eventTypes(ctx.pool, order.id)).toEqual(['work_order.created']);
  });

  it('keeps totals equal to SUM(amount) in the database, even with awkward decimals', async () => {
    const order = await createOrder(pm, {
      items: [
        item('A', '0.1', '0.2'),
        item('B', '3', '33.3333'),
        item('C', '12.5', '4'),
        item('D', '99999999999999.9999', '0.0001'),
        item('E', '0.0001', '0.0001'),
      ],
    });
    const { rows } = await ctx.pool.query<{ total: string; matches: boolean }>(
      `SELECT SUM(amount)::text AS total, SUM(amount) = $2::numeric AS matches
       FROM work_order_items WHERE work_order_id = $1`,
      [order.id, order.total],
    );
    expect(rows[0]?.matches, `db ${rows[0]?.total} vs api ${order.total}`).toBe(true);

    const list = WorkOrderListResponseSchema.parse(
      (await http().get(base(projectA)).set('Authorization', `Bearer ${pm}`)).body,
    );
    const summary = list.items.find((s) => s.id === order.id);
    expect(summary?.total).toBe(order.total);
    expect(summary?.itemCount).toBe(5);
  });

  it('lists work orders ordered by number and never shows another project', async () => {
    const inB = await createOrder(admin, { number: uniqueNumber('B') }, projectB);
    const res = await http().get(base(projectA)).set('Authorization', `Bearer ${pm}`);
    expect(res.status).toBe(200);
    const numbers = WorkOrderListResponseSchema.parse(res.body).items.map((s) => s.number);
    expect(numbers).toEqual([...numbers].sort());
    expect(res.body.items.some((s: { id: string }) => s.id === inB.id)).toBe(false);
  });

  it('rejects a duplicate number with 409 and invalid bodies with 400', async () => {
    const number = uniqueNumber();
    await createOrder(pm, { number });
    const again = await http()
      .post(base(projectA))
      .set('Authorization', `Bearer ${pm}`)
      .send({ number, items: [] });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'CONFLICT', details: { reason: 'NUMBER_TAKEN' } });

    // The same number is free in another project.
    await createOrder(admin, { number }, projectB);

    for (const body of [
      { number: '' },
      { number: 'x', items: [{ ...item('A'), quantity: '1.23456' }] },
      { number: 'x', items: [{ ...item('A'), unitPrice: 5 }] },
      { number: 'x', items: [item('A'), item('A')] },
    ]) {
      const res = await http().post(base(projectA)).set('Authorization', `Bearer ${pm}`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('keeps duplicate codes only when accepted explicitly, and reports them', async () => {
    const order = await createOrder(pm, {
      items: [item('X'), item('Y'), item('X', '5')],
      acceptedDuplicateCodes: ['X'],
    });
    expect(order.duplicateCodes).toEqual([{ code: 'X', lineNos: [1, 3] }]);
    expect(order.items).toHaveLength(3);
  });

  it('updates the header with optimistic concurrency', async () => {
    const order = await createOrder(pm);
    const patch = (body: Record<string, unknown>) =>
      http()
        .patch(`${base(projectA)}/${order.id}`)
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

    const other = await createOrder(pm);
    const taken = await patch({ number: other.number, expectedVersion: 3 });
    expect(taken.status).toBe(409);
    expect((await patch({ expectedVersion: 3 })).status).toBe(400);

    expect(await eventTypes(ctx.pool, order.id)).toEqual([
      'work_order.created',
      'work_order.updated',
      'work_order.updated',
    ]);
    const { rows } = await ctx.pool.query(
      "SELECT payload FROM events WHERE entity_id = $1 AND type = 'work_order.updated' ORDER BY id LIMIT 1",
      [order.id],
    );
    expect(rows[0]?.payload).toMatchObject({
      before: { title: null, notes: null },
      after: { title: 'جديد', notes: 'ملاحظة' },
    });
  });

  it('adds, edits and removes items; versions and totals follow; line numbers are not compacted', async () => {
    const order = await createOrder(pm);
    const url = `${base(projectA)}/${order.id}`;
    const authed = (req: request.Test) => req.set('Authorization', `Bearer ${pm}`);

    const added = await authed(http().post(`${url}/items`)).send(item('C', '4', '2.5'));
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      lineNo: 3,
      amount: '10',
      workOrderId: order.id,
      source: 'manual',
    });

    const clash = await authed(http().post(`${url}/items`)).send({ ...item('Z'), lineNo: 3 });
    expect(clash.status).toBe(409);
    const duplicate = await authed(http().post(`${url}/items`)).send(item('A'));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.details.reason).toBe('DUPLICATE_CODE');
    const accepted = await authed(http().post(`${url}/items`)).send({
      ...item('A', '1', '1'),
      acceptDuplicateCode: true,
    });
    expect(accepted.status).toBe(201);

    const edited = await authed(http().patch(`${url}/items/${added.body.id}`)).send({
      quantity: '8',
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ quantity: '8', unitPrice: '2.5', amount: '20' });

    const removed = await authed(http().delete(`${url}/items/${order.items[0]?.id}`));
    expect(removed.status).toBe(204);

    const detail = WorkOrderDetailSchema.parse((await authed(http().get(url))).body);
    expect(detail.items.map((i) => i.lineNo)).toEqual([2, 3, 4]);
    expect(detail.total).toBe('21.25');
    expect(detail.version).toBe(5);
    expect(detail.duplicateCodes).toEqual([]);
    expect(await eventTypes(ctx.pool, order.id)).toEqual(['work_order.created']);
    const itemEvents = await ctx.pool.query<{ type: string }>(
      `SELECT type FROM events WHERE payload->>'workOrderId' = $1 ORDER BY id`,
      [order.id],
    );
    expect(itemEvents.rows.map((r) => r.type)).toEqual([
      'work_order_item.added',
      'work_order_item.added',
      'work_order_item.updated',
      'work_order_item.removed',
    ]);
  });

  it('deletes a work order, its items and files, and keeps a snapshot in the event', async () => {
    const order = await createOrder(pm, { number: uniqueNumber('DEL') });
    const pdf = await http()
      .post(`${base(projectA)}/${order.id}/attachments`)
      .set('Authorization', `Bearer ${pm}`)
      .attach('file', Buffer.from('%PDF-1.7 content'), 'scope.pdf');
    expect(pdf.status).toBe(201);
    const stored = join(ctx.storageRoot, 'projects', projectA, 'work-orders', order.id);
    await access(stored);

    const res = await http()
      .delete(`${base(projectA)}/${order.id}`)
      .set('Authorization', `Bearer ${pm}`);
    expect(res.status).toBe(204);
    expect(
      (
        await http()
          .get(`${base(projectA)}/${order.id}`)
          .set('Authorization', `Bearer ${pm}`)
      ).status,
    ).toBe(404);
    await expect(access(join(stored, 'attachments', `${pdf.body.id}.pdf`))).rejects.toThrow();

    const remaining = await ctx.pool.query(
      'SELECT 1 FROM work_order_items WHERE work_order_id = $1',
      [order.id],
    );
    expect(remaining.rowCount).toBe(0);
    const { rows } = await ctx.pool.query(
      "SELECT payload FROM events WHERE entity_id = $1 AND type = 'work_order.deleted'",
      [order.id],
    );
    expect(rows[0]?.payload).toMatchObject({
      number: order.number,
      total: '21.25',
      items: [expect.objectContaining({ code: 'A' }), expect.objectContaining({ code: 'B' })],
    });
  });

  it('answers 400 for a malformed id', async () => {
    const res = await http()
      .get(`${base(projectA)}/not-a-uuid`)
      .set('Authorization', `Bearer ${pm}`);
    expect(res.status).toBe(400);
  });

  it('rejects a JSON body above 5 MB with 413 FILE_TOO_LARGE', async () => {
    const res = await http()
      .post(base(projectA))
      .set('Authorization', `Bearer ${pm}`)
      .send({ number: uniqueNumber(), notes: 'x'.repeat(5.5 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });
});

describe('access control', () => {
  it('answers NOT_FOUND (never FORBIDDEN) for ids that belong to another project', async () => {
    const inB = await createOrder(admin, { number: uniqueNumber('XB') }, projectB);
    const url = `${base(projectA)}/${inB.id}`;
    const withPm = (req: request.Test) => req.set('Authorization', `Bearer ${pm}`);

    for (const res of [
      await withPm(http().get(url)),
      await withPm(http().patch(url)).send({ title: 'hijack', expectedVersion: 1 }),
      await withPm(http().delete(url)),
      await withPm(http().post(`${url}/items`)).send(item('Q')),
      await withPm(http().patch(`${url}/items/${inB.items[0]?.id}`)).send({ code: 'Q' }),
      await withPm(http().delete(`${url}/items/${inB.items[0]?.id}`)),
      await withPm(http().get(`${url}/attachments`)),
      await withPm(http().post(`${url}/attachments`)).attach(
        'file',
        Buffer.from('%PDF-1.7'),
        'a.pdf',
      ),
    ]) {
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    // An item id of project A under a work order of project A but asked through B's path is also unknown.
    const own = await createOrder(pm);
    const wrongOrder = await withPm(
      http().patch(`${base(projectA)}/${inB.id}/items/${own.items[0]?.id}`),
    ).send({ code: 'Q' });
    expect(wrongOrder.status).toBe(404);

    const untouched = await ctx.pool.query('SELECT version, title FROM work_orders WHERE id = $1', [
      inB.id,
    ]);
    expect(untouched.rows[0]).toMatchObject({ version: 1, title: null });
    expect(
      (
        await http()
          .get(`${base(projectB)}/${inB.id}`)
          .set('Authorization', `Bearer ${pm}`)
      ).status,
    ).toBe(403); // not a member of project B at all
  });

  it('lets a supervisor and qc read but not write', async () => {
    const order = await createOrder(pm);
    for (const token of [supervisor, qc]) {
      const auth = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
      expect((await auth(http().get(base(projectA)))).status).toBe(200);
      expect((await auth(http().get(`${base(projectA)}/${order.id}`))).status).toBe(200);
      expect((await auth(http().get(`${base(projectA)}/${order.id}/attachments`))).status).toBe(
        200,
      );

      for (const res of [
        await auth(http().post(base(projectA))).send({ number: uniqueNumber() }),
        await auth(http().patch(`${base(projectA)}/${order.id}`)).send({
          title: 'x',
          expectedVersion: 1,
        }),
        await auth(http().delete(`${base(projectA)}/${order.id}`)),
        await auth(http().post(`${base(projectA)}/${order.id}/items`)).send(item('Q')),
        await auth(http().post(`${base(projectA)}/import/preview`)).attach(
          'file',
          Buffer.from('x'),
          'a.xlsx',
        ),
        await auth(http().post(`${base(projectA)}/${order.id}/attachments`)).attach(
          'file',
          Buffer.from('%PDF-'),
          'a.pdf',
        ),
      ]) {
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    }
  });

  it('denies a contractor everything, and anonymous callers 401', async () => {
    const order = await createOrder(pm);
    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${contractor}`);
    expect((await auth(http().get(base(projectA)))).status).toBe(403);
    expect((await auth(http().get(`${base(projectA)}/${order.id}`))).status).toBe(403);
    expect((await auth(http().post(base(projectA))).send({ number: 'x' })).status).toBe(403);
    expect((await http().get(base(projectA))).status).toBe(401);
  });

  it('lets a platform admin act in any project', async () => {
    const order = await createOrder(admin, {}, projectB);
    const res = await http()
      .get(`${base(projectB)}/${order.id}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
  });
});

describe('PDF attachments', () => {
  it('uploads, lists, downloads byte for byte, and deletes', async () => {
    const order = await createOrder(pm);
    const url = `${base(projectA)}/${order.id}/attachments`;
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
      contentType: 'application/pdf',
      sizeBytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });

    const list = await http().get(url).set('Authorization', `Bearer ${supervisor}`);
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
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('أمر التكليف.pdf')}`,
    );
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect((download.body as Buffer).equals(content)).toBe(true);

    const detail = await http()
      .get(`${base(projectA)}/${order.id}`)
      .set('Authorization', `Bearer ${pm}`);
    expect(detail.body.attachmentCount).toBe(1);

    const removed = await http()
      .delete(`${url}/${attachment.id}`)
      .set('Authorization', `Bearer ${pm}`);
    expect(removed.status).toBe(204);
    const stored = await readFile(
      join(
        ctx.storageRoot,
        'projects',
        projectA,
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
    const order = await createOrder(pm);
    const url = `${base(projectA)}/${order.id}/attachments`;
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
    expect(missing.status).toBe(400); // multipart, but no "file" part
    const empty = await http().post(url).set('Authorization', `Bearer ${pm}`).send({ a: 1 });
    expect(empty.status).toBe(415);

    expect((await http().get(url).set('Authorization', `Bearer ${pm}`)).body.items).toEqual([]);
  });
});

describe('Excel import', () => {
  const sheetRows = (rows: unknown[][]) => [ENGLISH_HEADER.slice(0, 5), ...rows];
  const xlsx = (rows: unknown[][]) => buildXlsx([{ name: 'BOQ', rows: sheetRows(rows) as never }]);

  const preview = (file: Buffer, payload: object = {}, token = pm) =>
    http()
      .post(`${base(projectA)}/import/preview`)
      .set('Authorization', `Bearer ${token}`)
      .field('payload', JSON.stringify(payload))
      .attach('file', file, 'boq.xlsx');
  const commit = (file: Buffer, payload: object, token = pm, name = 'boq.xlsx') =>
    http()
      .post(`${base(projectA)}/import`)
      .set('Authorization', `Bearer ${token}`)
      .field('payload', JSON.stringify(payload))
      .attach('file', file, name);

  const commitPayload = (file: Buffer, overrides: object = {}) => ({
    fileSha256: createHash('sha256').update(file).digest('hex'),
    sheetName: 'BOQ',
    headerRow: 1,
    mapping: { code: 0, description: 1, unit: 2, quantity: 3, unitPrice: 4, amount: null },
    workOrder: { number: uniqueNumber('IMP'), title: 'Imported' },
    ...overrides,
  });

  it('previews without writing, then commits atomically with the source file attached', async () => {
    const file = await xlsx([
      ['I-1', 'حفر', 'م.ط', 10, 25.5],
      ['I-2', 'مواسير', 'م.ط', '٣٫٥', 100],
    ]);
    const before = await ctx.pool.query('SELECT count(*)::int AS n FROM work_orders');

    const prev = await preview(file);
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    const parsed = WorkOrderImportPreviewResponseSchema.parse(prev.body);
    expect(parsed).toMatchObject({
      sheetName: 'BOQ',
      headerRow: 1,
      mapping: { code: 0, description: 1, unit: 2, quantity: 3, unitPrice: 4, amount: null },
      summary: { rowCount: 2, errorRowCount: 0, total: '605' },
      file: {
        name: 'boq.xlsx',
        sizeBytes: file.length,
        sha256: createHash('sha256').update(file).digest('hex'),
      },
    });
    expect(parsed.rows.map((r) => r.amount)).toEqual(['255', '350']);
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM work_orders')).rows[0]).toEqual(
      before.rows[0],
    );

    const res = await commit(file, commitPayload(file));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = WorkOrderDetailSchema.parse(res.body);
    expect(order).toMatchObject({ source: 'import', currency: 'EGP', total: '605', itemCount: 2 });
    expect(order.items.map((i) => [i.lineNo, i.source, i.sourceRow])).toEqual([
      [1, 'import', 2],
      [2, 'import', 3],
    ]);
    expect(order.attachments).toHaveLength(1);
    expect(order.attachments[0]).toMatchObject({
      kind: 'import_source',
      fileName: 'boq.xlsx',
      sha256: createHash('sha256').update(file).digest('hex'),
    });
    expect(await eventTypes(ctx.pool, order.id)).toEqual(['work_order.imported']);

    const { rows } = await ctx.pool.query<{ total: string }>(
      'SELECT SUM(amount)::text AS total FROM work_order_items WHERE work_order_id = $1',
      [order.id],
    );
    expect(Number(rows[0]?.total)).toBe(605);

    // The stored xlsx can be downloaded, but not deleted.
    const source = order.attachments[0];
    const url = `${base(projectA)}/${order.id}/attachments/${source?.id}`;
    const content = await http()
      .get(`${url}/content`)
      .set('Authorization', `Bearer ${pm}`)
      .buffer(true)
      .parse((r, callback) => {
        const chunks: Buffer[] = [];
        r.on('data', (chunk: Buffer) => chunks.push(chunk));
        r.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect((content.body as Buffer).equals(file)).toBe(true);
    const del = await http().delete(url).set('Authorization', `Bearer ${pm}`);
    expect(del.status).toBe(409);
  });

  it('walks the duplicate-code flow: preview warns, commit is refused, then accepted per code', async () => {
    const file = await xlsx([
      ['D-1', 'a', 'm', 1, 5],
      ['D-1', 'b', 'm', 2, 5],
      ['D-2', 'c', 'm', 3, 5],
    ]);
    const parsed = WorkOrderImportPreviewResponseSchema.parse((await preview(file)).body);
    expect(parsed.summary.duplicateCodes).toEqual([{ code: 'D-1', rowNumbers: [2, 3] }]);
    expect(parsed.rows[0]?.issues).toEqual([
      expect.objectContaining({ code: 'DUPLICATE_CODE', severity: 'warning' }),
    ]);

    const refused = await commit(file, commitPayload(file));
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      code: 'IMPORT_INVALID',
      details: { reason: 'UNRESOLVED_DUPLICATES', duplicateCodes: ['D-1'] },
    });

    const excluded = await commit(file, commitPayload(file, { excludedRowNumbers: [3] }));
    expect(excluded.status).toBe(201);
    expect(excluded.body.itemCount).toBe(2);

    const accepted = await commit(file, commitPayload(file, { acceptedDuplicateCodes: ['D-1'] }));
    expect(accepted.status).toBe(201);
    expect(accepted.body.duplicateCodes).toEqual([{ code: 'D-1', lineNos: [1, 2] }]);
    expect(accepted.body.itemCount).toBe(3);
  });

  it('refuses rows with errors and a changed file, leaving no work order and no stored file', async () => {
    const file = await xlsx([
      ['E-1', 'a', 'm', 1, 5],
      ['E-2', 'b', 'm', 'abc', 5],
      ['E-3', 'c', 'm', 1.23456, 5],
    ]);
    const number = uniqueNumber('ERR');
    const refused = await commit(file, commitPayload(file, { workOrder: { number } }));
    expect(refused.status).toBe(422);
    expect(refused.body.details.reason).toBe('ROW_ERRORS');
    expect(refused.body.details.rows.map((r: { rowNumber: number }) => r.rowNumber)).toEqual([
      3, 4,
    ]);
    expect(refused.body.details.rows[1].issues[0].code).toBe('TOO_MANY_DECIMALS');

    const other = await xlsx([['E-1', 'a', 'm', 1, 6]]);
    const changed = await commit(other, commitPayload(file, { workOrder: { number } }));
    expect(changed.status).toBe(422);
    expect(changed.body.details.reason).toBe('FILE_CHANGED');

    const none = await ctx.pool.query('SELECT 1 FROM work_orders WHERE number = $1', [number]);
    expect(none.rowCount).toBe(0);
  });

  it('answers 409 for a taken number and removes the object it had already stored', async () => {
    const file = await xlsx([['N-1', 'a', 'm', 1, 5]]);
    const payload = commitPayload(file);
    expect((await commit(file, payload)).status).toBe(201);

    const countFiles = async () =>
      (
        await ctx.pool.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM work_order_attachments',
        )
      ).rows[0]?.n;
    const before = await countFiles();
    const again = await commit(file, payload);
    expect(again.status).toBe(409);
    expect(again.body.details.reason).toBe('NUMBER_TAKEN');
    expect(await countFiles()).toBe(before);
  });

  it('refuses .xls, .csv and disguised files with 415 UNSUPPORTED_FILE', async () => {
    const file = await xlsx([['U-1', 'a', 'm', 1, 5]]);
    const asXls = await commit(file, commitPayload(file), pm, 'boq.xls');
    expect(asXls.status).toBe(415);
    expect(asXls.body.code).toBe('UNSUPPORTED_FILE');
    expect((await commit(Buffer.from('a,b\n1,2'), commitPayload(file), pm, 'boq.csv')).status).toBe(
      415,
    );
    expect(
      (await commit(Buffer.from('PK\u0003\u0004junk'), commitPayload(file), pm, 'boq.xlsx')).status,
    ).toBe(415);
  });

  it('validates the payload field and the upload size', async () => {
    const file = await xlsx([['V-1', 'a', 'm', 1, 5]]);
    const noPayload = await http()
      .post(`${base(projectA)}/import`)
      .set('Authorization', `Bearer ${pm}`)
      .attach('file', file, 'boq.xlsx');
    expect(noPayload.status).toBe(400);
    const badJson = await http()
      .post(`${base(projectA)}/import`)
      .set('Authorization', `Bearer ${pm}`)
      .field('payload', '{nope')
      .attach('file', file, 'boq.xlsx');
    expect(badJson.status).toBe(400);
    const noFile = await http()
      .post(`${base(projectA)}/import/preview`)
      .set('Authorization', `Bearer ${pm}`)
      .field('payload', '{}');
    expect(noFile.status).toBe(400);

    const huge = await preview(Buffer.concat([file, Buffer.alloc(1_200_000)]));
    expect(huge.status).toBe(413);
    expect(huge.body.code).toBe('FILE_TOO_LARGE');
  });

  it('reports file-level problems in the preview instead of failing', async () => {
    const file = await buildXlsx([{ name: 'Empty', rows: [['nothing here']] }]);
    const res = await preview(file);
    expect(res.status).toBe(200);
    expect(res.body.fileIssues).toEqual([{ code: 'HEADER_ROW_NOT_FOUND', field: null }]);
    expect(res.body.rows).toEqual([]);
  });
});
