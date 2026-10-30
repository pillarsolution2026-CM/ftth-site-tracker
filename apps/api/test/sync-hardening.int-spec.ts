import { createHash, randomUUID } from 'node:crypto';
import { SyncPushResponseSchema } from '@ftth/shared';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DiscardIdleUploadsUseCase } from '../src/modules/execution/application/photo-upload.use-cases.js';
import { createExecutionFixture, type ExecutionFixture } from './support/execution-fixtures.js';
import { createTestContext, type TestContext } from './support/test-app.js';

/**
 * Security review M3/M4 (Phase 3): per-user rate limits, the project lock timeout, the cap on
 * unfinished uploads and the sweep of idle ones — with tight limits on a dedicated app instance.
 */

let ctx: TestContext;
let fx: ExecutionFixture;

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'), {
    SYNC_RATE_LIMIT: '4',
    SYNC_UPLOAD_RATE_LIMIT: '50',
    SYNC_UPLOAD_BACKLOG_MB: '1',
    SYNC_LOCK_TIMEOUT_MS: '200',
  });
  fx = await createExecutionFixture(ctx);
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

const http = () => request(ctx.app.getHttpServer());
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function jpeg(size: number, seed: number): Buffer {
  const bytes = Buffer.alloc(size, seed);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

function op(photo: Buffer, photoId = randomUUID()) {
  const now = new Date().toISOString();
  return {
    kind: 'execution_update.record',
    clientOpId: randomUUID(),
    capturedAt: now,
    payload: {
      featureId: fx.boxA,
      designRevisionId: fx.revisionId,
      workType: 'civil',
      lines: [{ workOrderItemId: fx.items.civilPieces, quantity: '0.01', role: 'work' }],
      label: null,
      note: null,
      gps: null,
      photos: [
        {
          photoId,
          requirementKey: 'general',
          sha256: sha(photo),
          sizeBytes: photo.length,
          contentType: 'image/jpeg',
          takenAt: now,
          gps: null,
        },
      ],
      acknowledgedWarnings: [],
    },
  };
}

const push = (token: string, ops: unknown[]) =>
  http()
    .post(`/projects/${fx.projectId}/sync/push`)
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId: randomUUID(), ops });

const putChunk = (token: string, photoId: string, offset: number, body: Buffer) =>
  http()
    .put(`/projects/${fx.projectId}/sync/photos/${photoId}/content`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/octet-stream')
    .set('Upload-Offset', String(offset))
    .send(body);

async function recorded(token: string, photo: Buffer): Promise<string> {
  const photoId = randomUUID();
  const res = await push(token, [op(photo, photoId)]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(SyncPushResponseSchema.parse(res.body).results[0]?.outcome).toBe('applied');
  return photoId;
}

describe('per-user rate limit on the sync routes (M4)', () => {
  it('answers 429 with Retry-After once a user exceeds the budget, other users unaffected', async () => {
    const changes = (token: string) =>
      http().get(`/projects/${fx.projectId}/sync/changes`).set('Authorization', `Bearer ${token}`);
    for (let i = 0; i < 4; i++) expect((await changes(fx.tokens.supervisorB)).status).toBe(200);
    const limited = await changes(fx.tokens.supervisorB);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Push and bootstrap share the same budget.
    expect((await push(fx.tokens.supervisorB, [op(jpeg(100, 1))])).status).toBe(429);
    expect((await changes(fx.tokens.pm)).status).toBe(200);
  });
});

describe('project sync lock timeout (M4)', () => {
  it('answers 429 instead of waiting while another session holds the project lock', async () => {
    const pool = new pg.Pool({ connectionString: inject('databaseUrl'), max: 1 });
    const holder = await pool.connect();
    try {
      // Session lock with the same key as the per-push transaction lock.
      await holder.query('SELECT pg_advisory_lock(727002, hashtext($1))', [fx.projectId]);
      const started = Date.now();
      const blocked = await push(fx.tokens.supervisorA2, [op(jpeg(100, 2))]);
      expect(blocked.status).toBe(429);
      expect(Date.now() - started).toBeLessThan(3000);
      await holder.query('SELECT pg_advisory_unlock(727002, hashtext($1))', [fx.projectId]);
      const ok = await push(fx.tokens.supervisorA2, [op(jpeg(100, 3))]);
      expect(ok.status).toBe(200);
    } finally {
      holder.release();
      await pool.end();
    }
  });
});

describe('unfinished uploads (M3)', () => {
  it('caps the bytes one user holds in unfinished uploads but always lets an upload finish', async () => {
    const token = fx.tokens.supervisorA;
    const first = jpeg(700_000, 4);
    const second = jpeg(700_000, 5);
    const firstId = await recorded(token, first);
    const secondId = await recorded(token, second);

    expect((await putChunk(token, firstId, 0, first.subarray(0, 600_000))).status).toBe(200);
    // 600 kB held + 600 kB more > 1 MiB.
    const capped = await putChunk(token, secondId, 0, second.subarray(0, 600_000));
    expect(capped.status).toBe(429);
    expect(capped.body.code).toBe('RATE_LIMITED');
    // Finishing the first photo is allowed and frees the backlog.
    const done = await putChunk(token, firstId, 600_000, first.subarray(600_000));
    expect(done.body.state).toBe('stored');
    expect((await putChunk(token, secondId, 0, second.subarray(0, 600_000))).status).toBe(200);
  });

  it('discards uploads idle for longer than the limit; the device restarts them from 0', async () => {
    const token = fx.tokens.supervisorA;
    const photo = jpeg(5000, 6);
    const photoId = await recorded(token, photo);
    expect((await putChunk(token, photoId, 0, photo.subarray(0, 2000))).status).toBe(200);
    const sweep = ctx.app.get(DiscardIdleUploadsUseCase);
    // Fresh upload: kept.
    await sweep.execute();
    let status = await http()
      .get(`/projects/${fx.projectId}/sync/photos/${photoId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(status.body.receivedBytes).toBe(2000);

    await ctx.pool.query(
      `UPDATE execution_photos SET last_chunk_at = now() - interval '25 hours' WHERE id = $1`,
      [photoId],
    );
    expect(await sweep.execute()).toBeGreaterThanOrEqual(1);
    status = await http()
      .get(`/projects/${fx.projectId}/sync/photos/${photoId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(status.body).toMatchObject({ receivedBytes: 0, state: 'receiving' });
    const chunks = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM execution_photo_chunks WHERE photo_id = $1',
      [photoId],
    );
    expect(chunks.rows[0]).toEqual({ n: 0 });
    // The device resumes from the server status (offset 0) and the photo is stored.
    expect((await putChunk(token, photoId, 0, photo)).body.state).toBe('stored');
  });
});
