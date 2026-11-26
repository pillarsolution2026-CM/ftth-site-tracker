import { createHash, randomUUID } from 'node:crypto';
import { SyncPushResponseSchema, UpdateListResponseSchema } from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createExecutionFixture,
  E0,
  N0,
  toWgs84,
  type ExecutionFixture,
} from './support/execution-fixtures.js';
import { createTestContext, type TestContext } from './support/test-app.js';

/**
 * ADR-059: the read-only web list of recorded updates. The PM and QC read every site; a supervisor
 * only his sites (ADR-054); a photo outside the caller's reach answers 404 like an unknown id.
 */

let ctx: TestContext;
let fx: ExecutionFixture;
let photoA: string;
let photoBytes: Buffer;
let gpsA: [number, number];

const http = () => request(ctx.app.getHttpServer());

function jpeg(size = 3000): Buffer {
  const bytes = Buffer.alloc(size, 9);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

function op(input: {
  featureId: string;
  revisionId: string;
  photoId: string;
  photo: Buffer;
  gps: [number, number] | null;
}) {
  const now = new Date().toISOString();
  return {
    kind: 'execution_update.record',
    clientOpId: randomUUID(),
    capturedAt: now,
    payload: {
      featureId: input.featureId,
      designRevisionId: input.revisionId,
      workType: 'civil',
      lines: [
        {
          workOrderItemId: fx.items.civilPieces,
          quantity: '2',
          role: 'work',
          performer: { kind: 'self' },
        },
      ],
      label: null,
      note: 'test note',
      gps: input.gps ? { lon: input.gps[0], lat: input.gps[1], accuracyM: 4, at: now } : null,
      photos: [
        {
          photoId: input.photoId,
          requirementKey: 'general',
          sha256: createHash('sha256').update(input.photo).digest('hex'),
          sizeBytes: input.photo.length,
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

async function record(token: string, operation: unknown): Promise<void> {
  const res = await http()
    .post(`/projects/${fx.projectId}/sync/push`)
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId: randomUUID(), ops: [operation] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(SyncPushResponseSchema.parse(res.body).results[0]?.outcome).toBe('applied');
}

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  fx = await createExecutionFixture(ctx);
  photoBytes = jpeg();
  photoA = randomUUID();
  gpsA = await toWgs84(ctx.pool, E0 + 50, N0 + 5);
  await record(
    fx.tokens.supervisorA,
    op({
      featureId: fx.boxA,
      revisionId: fx.revisionId,
      photoId: photoA,
      photo: photoBytes,
      gps: gpsA,
    }),
  );
  const upload = await http()
    .put(`/projects/${fx.projectId}/sync/photos/${photoA}/content`)
    .set('Authorization', `Bearer ${fx.tokens.supervisorA}`)
    .set('Content-Type', 'application/octet-stream')
    .set('Upload-Offset', '0')
    .send(photoBytes);
  expect(upload.status, JSON.stringify(upload.body)).toBe(200);
  const photoB = jpeg(2000);
  await record(
    fx.tokens.supervisorB,
    op({
      featureId: fx.boxB,
      revisionId: fx.revisionB,
      photoId: randomUUID(),
      photo: photoB,
      gps: null,
    }),
  );
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

const list = (token: string, query = '') =>
  http()
    .get(`/projects/${fx.projectId}/execution-updates${query}`)
    .set('Authorization', `Bearer ${token}`);

describe('web list of recorded updates (ADR-059)', () => {
  it('shows the PM every update with its names resolved, newest first', async () => {
    const res = await list(fx.tokens.pm);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = UpdateListResponseSchema.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.items.map((item) => item.featureId)).toEqual([fx.boxB, fx.boxA]);
    expect(body.sites.map((site) => site.id).sort()).toEqual([fx.siteA, fx.siteB].sort());
    const a = body.items[1];
    expect(a).toMatchObject({
      status: 'pending',
      workType: 'civil',
      featureType: 'box',
      siteId: fx.siteA,
      drawingKind: 'general',
      note: 'test note',
      photos: [{ photoId: photoA, requirementKey: 'general', stored: true }],
    });
    expect(a?.siteName).toMatch(/^Site A /);
    expect(a?.supervisorName).toBeTruthy();
    expect(a?.workDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(a?.gps?.lon).toBeCloseTo(gpsA[0], 6);
    expect(a?.gps?.lat).toBeCloseTo(gpsA[1], 6);
    expect(a?.gps?.accuracyM).toBe(4);
    expect(a?.lines).toHaveLength(1);
    expect(a?.lines[0]).toMatchObject({
      role: 'work',
      quantity: '2',
      performer: { kind: 'self' },
      dimensions: null,
    });
    expect(a?.lines[0]?.itemCode).toBeTruthy();
    expect(a?.lines[0]?.workOrderNumber).toBeTruthy();
    expect(body.items[0]?.gps).toBeNull();
    expect(body.items[0]?.flags).toContain('GPS_MISSING');
  });

  it('filters by status and by site, and pages', async () => {
    const pending = UpdateListResponseSchema.parse(
      (await list(fx.tokens.qc, '?status=pending')).body,
    );
    expect(pending.total).toBe(2);
    const approved = UpdateListResponseSchema.parse(
      (await list(fx.tokens.qc, '?status=approved')).body,
    );
    expect(approved).toMatchObject({ total: 0, items: [] });
    const siteB = UpdateListResponseSchema.parse(
      (await list(fx.tokens.pm, `?siteId=${fx.siteB}`)).body,
    );
    expect(siteB.items.map((item) => item.featureId)).toEqual([fx.boxB]);
    const page2 = UpdateListResponseSchema.parse(
      (await list(fx.tokens.pm, '?limit=1&offset=1')).body,
    );
    expect(page2.total).toBe(2);
    expect(page2.items.map((item) => item.featureId)).toEqual([fx.boxA]);
  });

  it('shows a supervisor only the updates and sites of his own sites', async () => {
    const res = await list(fx.tokens.supervisorB);
    expect(res.status).toBe(200);
    const body = UpdateListResponseSchema.parse(res.body);
    expect(body.items.map((item) => item.featureId)).toEqual([fx.boxB]);
    expect(body.sites.map((site) => site.id)).toEqual([fx.siteB]);
    // Asking for another site's filter gives nothing, not that site's updates.
    const other = UpdateListResponseSchema.parse(
      (await list(fx.tokens.supervisorB, `?siteId=${fx.siteA}`)).body,
    );
    expect(other.total).toBe(0);
  });

  it('refuses a role without execution:read and a bad query', async () => {
    expect((await list(fx.tokens.contractor)).status).toBe(403);
    expect((await list(fx.tokens.pm, '?status=done')).status).toBe(400);
    expect((await list(fx.tokens.pm, '?limit=1000')).status).toBe(400);
  });

  it('serves a stored photo in reach and answers 404 outside it', async () => {
    const photoUrl = (id: string) => `/projects/${fx.projectId}/execution-updates/photos/${id}`;
    const ok = await http()
      .get(photoUrl(photoA))
      .set('Authorization', `Bearer ${fx.tokens.pm}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(ok.body as Buffer, photoBytes)).toBe(0);
    const supervisorB = await http()
      .get(photoUrl(photoA))
      .set('Authorization', `Bearer ${fx.tokens.supervisorB}`);
    expect(supervisorB.status).toBe(404);
    const unknown = await http()
      .get(photoUrl(randomUUID()))
      .set('Authorization', `Bearer ${fx.tokens.pm}`);
    expect(unknown.status).toBe(404);
  });
});
