import { createHash, randomUUID } from 'node:crypto';
import {
  OfflineBundleSchema,
  SyncChangesResponseSchema,
  SyncPushResponseSchema,
  type OpResult,
  shiftDay,
  workDayOf,
} from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createExecutionFixture, type ExecutionFixture } from './support/execution-fixtures.js';
import { loginAs, SEED_LOGINS } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

/**
 * ADR-052: the performer of every work line (a contractor line or the own crew), the contractor
 * quantity cap, the bundle's contractor list and the admin conflicts that protect recorded work.
 * Real PostGIS, as everywhere.
 */
let ctx: TestContext;
let fx: ExecutionFixture;
let admin: string;

const http = () => request(ctx.app.getHttpServer());
const DEVICE = randomUUID();

/** A contractor registered on the fixture work order, one line per item. */
interface Registered {
  contractorId: string;
  registrationId: string;
  lineIds: Record<string, string>;
}

// The tests share one work order: whole-line contractors on C-02 (work order 10) add up to 10 and
// on C-01 (work order 100) to 99, within the per-scope cap of migration 0013 (ADR-057 adds 2 + 2
// on C-01 and 1 on C-02).
async function register(
  name: string,
  lines: { item: string; quantity: string; scope?: string }[],
): Promise<Registered> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    const contractor = await client.query<{ id: string }>(
      `INSERT INTO contractors (name, contact_name, contact_phone)
       VALUES ($1, 'Contact', '0100000000') RETURNING id`,
      [`${name} ${randomUUID().slice(0, 8)}`],
    );
    const contractorId = contractor.rows[0]?.id ?? '';
    const order = await client.query<{ id: string }>(
      `SELECT work_order_id AS id FROM work_order_items WHERE id = $1`,
      [lines[0]?.item],
    );
    const registration = await client.query<{ id: string }>(
      `INSERT INTO contractor_registrations (project_id, work_order_id, contractor_id, registered_on)
       VALUES ($1, $2, $3, '2026-11-01') RETURNING id`,
      [fx.projectId, order.rows[0]?.id, contractorId],
    );
    const registrationId = registration.rows[0]?.id ?? '';
    const lineIds: Record<string, string> = {};
    for (const line of lines) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO contractor_lines (project_id, registration_id, work_order_item_id, scope,
                                       scope_key, quantity)
         VALUES ($1, $2, $3, $4::text, $4::text, $5) RETURNING id`,
        [fx.projectId, registrationId, line.item, line.scope ?? null, line.quantity],
      );
      const lineId = inserted.rows[0]?.id ?? '';
      lineIds[line.item] = lineId;
      await client.query(
        `INSERT INTO contractor_line_prices (contractor_line_id, effective_from, unit_price)
         VALUES ($1, '2026-11-01', 0)`,
        [lineId],
      );
    }
    await client.query('COMMIT');
    return { contractorId, registrationId, lineIds };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type Performer = { kind: 'self' } | { kind: 'contractor'; contractorLineId: string } | null;

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function op(
  lines: { item: string; quantity: string; performer: Performer; role?: string }[],
  workType = 'civil',
  workDate: string | null = null,
) {
  const photo = Buffer.alloc(3000, 1);
  photo.set([0xff, 0xd8, 0xff, 0xe0], 0);
  photo.set([0xff, 0xd9], photo.length - 2);
  const now = new Date().toISOString();
  return {
    kind: 'execution_update.record',
    clientOpId: randomUUID(),
    capturedAt: now,
    payload: {
      featureId: fx.boxA,
      designRevisionId: fx.revisionId,
      workType,
      lines: lines.map((line) => ({
        workOrderItemId: line.item,
        quantity: line.quantity,
        role: line.role ?? 'work',
        performer: line.performer,
      })),
      label: null,
      note: null,
      gps: null,
      photos: [
        {
          photoId: randomUUID(),
          requirementKey: 'general',
          sha256: sha(photo),
          sizeBytes: photo.length,
          contentType: 'image/jpeg',
          takenAt: now,
          gps: null,
        },
      ],
      acknowledgedWarnings: [],
      workDate,
    },
  };
}

async function push(operation: unknown): Promise<OpResult> {
  const res = await http()
    .post(`/projects/${fx.projectId}/sync/push`)
    .set('Authorization', `Bearer ${fx.tokens.supervisorA}`)
    .send({ deviceId: DEVICE, ops: [operation] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const [result] = SyncPushResponseSchema.parse(res.body).results;
  if (!result) throw new Error('no result');
  return result;
}

const adminReq = (req: request.Test) => req.set('Authorization', `Bearer ${admin}`);
const adminUrl = (suffix: string) => `/admin/projects/${fx.projectId}/contractors${suffix}`;
const self: Performer = { kind: 'self' };
const viaLine = (contractorLineId: string): Performer => ({ kind: 'contractor', contractorLineId });

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  fx = await createExecutionFixture(ctx);
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

describe('performer of a work line', () => {
  it('records the own crew with no cap and a contractor line within its quantity', async () => {
    const reg = await register('Alpha', [{ item: fx.items.civilMetres, quantity: '40' }]);
    const line = reg.lineIds[fx.items.civilMetres] ?? '';
    const own = await push(op([{ item: fx.items.civilMetres, quantity: '30', performer: self }]));
    expect(own.outcome).toBe('applied');
    const done = await push(
      op([{ item: fx.items.civilMetres, quantity: '40', performer: viaLine(line) }]),
    );
    expect(done.outcome).toBe('applied');
    const { rows } = await ctx.pool.query(
      `SELECT performer, contractor_line_id FROM execution_update_lines WHERE contractor_line_id = $1`,
      [line],
    );
    expect(rows).toEqual([{ performer: 'contractor', contractor_line_id: line }]);
    // The next piece is over what is left (nothing).
    const over = await push(
      op([{ item: fx.items.civilMetres, quantity: '0.0001', performer: viaLine(line) }]),
    );
    expect(over).toMatchObject({ outcome: 'rejected', code: 'CONTRACTOR_QUANTITY_EXCEEDED' });
  });

  it('rejects an unknown contractor line and one of another work-order line', async () => {
    const reg = await register('Bravo', [{ item: fx.items.civilPieces, quantity: '1' }]);
    const pieces = reg.lineIds[fx.items.civilPieces] ?? '';
    const unknown = await push(
      op([{ item: fx.items.civilMetres, quantity: '1', performer: viaLine(randomUUID()) }]),
    );
    expect(unknown).toMatchObject({ outcome: 'rejected', code: 'CONTRACTOR_LINE_NOT_FOUND' });
    const wrongItem = await push(
      op([{ item: fx.items.civilMetres, quantity: '1', performer: viaLine(pieces) }]),
    );
    expect(wrongItem).toMatchObject({ outcome: 'rejected', code: 'CONTRACTOR_LINE_NOT_FOUND' });
  });

  it('frees the quantity of rejected work', async () => {
    const reg = await register('Charlie', [{ item: fx.items.civilMetres, quantity: '10' }]);
    const line = reg.lineIds[fx.items.civilMetres] ?? '';
    const first = await push(
      op([{ item: fx.items.civilMetres, quantity: '10', performer: viaLine(line) }]),
    );
    expect(first.outcome).toBe('applied');
    const full = await push(
      op([{ item: fx.items.civilMetres, quantity: '1', performer: viaLine(line) }]),
    );
    expect(full).toMatchObject({ outcome: 'rejected', code: 'CONTRACTOR_QUANTITY_EXCEEDED' });
    if (first.outcome !== 'applied') return;
    await ctx.pool.query(
      `UPDATE execution_updates SET status = 'rejected', review_reason = 'test' WHERE id = $1`,
      [first.updateId],
    );
    const again = await push(
      op([{ item: fx.items.civilMetres, quantity: '10', performer: viaLine(line) }]),
    );
    expect(again.outcome).toBe('applied');
  });

  it('splits one work-order line between two contractors and the own crew, and shows the performers in the changes feed', async () => {
    const one = await register('Delta', [{ item: fx.items.civilPieces, quantity: '3' }]);
    const two = await register('Echo', [{ item: fx.items.civilPieces, quantity: '4' }]);
    const a = one.lineIds[fx.items.civilPieces] ?? '';
    const b = two.lineIds[fx.items.civilPieces] ?? '';
    const operation = op([
      { item: fx.items.civilPieces, quantity: '2', performer: viaLine(a) },
      { item: fx.items.civilPieces, quantity: '3', performer: viaLine(b) },
      { item: fx.items.civilPieces, quantity: '1', performer: self },
      // Same work type as the update (civil): the material line has no performer.
      { item: fx.items.civilMetres, quantity: '1', performer: null, role: 'material' },
    ]);
    const result = await push(operation);
    expect(result.outcome, JSON.stringify(result)).toBe('applied');
    const res = await http()
      .get(`/projects/${fx.projectId}/sync/changes?cursor=0&limit=500`)
      .set('Authorization', `Bearer ${fx.tokens.supervisorA}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const feed = SyncChangesResponseSchema.parse(res.body);
    const update = feed.updates.find((u) => u.clientOpId === operation.clientOpId);
    expect(update?.lines.map((line) => line.performer)).toEqual([
      viaLine(a),
      viaLine(b),
      self,
      null,
    ]);
    const event = await ctx.pool.query(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'execution_update.recorded'`,
      [result.outcome === 'applied' ? result.updateId : ''],
    );
    expect(JSON.stringify(event.rows[0]?.payload)).toContain(a);
  });

  it('refuses at the database what the API would not let through (backstop)', async () => {
    const reg = await register('Foxtrot', [{ item: fx.items.civilMetres, quantity: '5' }]);
    const line = reg.lineIds[fx.items.civilMetres] ?? '';
    const { rows } = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM execution_updates WHERE project_id = $1 LIMIT 1`,
      [fx.projectId],
    );
    const updateId = rows[0]?.id;
    expect(updateId).toBeDefined();
    const insert = (item: string, quantity: string, performer: string | null, cl: string | null) =>
      ctx.pool.query(
        `INSERT INTO execution_update_lines
           (update_id, project_id, line_no, role, work_order_item_id, quantity, performer, contractor_line_id)
         VALUES ($1, $2, 900, 'work', $3, $4, $5, $6)`,
        [updateId, fx.projectId, item, quantity, performer, cl],
      );
    await expect(insert(fx.items.civilMetres, '6', 'contractor', line)).rejects.toThrow(
      /contractor quantity exceeded/,
    );
    await expect(insert(fx.items.civilPieces, '1', 'contractor', line)).rejects.toThrow(
      /another work-order line/,
    );
    await expect(insert(fx.items.civilMetres, '1', null, null)).rejects.toThrow(
      /work_needs_performer/,
    );
    await expect(insert(fx.items.civilMetres, '1', 'contractor', null)).rejects.toThrow(
      /performer_line/,
    );
  });
});

