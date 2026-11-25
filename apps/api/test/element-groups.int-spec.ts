import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_ELEMENT_GROUPS,
  ELEMENT_KEYS,
  ElementGroupsResponseSchema,
  OfflineBundleSchema,
  SyncChangesResponseSchema,
  SyncPushResponseSchema,
  type OpResult,
} from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createApprovedContract,
  createProjectIn,
  createWorkOrderFrom,
} from './support/contract-fixtures.js';
import { E0, N0, publishRevision } from './support/execution-fixtures.js';
import { ensureMember, loginAs, SEED_LOGINS } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

/**
 * ADR-056: the element -> main groups map (seed, admin screen), the group and `needsDimensions` of
 * each catalog line, digging dimensions on a work line, and the «التخطيط» update recorded on a
 * drawing instead of an element. Real PostGIS, as everywhere.
 */
let ctx: TestContext;
const http = () => request(ctx.app.getHttpServer());
const DEVICE = randomUUID();
const tag = randomUUID().slice(0, 8);
/** A main group no element offers: the admin has to link it. Unique so other suites cannot clash. */
const NEW_MAIN = `مجموعة جديدة ${tag}`;

interface World {
  projectId: string;
  siteA: string;
  siteB: string;
  /** General and Secondary drawings of site A, General of site B. */
  drawingGeneralA: string;
  drawingSecondaryA: string;
  drawingB: string;
  revisionGeneralA: string;
  revisionSecondaryA: string;
  revisionB: string;
  boxA: string;
  items: {
    digging: string;
    diggingMetres: string;
    planning: string;
    fresh: string;
  };
  tokens: { supervisorA: string; supervisorB: string; pm: string; admin: string };
}
let world: World;

const drawingOf = async (revisionId: string): Promise<string> =>
  (
    await ctx.pool.query<{ drawing_id: string }>(
      'SELECT drawing_id FROM design_revisions WHERE id = $1',
      [revisionId],
    )
  ).rows[0]?.drawing_id ?? '';

async function buildWorld(): Promise<World> {
  const { pool } = ctx;
  const contract = await createApprovedContract(pool, [
    { code: 'D-01', unit: 'م3', quantity: '1000', unitPrice: '0', workType: 'civil' },
    { code: 'D-02', unit: 'م', quantity: '1000', unitPrice: '0', workType: 'civil' },
    { code: 'P-01', unit: 'عدد', quantity: '1000', unitPrice: '0', workType: 'planning' },
    { code: 'N-01', unit: 'عدد', quantity: '1000', unitPrice: '0', workType: 'civil' },
  ]);
  // The admin's group choices (ADR-048): digging (soil), digging by metre, and a new main group.
  const choose = (code: string, main: string, sub: string | null) =>
    pool.query(
      `INSERT INTO contract_item_group_choices
         (id, contract_id, contract_item_id, main_group, sub_group)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), contract.contractId, contract.itemIds[code], main, sub],
    );
  await choose('D-01', 'حفر', 'تربة');
  await choose('D-02', 'حفر', null);
  await choose('N-01', NEW_MAIN, null);

  const projectId = await createProjectIn(pool, contract.contractId, `Element groups ${tag}`);
  const order = await createWorkOrderFrom(pool, projectId, contract, {
    'D-01': '1000',
    'D-02': '1000',
    'P-01': '1000',
    'N-01': '1000',
  });
  const site = async (name: string, position: number) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO work_order_sites (id, project_id, work_order_id, name, name_key, position)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [id, projectId, order.workOrderId, name, position],
    );
    return id;
  };
  const siteA = await site(`Site A ${tag}`, 1);
  const siteB = await site(`Site B ${tag}`, 2);

  const boxA = randomUUID();
  const revisionB = await publishRevision(
    pool,
    projectId,
    [
      {
        id: randomUUID(),
        type: 'box',
        wkt: `POINT(${E0 + 1000} ${N0 + 1000})`,
        code: '2-1',
        isNew: true,
      },
    ],
    1,
    'general',
    { siteId: siteB },
  );
  const revisionGeneralA = await publishRevision(
    pool,
    projectId,
    [{ id: boxA, type: 'box', wkt: `POINT(${E0 + 50} ${N0 + 5})`, code: '1-1', isNew: true }],
    1,
    'general',
    { siteId: siteA },
  );
  const revisionSecondaryA = await publishRevision(
    pool,
    projectId,
    [
      {
        id: randomUUID(),
        type: 'box',
        wkt: `POINT(${E0 + 60} ${N0 + 6})`,
        code: '1-2',
        isNew: true,
      },
    ],
    1,
    'secondary',
    { siteId: siteA },
  );

  const member = async (key: string, role: 'pm' | 'supervisor', siteIds: string[] = []) => {
    const email = `eg-${key}-${tag}@ftth.local`;
    const password = `Eg#${key}12345`;
    await ensureMember(pool, { email, password, role, projectId, siteIds });
    return loginAs(ctx, email, password);
  };
  return {
    projectId,
    siteA,
    siteB,
    drawingGeneralA: await drawingOf(revisionGeneralA),
    drawingSecondaryA: await drawingOf(revisionSecondaryA),
    drawingB: await drawingOf(revisionB),
    revisionGeneralA,
    revisionSecondaryA,
    revisionB,
    boxA,
    items: {
      digging: order.itemIdsByCode['D-01'] ?? '',
      diggingMetres: order.itemIdsByCode['D-02'] ?? '',
      planning: order.itemIdsByCode['P-01'] ?? '',
      fresh: order.itemIdsByCode['N-01'] ?? '',
    },
    tokens: {
      supervisorA: await member('supa', 'supervisor', [siteA]),
      supervisorB: await member('supb', 'supervisor', [siteB]),
      pm: await member('pm', 'pm'),
      admin: await loginAs(ctx, ...SEED_LOGINS.admin),
    },
  };
}

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  world = await buildWorld();
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const DIMS = { lengthM: '10', widthM: '0.35', depthM: '0.9' };

