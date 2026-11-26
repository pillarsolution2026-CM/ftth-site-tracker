import { randomUUID } from 'node:crypto';
import {
  ContractorAccountListResponseSchema,
  ContractorAccountSchema,
  ContractorPortalResponseSchema,
  MeResponseSchema,
  TokenPairSchema,
  type ContractorPortalResponse,
} from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createApprovedContract,
  createProjectIn,
  createWorkOrderFrom,
} from './support/contract-fixtures.js';
import { publishRevision } from './support/execution-fixtures.js';
import { ensureMember, loginAs, SEED_LOGINS } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

/**
 * ADR-053: login accounts of contractors (create, list, stop, restart) and the contractor's own
 * read-only view. Real PostGIS, as everywhere. Quantities stay within the work-order quantities
 * (per-scope cap of migration 0013) and every update's work type matches its items'.
 */
let ctx: TestContext;

const http = () => request(ctx.app.getHttpServer());
const as = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
const PASSWORD = 'Portal#12345';
const CONTRACT_PRICE = '777.77';
const CONTACT_PHONE = '01099887766';
const DEVICE = randomUUID();
const tag = randomUUID().slice(0, 8);

interface Registered {
  contractorId: string;
  registrationId: string;
  lineIds: Record<string, string>;
}

interface World {
  /** Project 1: C-01 (100 m) and C-02 (10 pcs); project 2: C-02 (10 pcs). */
  p1: string;
  p2: string;
  items: { p1Metres: string; p1Pieces: string; p2Pieces: string };
  rev1: string;
  rev2: string;
  /** Box '1-1' and a route without a code, in project 1; a box '2-1' in project 2. */
  box1: string;
  route1: string;
  box2: string;
  tokens: { admin: string; pm1: string; pm2: string; qc1: string; supervisor1: string };
  userIds: { pm1: string; supervisor1: string; admin: string };
}

let world: World;
let alpha: Registered;
let beta: Registered;
let alphaOnP2: Registered;

async function userId(email: string): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    email,
  ]);
  return rows[0]?.id ?? '';
}

async function member(
  key: string,
  role: 'pm' | 'qc' | 'supervisor',
  projectId: string,
  zoneId?: string,
): Promise<string> {
  const email = `portal-${key}-${tag}@ftth.local`;
  await ensureMember(ctx.pool, {
    email,
    password: PASSWORD,
    role,
    projectId,
    ...(zoneId ? { zoneId } : {}),
  });
  return email;
}

/** A contractor registered on the project's work order, with dated prices per line. */
async function register(
  projectId: string,
  contractorId: string | null,
  name: string,
  lines: { item: string; quantity: string; prices: [string, string][] }[],
): Promise<Registered> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    let id = contractorId;
    if (!id) {
      const contractor = await client.query<{ id: string }>(
        `INSERT INTO contractors (name, contact_name, contact_phone)
         VALUES ($1, 'Contact Person', $2) RETURNING id`,
        [`${name} ${tag}`, CONTACT_PHONE],
      );
      id = contractor.rows[0]?.id ?? '';
    }
    const order = await client.query<{ id: string }>(
      `SELECT id FROM work_orders WHERE project_id = $1`,
      [projectId],
    );
    const registration = await client.query<{ id: string }>(
      `INSERT INTO contractor_registrations (project_id, work_order_id, contractor_id, registered_on)
       VALUES ($1, $2, $3, '2026-10-01') RETURNING id`,
      [projectId, order.rows[0]?.id, id],
    );
    const registrationId = registration.rows[0]?.id ?? '';
    const lineIds: Record<string, string> = {};
    for (const line of lines) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO contractor_lines (project_id, registration_id, work_order_item_id, quantity)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [projectId, registrationId, line.item, line.quantity],
      );
      const lineId = inserted.rows[0]?.id ?? '';
      lineIds[line.item] = lineId;
      for (const [effectiveFrom, unitPrice] of line.prices) {
        await client.query(
          `INSERT INTO contractor_line_prices (contractor_line_id, effective_from, unit_price)
           VALUES ($1, $2, $3)`,
          [lineId, effectiveFrom, unitPrice],
        );
      }
    }
    await client.query('COMMIT');
    return { contractorId: id, registrationId, lineIds };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface RecordedWork {
  projectId: string;
  revisionId: string;
  featureId: string;
  featureType: string;
  capturedAt: string;
  /** ADR-057: the day the supervisor picked; default the Cairo day of `capturedAt`. */
  workDate?: string;
  status?: 'pending' | 'approved' | 'rejected';
  reason?: string;
  lines: { item: string; quantity: string; contractorLineId: string | null }[];
}