describe('bootstrap catalog', () => {
  it('lists the contractor lines of each item with their recorded quantity, never prices', async () => {
    const reg = await register('Golf', [
      { item: fx.items.installation, quantity: '4', scope: 'B2' },
    ]);
    const line = reg.lineIds[fx.items.installation] ?? '';
    const operation = op(
      [{ item: fx.items.installation, quantity: '1.5', performer: viaLine(line) }],
      'installation',
    );
    expect((await push(operation)).outcome).toBe('applied');
    const res = await http()
      .get(`/projects/${fx.projectId}/sync/bootstrap`)
      .set('Authorization', `Bearer ${fx.tokens.supervisorA}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bundle = OfflineBundleSchema.parse(res.body);
    const item = bundle.catalog.find((entry) => entry.id === fx.items.installation);
    const entry = item?.contractors.find((c) => c.contractorLineId === line);
    expect(entry).toMatchObject({
      contractorId: reg.contractorId,
      scope: 'B2',
      quantity: '4',
      recordedQuantity: '1.5',
    });
    const names = (item?.contractors ?? []).map((c) => c.contractorName);
    expect(names).toEqual([...names].sort());
    expect(bundle.catalog.every((c) => Array.isArray(c.contractors))).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/price/i);
  });
});

describe('contractor admin conflicts', () => {
  it('refuses to lower a line under its recorded work (409 QUANTITY_BELOW_RECORDED) and allows it above', async () => {
    const reg = await register('Hotel', [{ item: fx.items.civilMetres, quantity: '20' }]);
    const line = reg.lineIds[fx.items.civilMetres] ?? '';
    expect(
      (await push(op([{ item: fx.items.civilMetres, quantity: '12', performer: viaLine(line) }])))
        .outcome,
    ).toBe('applied');
    const url = adminUrl(`/${reg.registrationId}/lines/${line}`);
    const below = await adminReq(http().patch(url)).send({ quantity: '11' });
    expect(below.status).toBe(409);
    expect(below.body.code).toBe('CONFLICT');
    expect(below.body.details).toMatchObject({
      reason: 'QUANTITY_BELOW_RECORDED',
      contractorLineId: line,
      recordedQuantity: '12',
      requestedQuantity: '11',
    });
    expect((await adminReq(http().patch(url)).send({ quantity: '12' })).status).toBe(200);
  });

  it('refuses to remove a line or a registration with recorded work (409 LINE_HAS_WORK)', async () => {
    const reg = await register('India', [
      { item: fx.items.civilMetres, quantity: '20' },
      { item: fx.items.civilPieces, quantity: '1' },
    ]);
    const metres = reg.lineIds[fx.items.civilMetres] ?? '';
    expect(
      (await push(op([{ item: fx.items.civilMetres, quantity: '1', performer: viaLine(metres) }])))
        .outcome,
    ).toBe('applied');
    const removeLine = await adminReq(
      http().delete(adminUrl(`/${reg.registrationId}/lines/${metres}`)),
    );
    expect(removeLine.status).toBe(409);
    expect(removeLine.body.details).toMatchObject({
      reason: 'LINE_HAS_WORK',
      contractorLineId: metres,
    });
    const removeRegistration = await adminReq(http().delete(adminUrl(`/${reg.registrationId}`)));
    expect(removeRegistration.status).toBe(409);
    expect(removeRegistration.body.details).toMatchObject({ reason: 'LINE_HAS_WORK' });
    // A line nobody worked on still goes.
    const free = reg.lineIds[fx.items.civilPieces] ?? '';
    expect(
      (await adminReq(http().delete(adminUrl(`/${reg.registrationId}/lines/${free}`)))).status,
    ).toBe(200);
  });
});

describe('work date (ADR-057)', () => {
  // Every test registers its contractor on 2026-11-01 (see `register`).
  it('records an earlier day the supervisor picked, and refuses a day after today (Cairo)', async () => {
    const operation = op(
      [{ item: fx.items.civilMetres, quantity: '1', performer: self }],
      'civil',
      '2026-01-15',
    );
    expect((await push(operation)).outcome).toBe('applied');
    const { rows } = await ctx.pool.query<{ work_date: string }>(
      `SELECT to_char(work_date, 'YYYY-MM-DD') AS work_date FROM execution_updates WHERE client_op_id = $1`,
      [operation.clientOpId],
    );
    expect(rows[0]?.work_date).toBe('2026-01-15');

    const tomorrow = shiftDay(workDayOf(new Date()), 1);
    const future = await push(
      op([{ item: fx.items.civilMetres, quantity: '1', performer: self }], 'civil', tomorrow),
    );
    expect(future).toMatchObject({ outcome: 'rejected', code: 'WORK_DATE_IN_FUTURE' });
  });

  it('keeps the Cairo day of capturedAt when the phone sends no work date', async () => {
    const operation = op([{ item: fx.items.civilMetres, quantity: '1', performer: self }]);
    expect((await push(operation)).outcome).toBe('applied');
    const { rows } = await ctx.pool.query<{ work_date: string }>(
      `SELECT to_char(work_date, 'YYYY-MM-DD') AS work_date FROM execution_updates WHERE client_op_id = $1`,
      [operation.clientOpId],
    );
    expect(rows[0]?.work_date).toBe(workDayOf(new Date(operation.capturedAt)));
  });

  it('refuses a contractor before his registration day and accepts him from that day', async () => {
    const reg = await register('Kilo', [{ item: fx.items.civilMetres, quantity: '2' }]);
    const line = reg.lineIds[fx.items.civilMetres] ?? '';
    const before = await push(
      op(
        [{ item: fx.items.civilMetres, quantity: '1', performer: viaLine(line) }],
        'civil',
        '2026-10-31',
      ),
    );
    expect(before).toMatchObject({
      outcome: 'rejected',
      code: 'CONTRACTOR_NOT_REGISTERED_ON_DATE',
    });
    const sameDay = await push(
      op(
        [{ item: fx.items.civilMetres, quantity: '1', performer: viaLine(line) }],
        'civil',
        '2026-11-01',
      ),
    );
    expect(sameDay.outcome).toBe('applied');
  });

  it('refuses at the database a contractor line on an update dated before his registration (backstop)', async () => {
    const reg = await register('Lima', [{ item: fx.items.civilMetres, quantity: '2' }]);
    const line = reg.lineIds[fx.items.civilMetres] ?? '';
    const operation = op(
      [{ item: fx.items.civilMetres, quantity: '1', performer: self }],
      'civil',
      '2026-10-01',
    );
    expect((await push(operation)).outcome).toBe('applied');
    const { rows } = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM execution_updates WHERE client_op_id = $1`,
      [operation.clientOpId],
    );
    await expect(
      ctx.pool.query(
        `INSERT INTO execution_update_lines
           (update_id, project_id, line_no, role, work_order_item_id, quantity, performer, contractor_line_id)
         VALUES ($1, $2, 900, 'work', $3, '1', 'contractor', $4)`,
        [rows[0]?.id, fx.projectId, fx.items.civilMetres, line],
      ),
    ).rejects.toThrow(/contractor not registered on the work date/);
  });

  it('gives the phone the registration date of each contractor line', async () => {
    // C-02 (work order 10): 9 above, plus 1 here.
    const reg = await register('Mike', [{ item: fx.items.civilPieces, quantity: '1' }]);
    const res = await http()
      .get(`/projects/${fx.projectId}/sync/bootstrap`)
      .set('Authorization', `Bearer ${fx.tokens.supervisorA}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bundle = OfflineBundleSchema.parse(res.body);
    const found = bundle.catalog
      .flatMap((item) => item.contractors)
      .find((c) => c.contractorLineId === reg.lineIds[fx.items.civilPieces]);
    expect(found?.registeredOn).toBe('2026-11-01');
  });
});