interface LineInput {
  item: string;
  quantity: string;
  dimensions?: typeof DIMS | null;
}

/** A record-update op: `featureId` null makes it a «التخطيط» update on `drawingId`. */
function op(input: {
  featureId: string | null;
  drawingId?: string | null;
  revisionId: string;
  workType?: string;
  lines: LineInput[];
}) {
  const photo = Buffer.alloc(3000, 1);
  photo.set([0xff, 0xd8, 0xff, 0xe0], 0);
  photo.set([0xff, 0xd9], photo.length - 2);
  const now = new Date().toISOString();
  return {
    kind: 'execution_update.record',
    clientOpId: randomUUID(),
    capturedAt: now,
    payload: {
      featureId: input.featureId,
      drawingId: input.drawingId ?? null,
      designRevisionId: input.revisionId,
      workType: input.workType ?? 'civil',
      lines: input.lines.map((line) => ({
        workOrderItemId: line.item,
        quantity: line.quantity,
        role: 'work',
        performer: { kind: 'self' },
        dimensions: line.dimensions ?? null,
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
      workDate: null,
    },
  };
}

async function push(token: string, operation: unknown): Promise<OpResult> {
  const res = await http()
    .post(`/projects/${world.projectId}/sync/push`)
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId: DEVICE, ops: [operation] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const [result] = SyncPushResponseSchema.parse(res.body).results;
  if (!result) throw new Error('no result');
  return result;
}

const boxOp = (lines: LineInput[]) =>
  op({ featureId: world.boxA, revisionId: world.revisionGeneralA, lines });
const planningOp = (
  drawingId: string,
  revisionId: string,
  lines: LineInput[] = [{ item: world.items.planning, quantity: '1' }],
) => op({ featureId: null, drawingId, revisionId, workType: 'planning', lines });

describe('the element -> main groups map (migration 0030)', () => {
  it('is seeded with the owner map: one row per element, version 1', async () => {
    const { rows } = await ctx.pool.query<{ element: string; mains: string[]; version: number }>(
      'SELECT element, mains, version FROM element_group_map',
    );
    expect(rows.map((row) => row.element).sort()).toEqual([...ELEMENT_KEYS].sort());
    for (const key of ELEMENT_KEYS) {
      expect(rows.find((row) => row.element === key)?.mains).toEqual([
        ...DEFAULT_ELEMENT_GROUPS[key],
      ]);
    }
    expect(new Set(rows.map((row) => row.version))).toEqual(new Set([1]));
  });

  it('refuses at the database a half-filled dimension set, and an update with neither or both targets', async () => {
    const applied = await push(
      world.tokens.supervisorA,
      boxOp([{ item: world.items.fresh, quantity: '1' }]),
    );
    expect(applied.outcome).toBe('applied');
    const updateId = applied.outcome === 'applied' ? applied.updateId : '';
    await expect(
      ctx.pool.query(
        `INSERT INTO execution_update_lines
           (update_id, project_id, line_no, role, work_order_item_id, quantity, performer, length_m)
         VALUES ($1, $2, 90, 'work', $3, 1, 'self', 2)`,
        [updateId, world.projectId, world.items.planning],
      ),
    ).rejects.toMatchObject({ constraint: 'execution_update_lines_dimensions_all_or_none' });

    // One operation row to hang the attempts on (the insert of the update itself is refused).
    const opId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO sync_operations
         (client_op_id, project_id, user_id, device_id, kind, payload_sha256, result)
       SELECT $1, $2, id, $3, 'execution_update.record', repeat('a', 64), '{}'::jsonb
       FROM users ORDER BY created_at LIMIT 1`,
      [opId, world.projectId, DEVICE],
    );
    const insertUpdate = (
      featureId: string | null,
      featureType: string | null,
      drawing: string | null,
    ) =>
      ctx.pool.query(
        `INSERT INTO execution_updates
           (id, project_id, client_op_id, feature_id, feature_type, drawing_id, design_revision_id,
            work_type, user_id, device_id, captured_at, work_date)
         SELECT $1, $2, $3, $4, $5, $6, $7, 'civil', id, $8, now(), current_date FROM users ORDER BY created_at LIMIT 1`,
        [
          randomUUID(),
          world.projectId,
          opId,
          featureId,
          featureType,
          drawing,
          world.revisionGeneralA,
          DEVICE,
        ],
      );
    await expect(insertUpdate(null, null, null)).rejects.toMatchObject({
      constraint: 'execution_updates_element_or_drawing',
    });
    await expect(insertUpdate(world.boxA, 'box', world.drawingGeneralA)).rejects.toMatchObject({
      constraint: 'execution_updates_element_or_drawing',
    });
  });
});

describe('the offline bundle (ADR-056)', () => {
  it('carries the group and needsDimensions of each line and the element map', async () => {
    const res = await http()
      .get(`/projects/${world.projectId}/sync/bootstrap`)
      .set('Authorization', `Bearer ${world.tokens.supervisorA}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bundle = OfflineBundleSchema.parse(res.body);
    const byId = (id: string) => bundle.catalog.find((entry) => entry.id === id);
    expect(byId(world.items.digging)).toMatchObject({
      group: { main: 'حفر', sub: 'تربة' },
      needsDimensions: true,
    });
    // Digging, but by the metre: no dimensions.
    expect(byId(world.items.diggingMetres)).toMatchObject({
      group: { main: 'حفر', sub: null },
      needsDimensions: false,
    });
    // Not grouped by any choice or rule.
    expect(byId(world.items.planning)).toMatchObject({ group: null, needsDimensions: false });
    expect(byId(world.items.fresh)).toMatchObject({
      group: { main: NEW_MAIN, sub: null },
      needsDimensions: false,
    });
    expect(bundle.elementGroups).toHaveLength(ELEMENT_KEYS.length);
    for (const key of ELEMENT_KEYS) {
      expect(bundle.elementGroups.find((entry) => entry.element === key)?.mains).toEqual([
        ...DEFAULT_ELEMENT_GROUPS[key],
      ]);
    }
  });
});

describe('dimensions of a digging line (ADR-056)', () => {
  it('stores them, answers them in the changes feed, and treats a resend with other dimensions as a reused op id', async () => {
    const operation = boxOp([{ item: world.items.digging, quantity: '3.15', dimensions: DIMS }]);
    const result = await push(world.tokens.supervisorA, operation);
    expect(result.outcome, JSON.stringify(result)).toBe('applied');
    const updateId = result.outcome === 'applied' ? result.updateId : '';

    const { rows } = await ctx.pool.query<{ l: string; w: string; d: string; q: string }>(
      `SELECT length_m::text AS l, width_m::text AS w, depth_m::text AS d, quantity::text AS q
       FROM execution_update_lines WHERE update_id = $1`,
      [updateId],
    );
    expect(rows).toEqual([{ l: '10.0000', w: '0.3500', d: '0.9000', q: '3.1500' }]);

    const feed = await http()
      .get(`/projects/${world.projectId}/sync/changes?cursor=0&limit=500`)
      .set('Authorization', `Bearer ${world.tokens.supervisorA}`);
    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    const update = SyncChangesResponseSchema.parse(feed.body).updates.find(
      (entry) => entry.id === updateId,
    );
    expect(update?.lines[0]).toMatchObject({ quantity: '3.15', dimensions: DIMS });
    expect(update).toMatchObject({ featureId: world.boxA, featureType: 'box', drawingId: null });

    // The same op again is a duplicate; the same id with other dimensions is not.
    expect(await push(world.tokens.supervisorA, operation)).toMatchObject({
      outcome: 'duplicate',
      updateId,
    });
    const changed = {
      ...operation,
      payload: {
        ...operation.payload,
        lines: operation.payload.lines.map((line) => ({
          ...line,
          quantity: '3.51',
          dimensions: { ...DIMS, widthM: '0.39' },
        })),
      },
    };
    expect(changed.payload.lines[0]?.dimensions.widthM).toBe('0.39');
    expect(await push(world.tokens.supervisorA, changed)).toMatchObject({
      outcome: 'rejected',
      code: 'OP_ID_REUSED',
    });
  });

  it('rejects a digging line without dimensions: DIMENSIONS_REQUIRED', async () => {
    const result = await push(
      world.tokens.supervisorA,
      boxOp([{ item: world.items.digging, quantity: '3.15' }]),
    );
    expect(result).toMatchObject({ outcome: 'rejected', code: 'DIMENSIONS_REQUIRED' });
  });

  it('rejects dimensions on a line that takes none: DIMENSIONS_NOT_ALLOWED', async () => {
    const byMetre = await push(
      world.tokens.supervisorA,
      boxOp([{ item: world.items.diggingMetres, quantity: '3.15', dimensions: DIMS }]),
    );
    expect(byMetre).toMatchObject({ outcome: 'rejected', code: 'DIMENSIONS_NOT_ALLOWED' });
    const ungrouped = await push(
      world.tokens.supervisorA,
      boxOp([{ item: world.items.fresh, quantity: '3.15', dimensions: DIMS }]),
    );
    expect(ungrouped).toMatchObject({ outcome: 'rejected', code: 'DIMENSIONS_NOT_ALLOWED' });
  });

  it('refuses a quantity that is not length x width x depth at the door (400)', async () => {
    const res = await http()
      .post(`/projects/${world.projectId}/sync/push`)
      .set('Authorization', `Bearer ${world.tokens.supervisorA}`)
      .send({
        deviceId: DEVICE,
        ops: [boxOp([{ item: world.items.digging, quantity: '4', dimensions: DIMS }])],
      });
    expect(res.status).toBe(400);
  });
});

describe('«التخطيط» updates on a drawing (ADR-056)', () => {
  it('records on the General and the Secondary drawing of the supervisor site, with no element and no GPS flag', async () => {
    for (const [drawingId, revisionId] of [
      [world.drawingGeneralA, world.revisionGeneralA],
      [world.drawingSecondaryA, world.revisionSecondaryA],
    ] as const) {
      const operation = planningOp(drawingId, revisionId);
      const result = await push(world.tokens.supervisorA, operation);
      expect(result.outcome, JSON.stringify(result)).toBe('applied');
      const updateId = result.outcome === 'applied' ? result.updateId : '';
      const { rows } = await ctx.pool.query(
        `SELECT feature_id, feature_type, drawing_id, flags, gps_distance_m
         FROM execution_updates WHERE id = $1`,
        [updateId],
      );
      expect(rows).toEqual([
        {
          feature_id: null,
          feature_type: null,
          drawing_id: drawingId,
          flags: [],
          gps_distance_m: null,
        },
      ]);
      const event = await ctx.pool.query(
        `SELECT payload FROM events WHERE entity_id = $1 AND type = 'execution_update.recorded'`,
        [updateId],
      );
      expect(event.rows[0]?.payload).toMatchObject({ featureId: null, drawingId });
    }
  });

  it('shows in the changes feed to a supervisor of that site and to the PM, not to another site', async () => {
    const operation = planningOp(world.drawingGeneralA, world.revisionGeneralA);
    const result = await push(world.tokens.supervisorA, operation);
    const updateId = result.outcome === 'applied' ? result.updateId : '';
    const feedOf = async (token: string) => {
      const res = await http()
        .get(`/projects/${world.projectId}/sync/changes?cursor=0&limit=500`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return SyncChangesResponseSchema.parse(res.body).updates;
    };
    const own = (await feedOf(world.tokens.supervisorA)).find((entry) => entry.id === updateId);
    expect(own).toMatchObject({
      featureId: null,
      featureType: null,
      drawingId: world.drawingGeneralA,
      workType: 'planning',
    });
    expect((await feedOf(world.tokens.pm)).some((entry) => entry.id === updateId)).toBe(true);
    expect((await feedOf(world.tokens.supervisorB)).some((entry) => entry.id === updateId)).toBe(
      false,
    );
  });

  it('answers DRAWING_OUT_OF_SCOPE for a drawing of another site', async () => {
    const result = await push(
      world.tokens.supervisorA,
      planningOp(world.drawingB, world.revisionB),
    );
    expect(result).toMatchObject({ outcome: 'rejected', code: 'DRAWING_OUT_OF_SCOPE' });
  });

  it('answers DRAWING_NOT_FOUND for an unknown drawing and for one of another project', async () => {
    const unknown = await push(
      world.tokens.supervisorA,
      planningOp(randomUUID(), world.revisionGeneralA),
    );
    expect(unknown).toMatchObject({ outcome: 'rejected', code: 'DRAWING_NOT_FOUND' });

    const other = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM site_drawings WHERE project_id <> $1 LIMIT 1`,
      [world.projectId],
    );
    const foreign = other.rows[0]?.id ?? randomUUID();
    const result = await push(
      world.tokens.supervisorA,
      planningOp(foreign, world.revisionGeneralA),
    );
    expect(result).toMatchObject({ outcome: 'rejected', code: 'DRAWING_NOT_FOUND' });
  });

  it('answers REVISION_NOT_PUBLISHED when the revision is not a published revision of that drawing', async () => {
    // Site A's drawing with site B's revision.
    const result = await push(
      world.tokens.supervisorA,
      planningOp(world.drawingGeneralA, world.revisionB),
    );
    expect(result).toMatchObject({ outcome: 'rejected', code: 'REVISION_NOT_PUBLISHED' });
    const unknown = await push(
      world.tokens.supervisorA,
      planningOp(world.drawingGeneralA, randomUUID()),
    );
    expect(unknown).toMatchObject({ outcome: 'rejected', code: 'REVISION_NOT_PUBLISHED' });
  });

  it('refuses at the door a planning update with neither element nor drawing (400)', async () => {
    const res = await http()
      .post(`/projects/${world.projectId}/sync/push`)
      .set('Authorization', `Bearer ${world.tokens.supervisorA}`)
      .send({
        deviceId: DEVICE,
        ops: [
          op({
            featureId: null,
            drawingId: null,
            revisionId: world.revisionGeneralA,
            lines: [{ item: world.items.planning, quantity: '1' }],
          }),
        ],
      });
    expect(res.status).toBe(400);
  });
});

describe('admin element groups (ADR-056)', () => {
  const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer ${world.tokens.admin}`);
  const reasonOf = (res: request.Response): unknown => res.body.details?.reason;
  const getAll = async () => {
    const res = await asAdmin(http().get('/admin/element-groups'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return ElementGroupsResponseSchema.parse(res.body);
  };

  it('lists the seven elements and the main groups no element offers', async () => {
    const all = await getAll();
    expect(all.elements.map((entry) => entry.element)).toEqual([...ELEMENT_KEYS]);
    expect(all.unlinked).toContainEqual({ main: NEW_MAIN, lineCount: 1 });
    expect(all.unlinked.some((entry) => entry.main === 'حفر')).toBe(false);
    expect(all.knownMains).toContain(NEW_MAIN);
    expect(all.knownMains).toContain('حفر');
    expect(all.knownMains).toEqual([...all.knownMains].sort());
  });

  it('is for platform admins only', async () => {
    for (const token of [world.tokens.pm, world.tokens.supervisorA]) {
      const res = await http().get('/admin/element-groups').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      const put = await http()
        .put('/admin/element-groups/joint')
        .set('Authorization', `Bearer ${token}`)
        .send({ mains: [], expectedVersion: 1 });
      expect(put.status).toBe(403);
    }
    expect((await http().get('/admin/element-groups')).status).toBe(401);
  });

  it('replaces an element list, bumps the version, writes the event, and links the group', async () => {
    const before = (await getAll()).elements.find((entry) => entry.element === 'joint');
    expect(before).toBeDefined();
    const mains = [...DEFAULT_ELEMENT_GROUPS.joint, NEW_MAIN];
    const res = await asAdmin(http().put('/admin/element-groups/joint')).send({
      mains,
      expectedVersion: before?.version,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = ElementGroupsResponseSchema.parse(res.body);
    expect(after.elements.find((entry) => entry.element === 'joint')).toEqual({
      element: 'joint',
      mains,
      version: (before?.version ?? 0) + 1,
    });
    expect(after.unlinked.some((entry) => entry.main === NEW_MAIN)).toBe(false);

    const events = await ctx.pool.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM events WHERE entity = 'element_groups' AND entity_id = 'joint'
       ORDER BY id DESC LIMIT 1`,
    );
    expect(events.rows[0]?.type).toBe('element_groups.changed');
    expect(events.rows[0]?.payload).toMatchObject({
      element: 'joint',
      before: before?.mains,
      after: mains,
      version: (before?.version ?? 0) + 1,
    });

    // The bundle reads the new map; then the stale version is a conflict.
    const bundle = OfflineBundleSchema.parse(
      (
        await http()
          .get(`/projects/${world.projectId}/sync/bootstrap`)
          .set('Authorization', `Bearer ${world.tokens.supervisorA}`)
      ).body,
    );
    expect(bundle.elementGroups.find((entry) => entry.element === 'joint')?.mains).toEqual(mains);

    const stale = await asAdmin(http().put('/admin/element-groups/joint')).send({
      mains: [],
      expectedVersion: before?.version,
    });
    expect(stale.status).toBe(409);
    expect(reasonOf(stale)).toBe('STALE_VERSION');
    expect(stale.body.details?.currentVersion).toBe((before?.version ?? 0) + 1);

    // Back to the seeded list so the other suites and tests see the owner map.
    const restore = await asAdmin(http().put('/admin/element-groups/joint')).send({
      mains: [...DEFAULT_ELEMENT_GROUPS.joint],
      expectedVersion: (before?.version ?? 0) + 1,
    });
    expect(restore.status).toBe(200);
  });

  it('validates the element and the list', async () => {
    const unknown = await asAdmin(http().put('/admin/element-groups/nothing')).send({
      mains: [],
      expectedVersion: 1,
    });
    expect(unknown.status).toBe(400);
    const twice = await asAdmin(http().put('/admin/element-groups/box')).send({
      mains: ['BOX', 'BOX'],
      expectedVersion: 1,
    });
    expect(twice.status).toBe(400);
    const empty = await asAdmin(http().put('/admin/element-groups/box')).send({
      mains: ['  '],
      expectedVersion: 1,
    });
    expect(empty.status).toBe(400);
  });
});
