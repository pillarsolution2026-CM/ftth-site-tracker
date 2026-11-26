import { createHash, randomUUID } from 'node:crypto';
import { SyncPushResponseSchema, type OpResult } from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createExecutionFixture,
  E0,
  N0,
  publishRevision,
  type ExecutionFixture,
} from './support/execution-fixtures.js';
import { ensureMember, loginAs } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

/**
 * ADR-058 (ADR-040 part I): the supervisor records on the Secondary drawings of his sites too, and
 * a cabinet shared by the General and a Secondary (same name, same site) takes its work in one
 * drawing only: the first drawing with work on it that was not rejected.
 */

let ctx: TestContext;
let fx: ExecutionFixture;
let supervisorC: string;
let supervisorA: string;
/** Site C: a General and two Secondary drawings sharing cabinets «1-7» and «1-8». */
const ids = {
  generalCab17: randomUUID(),
  generalCab18: randomUUID(),
  secondaryCab17: randomUUID(),
  secondaryCab18: randomUUID(),
  secondaryBox: randomUUID(),
  secondaryRoute: randomUUID(),
  secondary2Cab17: randomUUID(),
};
let revGeneral: string;
let revSecondary: string;
let revSecondary2: string;

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  fx = await createExecutionFixture(ctx);
  const siteC = randomUUID();
  await ctx.pool.query(
    `INSERT INTO work_order_sites (id, project_id, work_order_id, name, name_key, position)
     VALUES ($1, $2, $3, $4, $4, 3)`,
    [siteC, fx.projectId, fx.workOrderId, `Site C ${siteC.slice(0, 8)}`],
  );
  const at = (dx: number, dy: number) => `POINT(${E0 + 2000 + dx} ${N0 + dy})`;
  revGeneral = await publishRevision(
    ctx.pool,
    fx.projectId,
    [
      { id: ids.generalCab17, type: 'cabinet', wkt: at(0, 0), code: '1-7', isNew: true },
      { id: ids.generalCab18, type: 'cabinet', wkt: at(30, 0), code: '1-8', isNew: true },
    ],
    1,
    'general',
    { siteId: siteC },
  );
  // The Secondary writes the name with other spacing and case: still the same cabinet.
  revSecondary = await publishRevision(
    ctx.pool,
    fx.projectId,
    [
      { id: ids.secondaryCab17, type: 'cabinet', wkt: at(2, 1), code: ' 1-7 ', isNew: true },
      { id: ids.secondaryCab18, type: 'cabinet', wkt: at(31, 1), code: '1-8', isNew: true },
      { id: ids.secondaryBox, type: 'box', wkt: at(10, 10), code: '1-7/1', isNew: true },
      {
        id: ids.secondaryRoute,
        type: 'route',
        wkt: `LINESTRING(${E0 + 2000} ${N0}, ${E0 + 2010} ${N0 + 10})`,
        isNew: true,
      },
    ],
    1,
    'secondary',
    { siteId: siteC },
  );
  // A second Secondary of the same site (ADR-049: one or more Secondary drawings per site).
  revSecondary2 = await publishRevision(
    ctx.pool,
    fx.projectId,
    [{ id: ids.secondary2Cab17, type: 'cabinet', wkt: at(1, 2), code: '1-7', isNew: true }],
    1,
    'secondary',
    { siteId: siteC, newDrawingOrdinal: 2 },
  );
  const tag = siteC.slice(0, 8);
  await ensureMember(ctx.pool, {
    email: `sec-c-${tag}@ftth.local`,
    password: 'Sec#c12345',
    role: 'supervisor',
    projectId: fx.projectId,
    siteIds: [siteC],
  });
  supervisorC = await loginAs(ctx, `sec-c-${tag}@ftth.local`, 'Sec#c12345');
  supervisorA = fx.tokens.supervisorA;
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

const http = () => request(ctx.app.getHttpServer());

function jpeg(size = 3000): Buffer {
  const bytes = Buffer.alloc(size, 7);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

function op(featureId: string, designRevisionId: string) {
  const photo = jpeg();
  const now = new Date().toISOString();
  return {
    kind: 'execution_update.record',
    clientOpId: randomUUID(),
    capturedAt: now,
    payload: {
      featureId,
      designRevisionId,
      workType: 'civil',
      lines: [
        {
          workOrderItemId: fx.items.civilPieces,
          quantity: '1',
          role: 'work',
          performer: { kind: 'self' },
        },
      ],
      label: null,
      note: null,
      gps: null,
      photos: [
        {
          photoId: randomUUID(),
          requirementKey: 'general',
          sha256: createHash('sha256').update(photo).digest('hex'),
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

async function pushOne(token: string, operation: unknown): Promise<OpResult> {
  const res = await http()
    .post(`/projects/${fx.projectId}/sync/push`)
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId: randomUUID(), ops: [operation] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const [result] = SyncPushResponseSchema.parse(res.body).results;
  if (!result) throw new Error('no result');
  return result;
}

describe('recording on a Secondary drawing (ADR-058)', () => {
  it('applies updates on a box and a route of a published Secondary of his site', async () => {
    expect(await pushOne(supervisorC, op(ids.secondaryBox, revSecondary))).toMatchObject({
      outcome: 'applied',
    });
    expect(await pushOne(supervisorC, op(ids.secondaryRoute, revSecondary))).toMatchObject({
      outcome: 'applied',
    });
  });

  it('keeps the site scope on a Secondary', async () => {
    expect(await pushOne(supervisorA, op(ids.secondaryBox, revSecondary))).toMatchObject({
      outcome: 'rejected',
      code: 'FEATURE_OUT_OF_SCOPE',
    });
  });

  it('records a shared cabinet in the first drawing with work on it only', async () => {
    // First work on «1-7» is on the General: the General owns it.
    expect(await pushOne(supervisorC, op(ids.generalCab17, revGeneral))).toMatchObject({
      outcome: 'applied',
    });
    expect(await pushOne(supervisorC, op(ids.generalCab17, revGeneral))).toMatchObject({
      outcome: 'applied',
    });
    for (const [feature, revision] of [
      [ids.secondaryCab17, revSecondary],
      [ids.secondary2Cab17, revSecondary2],
    ] as const) {
      expect(await pushOne(supervisorC, op(feature, revision))).toMatchObject({
        outcome: 'rejected',
        code: 'CABINET_RECORDED_IN_OTHER_DRAWING',
      });
    }
    // «1-8»: the Secondary goes first and owns it; the General is refused.
    expect(await pushOne(supervisorC, op(ids.secondaryCab18, revSecondary))).toMatchObject({
      outcome: 'applied',
    });
    expect(await pushOne(supervisorC, op(ids.generalCab18, revGeneral))).toMatchObject({
      outcome: 'rejected',
      code: 'CABINET_RECORDED_IN_OTHER_DRAWING',
    });
  });

  it('frees the cabinet when all the work on it in the other drawing is rejected', async () => {
    await ctx.pool.query(
      `UPDATE execution_updates SET status = 'rejected', review_reason = 'test'
       WHERE project_id = $1 AND feature_id = $2`,
      [fx.projectId, ids.secondaryCab18],
    );
    expect(await pushOne(supervisorC, op(ids.generalCab18, revGeneral))).toMatchObject({
      outcome: 'applied',
    });
  });
});