/** An execution update written with SQL, so the day and the status are exactly what the test needs. */
async function recordWork(work: RecordedWork): Promise<string> {
  const op = randomUUID();
  await ctx.pool.query(
    `INSERT INTO sync_operations (client_op_id, project_id, user_id, device_id, kind, payload_sha256, result)
     VALUES ($1, $2, $3, $4, 'execution_update.record', repeat('a', 64), '{}')`,
    [op, work.projectId, world.userIds.supervisor1, DEVICE],
  );
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO execution_updates (project_id, client_op_id, feature_id, feature_type,
                                    design_revision_id, work_type, user_id, device_id, captured_at,
                                    work_date, note, label)
     VALUES ($1, $2, $3, $4, $5, 'civil', $6, $7, $8,
             COALESCE($9::date, ($8::timestamptz AT TIME ZONE 'Africa/Cairo')::date),
             'secret note', 'secret label')
     RETURNING id`,
    [
      work.projectId,
      op,
      work.featureId,
      work.featureType,
      work.revisionId,
      world.userIds.supervisor1,
      DEVICE,
      work.capturedAt,
      work.workDate ?? null,
    ],
  );
  const updateId = rows[0]?.id ?? '';
  let lineNo = 0;
  for (const line of work.lines) {
    lineNo += 1;
    await ctx.pool.query(
      `INSERT INTO execution_update_lines
         (update_id, project_id, line_no, role, work_order_item_id, quantity, performer, contractor_line_id)
       VALUES ($1, $2, $3, 'work', $4, $5, $6, $7)`,
      [
        updateId,
        work.projectId,
        lineNo,
        line.item,
        line.quantity,
        line.contractorLineId ? 'contractor' : 'self',
        line.contractorLineId,
      ],
    );
  }
  if (work.status && work.status !== 'pending') {
    await ctx.pool.query(
      `UPDATE execution_updates SET status = $2, review_reason = $3 WHERE id = $1`,
      [updateId, work.status, work.reason ?? null],
    );
  }
  return updateId;
}

const accountsUrl = (projectId: string, registrationId: string, suffix = '') =>
  `/admin/projects/${projectId}/contractors/${registrationId}/accounts${suffix}`;

async function createAccount(
  token: string,
  registration: Registered,
  email: string,
  projectId = world.p1,
  displayName = 'Contractor Person',
) {
  return as(token)(http().post(accountsUrl(projectId, registration.registrationId))).send({
    email,
    displayName,
    password: PASSWORD,
    locale: 'ar',
  });
}

const login = (email: string, password = PASSWORD) =>
  http().post('/auth/login').send({ email, password });

async function portal(email: string): Promise<request.Response> {
  const token = await loginAs(ctx, email, PASSWORD);
  return as(token)(http().get('/contractor/me'));
}

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  const contract = await createApprovedContract(ctx.pool, [
    { code: 'C-01', unit: 'م', quantity: '100', unitPrice: CONTRACT_PRICE, workType: 'civil' },
    // Two work orders (one per project) take C-02, so the contract holds both (10 + 10).
    { code: 'C-02', unit: 'عدد', quantity: '20', unitPrice: CONTRACT_PRICE, workType: 'civil' },
  ]);
  const p1 = await createProjectIn(ctx.pool, contract.contractId, `Portal one ${tag}`);
  const p2 = await createProjectIn(ctx.pool, contract.contractId, `Portal two ${tag}`);
  const wo1 = await createWorkOrderFrom(ctx.pool, p1, contract, { 'C-01': '100', 'C-02': '10' });
  const wo2 = await createWorkOrderFrom(ctx.pool, p2, contract, { 'C-02': '10' });

  const box1 = randomUUID();
  const route1 = randomUUID();
  const box2 = randomUUID();
  const rev1 = await publishRevision(
    ctx.pool,
    p1,
    [
      { id: route1, type: 'route', wkt: 'LINESTRING(330000 3340000, 330100 3340000)', isNew: true },
      { id: box1, type: 'box', wkt: 'POINT(330050 3340005)', code: '1-1', isNew: true },
    ],
    1,
  );
  const rev2 = await publishRevision(
    ctx.pool,
    p2,
    [{ id: box2, type: 'box', wkt: 'POINT(330050 3340005)', code: '2-1', isNew: true }],
    1,
  );
  const zone = (
    await ctx.pool.query<{ id: string }>(
      `INSERT INTO zones (project_id, name, geom)
       VALUES ($1, 'Zone', ST_Multi(ST_MakeEnvelope(329990, 3339990, 330200, 3340200, 32636)))
       RETURNING id`,
      [p1],
    )
  ).rows[0]?.id;

  const pm1 = await member('pm1', 'pm', p1);
  const pm2 = await member('pm2', 'pm', p2);
  const qc1 = await member('qc1', 'qc', p1);
  const supervisor1 = await member('sup1', 'supervisor', p1, zone);

  world = {
    p1,
    p2,
    items: {
      p1Metres: wo1.itemIdsByCode['C-01'] ?? '',
      p1Pieces: wo1.itemIdsByCode['C-02'] ?? '',
      p2Pieces: wo2.itemIdsByCode['C-02'] ?? '',
    },
    rev1,
    rev2,
    box1,
    route1,
    box2,
    tokens: {
      admin: await loginAs(ctx, ...SEED_LOGINS.admin),
      pm1: await loginAs(ctx, pm1, PASSWORD),
      pm2: await loginAs(ctx, pm2, PASSWORD),
      qc1: await loginAs(ctx, qc1, PASSWORD),
      supervisor1: await loginAs(ctx, supervisor1, PASSWORD),
    },
    userIds: {
      pm1: await userId(pm1),
      supervisor1: await userId(supervisor1),
      admin: await userId(SEED_LOGINS.admin[0]),
    },
  };

  // Alpha: C-01 40 m with a price change on 2026-11-10; also on project 2 (C-02, 3 pcs).
  alpha = await register(p1, null, 'Alpha', [
    {
      item: world.items.p1Metres,
      quantity: '40',
      prices: [
        ['2026-10-01', '10'],
        ['2026-11-10', '12.5'],
      ],
    },
  ]);
  alphaOnP2 = await register(p2, alpha.contractorId, 'Alpha', [
    { item: world.items.p2Pieces, quantity: '3', prices: [['2026-10-01', '5']] },
  ]);
  // Beta: another contractor on project 1 (C-02, 5 pcs at 7).
  beta = await register(p1, null, 'Beta', [
    { item: world.items.p1Pieces, quantity: '5', prices: [['2026-10-01', '7']] },
  ]);
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

describe('accounts of a contractor', () => {
  it('lets the admin create accounts and list them', async () => {
    const byAdmin = await createAccount(world.tokens.admin, alpha, `adm-${tag}@alpha.test`);
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(201);
    const created = ContractorAccountSchema.parse(byAdmin.body);
    expect(created).toMatchObject({ email: `adm-${tag}@alpha.test`, isActive: true, locale: 'ar' });
    // Neither the password nor its hash is ever returned.
    expect(JSON.stringify(byAdmin.body)).not.toMatch(/password|argon/i);

    const second = await createAccount(
      world.tokens.admin,
      alpha,
      `second-${tag}@alpha.test`,
      world.p1,
      'B',
    );
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    const list = await as(world.tokens.admin)(
      http().get(accountsUrl(world.p1, alpha.registrationId)),
    );
    expect(list.status).toBe(200);
    const parsed = ContractorAccountListResponseSchema.parse(list.body);
    expect(parsed.contractorId).toBe(alpha.contractorId);
    expect(parsed.items.map((item) => item.email).sort()).toEqual(
      [`adm-${tag}@alpha.test`, `second-${tag}@alpha.test`].sort(),
    );

    // Accounts belong to the contractor: the same list shows from his registration on project 2.
    const fromP2 = await as(world.tokens.admin)(
      http().get(accountsUrl(world.p2, alphaOnP2.registrationId)),
    );
    expect(ContractorAccountListResponseSchema.parse(fromP2.body).items).toHaveLength(2);

    // It is a non-admin user without any assignment, and the event keeps no password.
    const row = await ctx.pool.query(
      `SELECT u.is_admin, (SELECT count(*) FROM assignments a WHERE a.user_id = u.id)::int AS assignments,
              c.created_by
       FROM users u JOIN contractor_accounts c ON c.user_id = u.id WHERE u.id = $1`,
      [created.userId],
    );
    expect(row.rows[0]).toEqual({
      is_admin: false,
      assignments: 0,
      created_by: world.userIds.admin,
    });
    const events = await ctx.pool.query<{ type: string; actor_id: string; payload: unknown }>(
      `SELECT type, actor_id, payload FROM events WHERE entity_id = $1`,
      [created.userId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      type: 'contractor_account.created',
      actor_id: world.userIds.admin,
    });
    expect(events.rows[0]?.payload).toMatchObject({
      contractorId: alpha.contractorId,
      userId: created.userId,
    });
    expect(JSON.stringify(events.rows[0]?.payload)).not.toContain(PASSWORD);
  });

  it('answers 409 EMAIL_TAKEN for an email that exists (any case)', async () => {
    const email = `dup-${tag}@alpha.test`;
    expect((await createAccount(world.tokens.admin, alpha, email)).status).toBe(201);
    const again = await createAccount(world.tokens.admin, alpha, email.toUpperCase());
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: 'EMAIL_TAKEN' });
    // An existing normal user's email is taken too.
    const taken = await createAccount(world.tokens.admin, alpha, SEED_LOGINS.supervisor[0]);
    expect(taken.status).toBe(409);
  });

  it('refuses the PM (even of the project), the QC, the supervisor, a contractor account and anonymous callers', async () => {
    const own = `own-${tag}@alpha.test`;
    expect((await createAccount(world.tokens.admin, alpha, own)).status).toBe(201);
    const contractorToken = await loginAs(ctx, own, PASSWORD);
    const url = accountsUrl(world.p1, alpha.registrationId);
    for (const token of [
      world.tokens.pm1,
      world.tokens.pm2,
      world.tokens.qc1,
      world.tokens.supervisor1,
      contractorToken,
    ]) {
      expect((await as(token)(http().get(url))).status).toBe(403);
      expect(
        (
          await as(token)(http().post(url)).send({
            email: `no-${randomUUID().slice(0, 6)}@x.test`,
            displayName: 'No',
            password: PASSWORD,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await as(token)(http().patch(`${url}/${world.userIds.supervisor1}`)).send({
            isActive: false,
          })
        ).status,
      ).toBe(403);
    }
    expect((await http().get(url)).status).toBe(401);
    const { rows } = await ctx.pool.query(`SELECT 1 FROM users WHERE email LIKE 'no-%@x.test'`);
    expect(rows).toEqual([]);
  });

  it('answers 404 for a registration of another project (no oracle)', async () => {
    // The registration exists, but on project 2.
    for (const token of [world.tokens.admin]) {
      const get = await as(token)(http().get(accountsUrl(world.p1, alphaOnP2.registrationId)));
      expect(get.status).toBe(404);
      const post = await createAccount(token, alphaOnP2, `x-${tag}@alpha.test`, world.p1);
      expect(post.status).toBe(404);
      const unknown = await as(token)(http().get(accountsUrl(world.p1, randomUUID())));
      expect(unknown.status).toBe(404);
    }
    const { rows } = await ctx.pool.query(`SELECT 1 FROM users WHERE email = $1`, [
      `x-${tag}@alpha.test`,
    ]);
    expect(rows).toEqual([]);
  });

  it('stops an account (no login, sessions revoked) and restarts it', async () => {
    const email = `stop-${tag}@alpha.test`;
    const created = ContractorAccountSchema.parse(
      (await createAccount(world.tokens.admin, alpha, email)).body,
    );
    const session = TokenPairSchema.parse((await login(email)).body);
    const url = accountsUrl(world.p1, alpha.registrationId, `/${created.userId}`);

    const stopped = await as(world.tokens.admin)(http().patch(url)).send({ isActive: false });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(ContractorAccountSchema.parse(stopped.body).isActive).toBe(false);
    expect((await login(email)).status).toBe(401);
    expect(
      (await http().post('/auth/refresh').send({ refreshToken: session.refreshToken })).status,
    ).toBe(401);
    // The access token left over is refused by the portal at once.
    expect((await as(session.accessToken)(http().get('/contractor/me'))).status).toBe(403);

    const restarted = await as(world.tokens.admin)(http().patch(url)).send({ isActive: true });
    expect(ContractorAccountSchema.parse(restarted.body).isActive).toBe(true);
    expect((await login(email)).status).toBe(200);

    const types = await ctx.pool.query<{ type: string }>(
      // Logins are events on the same user too; only the account's own events are checked.
      `SELECT type FROM events WHERE entity_id = $1 AND type LIKE 'contractor_account.%' ORDER BY id`,
      [created.userId],
    );
    expect(types.rows.map((row) => row.type)).toEqual([
      'contractor_account.created',
      'contractor_account.stopped',
      'contractor_account.restarted',
    ]);
  });

  it('never lets these routes touch a user who is not an account of that contractor', async () => {
    const other = ContractorAccountSchema.parse(
      (await createAccount(world.tokens.admin, beta, `beta-${tag}@beta.test`)).body,
    );
    const targets = [
      world.userIds.supervisor1,
      world.userIds.pm1,
      world.userIds.admin,
      other.userId,
      randomUUID(),
    ];
    for (const target of targets) {
      const res = await as(world.tokens.admin)(
        http().patch(accountsUrl(world.p1, alpha.registrationId, `/${target}`)),
      ).send({ isActive: false });
      expect(res.status, `target ${target}`).toBe(404);
    }
    const { rows } = await ctx.pool.query(
      `SELECT is_active FROM users WHERE id = ANY($1::uuid[])`,
      [[world.userIds.supervisor1, world.userIds.pm1, world.userIds.admin, other.userId]],
    );
    expect(rows.every((row) => row.is_active === true)).toBe(true);
    // Malformed ids and extra fields are client errors.
    const strict = await as(world.tokens.admin)(
      http().patch(accountsUrl(world.p1, alpha.registrationId, '/not-a-uuid')),
    ).send({ isActive: false });
    expect(strict.status).toBe(400);
    const extra = await as(world.tokens.admin)(
      http().patch(accountsUrl(world.p1, alpha.registrationId, `/${other.userId}`)),
    ).send({ isActive: false, isAdmin: true });
    expect(extra.status).toBe(400);
  });
});

describe('a contractor account holds no project role and is never admin', () => {
  it('is refused an assignment (409 CONTRACTOR_ACCOUNT) and has no memberships', async () => {
    const email = `noassign-${tag}@alpha.test`;
    const created = ContractorAccountSchema.parse(
      (await createAccount(world.tokens.admin, alpha, email)).body,
    );
    const assign = await as(world.tokens.admin)(
      http().post(`/admin/projects/${world.p1}/assignments`),
    ).send({ userId: created.userId, role: 'pm', zoneId: null });
    expect(assign.status, JSON.stringify(assign.body)).toBe(409);
    expect(assign.body.code).toBe('CONFLICT');
    expect(assign.body.details).toMatchObject({ reason: 'CONTRACTOR_ACCOUNT' });

    const token = await loginAs(ctx, email, PASSWORD);
    const me = MeResponseSchema.parse((await as(token)(http().get('/auth/me'))).body);
    expect(me.memberships).toEqual([]);
    expect(me.isAdmin).toBe(false);
    expect(me.contractor).toEqual({ id: alpha.contractorId, name: `Alpha ${tag}` });
    // A contractor account cannot enter project routes either.
    expect((await as(token)(http().get(`/projects/${world.p1}/contractors`))).status).toBe(403);
    expect((await as(token)(http().get(accountsUrl(world.p1, alpha.registrationId)))).status).toBe(
      403,
    );
  });

  it('gives every other user contractor: null on /auth/me', async () => {
    const me = MeResponseSchema.parse((await as(world.tokens.pm1)(http().get('/auth/me'))).body);
    expect(me.contractor).toBeNull();
    expect(me.memberships).toHaveLength(1);
  });

  it('refuses at the database what the API would not let through (backstop)', async () => {
    const email = `backstop-${tag}@alpha.test`;
    const created = ContractorAccountSchema.parse(
      (await createAccount(world.tokens.admin, alpha, email)).body,
    );
    await expect(
      ctx.pool.query(`INSERT INTO assignments (user_id, project_id, role) VALUES ($1, $2, 'pm')`, [
        created.userId,
        world.p1,
      ]),
    ).rejects.toThrow(/contractor account cannot hold a project assignment/);
    await expect(
      ctx.pool.query(`UPDATE users SET is_admin = true WHERE id = $1`, [created.userId]),
    ).rejects.toThrow(/contractor account cannot be an admin/);
    // The other direction: an admin or a user with an assignment cannot become an account.
    await expect(
      ctx.pool.query(`INSERT INTO contractor_accounts (user_id, contractor_id) VALUES ($1, $2)`, [
        world.userIds.admin,
        alpha.contractorId,
      ]),
    ).rejects.toThrow(/contractor account cannot be an admin/);
    await expect(
      ctx.pool.query(`INSERT INTO contractor_accounts (user_id, contractor_id) VALUES ($1, $2)`, [
        world.userIds.pm1,
        alpha.contractorId,
      ]),
    ).rejects.toThrow(/contractor account cannot hold a project assignment/);
  });
});

describe('GET /contractor/me', () => {
  const alphaEmail = `portal-alpha-${tag}@alpha.test`;
  const betaEmail = `portal-beta-${tag}@beta.test`;
  let view: ContractorPortalResponse;
  let raw: string;

  beforeAll(async () => {
    expect((await createAccount(world.tokens.admin, alpha, alphaEmail)).status).toBe(201);
    expect((await createAccount(world.tokens.admin, beta, betaEmail)).status).toBe(201);
    const alphaLine = alpha.lineIds[world.items.p1Metres] ?? '';
    const base = { projectId: world.p1, revisionId: world.rev1 };
    // 23:30 in Cairo on 9 Nov (21:30 UTC): the day before the price change.
    await recordWork({
      ...base,
      featureId: world.box1,
      featureType: 'box',
      capturedAt: '2026-11-09T21:30:00Z',
      lines: [{ item: world.items.p1Metres, quantity: '2', contractorLineId: alphaLine }],
    });
    // 00:30 in Cairo on 10 Nov (22:30 UTC on the 9th): the day of the price change.
    await recordWork({
      ...base,
      featureId: world.box1,
      featureType: 'box',
      capturedAt: '2026-11-09T22:30:00Z',
      status: 'approved',
      lines: [{ item: world.items.p1Metres, quantity: '4', contractorLineId: alphaLine }],
    });
    // ADR-057: saved on 20 Nov under the work date 5 Oct, which sets the price. Rejected, with
    // the reviewer's reason.
    await recordWork({
      ...base,
      featureId: world.route1,
      featureType: 'route',
      capturedAt: '2026-11-20T10:00:00Z',
      workDate: '2026-10-05',
      status: 'rejected',
      reason: 'Depth not as drawn',
      lines: [{ item: world.items.p1Metres, quantity: '1.5', contractorLineId: alphaLine }],
    });
    // A quantity whose value has many decimals: exact, not rounded.
    await recordWork({
      ...base,
      featureId: world.box1,
      featureType: 'box',
      capturedAt: '2026-11-15T08:00:00Z',
      lines: [{ item: world.items.p1Metres, quantity: '0.3333', contractorLineId: alphaLine }],
    });
    // Same update: the own crew on the same line and another contractor's work never show up.
    await recordWork({
      ...base,
      featureId: world.box1,
      featureType: 'box',
      capturedAt: '2026-11-16T08:00:00Z',
      lines: [
        { item: world.items.p1Metres, quantity: '5', contractorLineId: null },
        {
          item: world.items.p1Pieces,
          quantity: '2',
          contractorLineId: beta.lineIds[world.items.p1Pieces] ?? '',
        },
      ],
    });
    // Alpha on project 2.
    await recordWork({
      projectId: world.p2,
      revisionId: world.rev2,
      featureId: world.box2,
      featureType: 'box',
      capturedAt: '2026-11-12T08:00:00Z',
      status: 'approved',
      lines: [
        {
          item: world.items.p2Pieces,
          quantity: '1',
          contractorLineId: alphaOnP2.lineIds[world.items.p2Pieces] ?? '',
        },
      ],
    });
    const res = await portal(alphaEmail);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    view = ContractorPortalResponseSchema.parse(res.body);
    raw = JSON.stringify(res.body);
  }, 120_000);

  it('shows only his own registrations, lines and prices', () => {
    expect(view.contractor).toEqual({ id: alpha.contractorId, name: `Alpha ${tag}` });
    expect(view.registrations.map((r) => r.registrationId).sort()).toEqual(
      [alpha.registrationId, alphaOnP2.registrationId].sort(),
    );
    const one = view.registrations.find((r) => r.registrationId === alpha.registrationId);
    expect(one).toMatchObject({
      projectId: world.p1,
      projectName: `Portal one ${tag}`,
      currency: 'EGP',
      registeredOn: '2026-10-01',
    });
    expect(one?.workOrderNumber).toMatch(/^WO-/);
    expect(one?.lines).toEqual([
      {
        contractorLineId: alpha.lineIds[world.items.p1Metres],
        code: 'C-01',
        description: 'Test item C-01',
        unit: 'م',
        scope: null,
        quantity: '40',
        prices: [
          { effectiveFrom: '2026-10-01', unitPrice: '10' },
          { effectiveFrom: '2026-11-10', unitPrice: '12.5' },
        ],
        // pending 2 + approved 4 + pending 0.3333; the rejected 1.5 is not counted.
        recordedQuantity: '6.3333',
      },
    ]);
    const two = view.registrations.find((r) => r.registrationId === alphaOnP2.registrationId);
    expect(two?.projectName).toBe(`Portal two ${tag}`);
    expect(two?.lines[0]?.prices).toEqual([{ effectiveFrom: '2026-10-01', unitPrice: '5' }]);
    // Nothing of Beta.
    expect(raw).not.toContain(beta.registrationId);
    expect(raw).not.toContain(beta.contractorId);
    expect(raw).not.toContain(`Beta ${tag}`);
  });

  it('prices each work line by its work date (Cairo), newest first', () => {
    expect(view.work.map((w) => [w.workDate, w.quantity, w.unitPrice, w.value, w.status])).toEqual([
      ['2026-11-15', '0.3333', '12.5', '4.16625', 'pending'],
      ['2026-11-12', '1', '5', '5', 'approved'],
      // 22:30 UTC on 9 Nov is 00:30 on 10 Nov in Cairo: the new price already applies.
      ['2026-11-10', '4', '12.5', '50', 'approved'],
      // 21:30 UTC on 9 Nov is 23:30 on 9 Nov in Cairo: still the old price.
      ['2026-11-09', '2', '10', '20', 'pending'],
      // Saved on 20 Nov under the work date 5 Oct: the price of 5 Oct (ADR-057).
      ['2026-10-05', '1.5', '10', '15', 'rejected'],
    ]);
  });

  it('describes the element, the key and the reason of rejected work only', () => {
    const rejected = view.work.find((w) => w.status === 'rejected');
    expect(rejected).toMatchObject({
      reviewReason: 'Depth not as drawn',
      element: { featureType: 'route', code: null },
      registrationId: alpha.registrationId,
      contractorLineId: alpha.lineIds[world.items.p1Metres],
    });
    expect(rejected?.key).toMatch(/^[0-9a-f-]{36}:1$/);
    const others = view.work.filter((w) => w.status !== 'rejected');
    expect(others.every((w) => w.reviewReason === null)).toBe(true);
    expect(view.work.find((w) => w.workDate === '2026-11-15')?.element).toEqual({
      featureType: 'box',
      code: '1-1',
    });
    expect(new Set(view.work.map((w) => w.key)).size).toBe(view.work.length);
  });

  it('totals the values per status, exactly', () => {
    expect(view.totals).toEqual([
      // approved 50 + 5; pending 20 + 4.16625; rejected 15.
      { currency: 'EGP', approved: '55', pending: '24.16625', rejected: '15' },
    ]);
    expect(Date.parse(view.serverTime)).not.toBeNaN();
  });

  it('shows no own-crew work, no other contractor, no client price and nothing of the site', () => {
    // 4 work lines + the project-2 one + the rejected one = 5; the own crew's 5 m and Beta's 2 pcs are not there.
    expect(view.work).toHaveLength(5);
    expect(raw).not.toContain('contractPrice');
    expect(raw).not.toContain(CONTRACT_PRICE);
    expect(raw).not.toContain(CONTACT_PHONE);
    expect(raw).not.toContain('Contact Person');
    expect(raw).not.toContain('secret note');
    expect(raw).not.toContain('secret label');
    expect(raw).not.toContain(world.userIds.supervisor1);
    expect(raw).not.toMatch(/photo|userId|supervisor|gps|device|flags|note|label/i);
  });

  it('gives a second contractor only his own view (and a contractor with no work zero totals)', async () => {
    const res = await portal(betaEmail);
    expect(res.status).toBe(200);
    const betaView = ContractorPortalResponseSchema.parse(res.body);
    expect(betaView.contractor.id).toBe(beta.contractorId);
    expect(betaView.registrations.map((r) => r.registrationId)).toEqual([beta.registrationId]);
    expect(betaView.work).toHaveLength(1);
    expect(betaView.work[0]).toMatchObject({ quantity: '2', unitPrice: '7', value: '14' });
    expect(betaView.totals).toEqual([
      { currency: 'EGP', approved: '0', pending: '14', rejected: '0' },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(alpha.registrationId);
    expect(JSON.stringify(res.body)).not.toContain(alpha.contractorId);
  });

  it('refuses every user that is not an active contractor account with 403', async () => {
    for (const token of [
      world.tokens.admin,
      world.tokens.pm1,
      world.tokens.qc1,
      world.tokens.supervisor1,
    ]) {
      const res = await as(token)(http().get('/contractor/me'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    expect((await http().get('/contractor/me')).status).toBe(401);
  });
});
