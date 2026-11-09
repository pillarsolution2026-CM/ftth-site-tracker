import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CadRenderViewJobSchema, DrawingViewStateSchema } from '@ftth/shared';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ensureMember, loginAs, SEED_LOGINS } from './support/helpers.js';
import { startRedis, type TestRedis } from './support/redis.js';
import { createTestContext, type TestContext } from './support/test-app.js';

let testRedis: TestRedis;
let redis: Redis;
let ctx: TestContext;
let project: string;
let otherProject: string;
let admin: string;
let supervisor: string;

beforeAll(async () => {
  testRedis = await startRedis();
  redis = new Redis(testRedis.url);
  ctx = await createTestContext(inject('databaseUrl'), { REDIS_URL: testRedis.url });
  const make = async (label: string) =>
    (
      await ctx.pool.query<{ id: string }>(
        `INSERT INTO projects (name, client, crs_epsg, currency, locale)
         VALUES ($1, 'WE', 32636, 'EGP', 'ar') RETURNING id`,
        [`View ${label} ${randomUUID()}`],
      )
    ).rows[0]?.id ?? '';
  project = await make('A');
  otherProject = await make('B');
  const zone = await ctx.pool.query<{ id: string }>(
    `INSERT INTO zones (project_id, name) VALUES ($1, 'Sector 1') RETURNING id`,
    [project],
  );
  await ensureMember(ctx.pool, {
    email: 'view-sup@ftth.local',
    password: 'View#Sup1234',
    role: 'supervisor',
    projectId: project,
    zoneId: zone.rows[0]?.id ?? '',
  });
  admin = await loginAs(ctx, ...SEED_LOGINS.admin);
  supervisor = await loginAs(ctx, 'view-sup@ftth.local', 'View#Sup1234');
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  redis?.disconnect();
  await testRedis?.stop();
});

const http = () => request(ctx.app.getHttpServer());
const as = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
const viewUrl = (file: string, p = project) => `/projects/${p}/cad-files/${file}/view`;

async function insertFile(status: 'processed' | 'uploaded' = 'processed'): Promise<string> {
  const id = randomUUID();
  await ctx.pool.query(
    `INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, storage_key,
                            status, current_job_id, ins_units, processed_at)
     VALUES ($1, $2, 'plan.dxf', 'dxf', 100, repeat('a', 64), $3, $4, $5, 1, $6)`,
    [
      id,
      project,
      `projects/${project}/cad/${id}/original.dxf`,
      status,
      status === 'uploaded' ? null : randomUUID(),
      status === 'processed' ? new Date() : null,
    ],
  );
  return id;
}

const queuedJobs = async (cadFileId: string) =>
  (await redis.lrange('cad:jobs', 0, -1))
    .map((raw) => JSON.parse(raw) as { type: string; cadFileId: string })
    .filter((job) => job.type === 'cad.render_view' && job.cadFileId === cadFileId);

describe('migration 0016 constraints', () => {
  it('has the default and rejects inconsistent view rows', async () => {
    const id = await insertFile();
    const row = await ctx.pool.query<{ view_status: string }>(
      'SELECT view_status FROM cad_files WHERE id = $1',
      [id],
    );
    expect(row.rows[0]?.view_status).toBe('none');

    const update = (set: string) =>
      ctx.pool.query(`UPDATE cad_files SET ${set} WHERE id = $1`, [id]);
    await expect(update(`view_status = 'weird'`)).rejects.toThrow();
    await expect(update(`view_status = 'ready'`)).rejects.toThrow(); // key, size, time missing
    await expect(
      update(
        `view_status = 'ready', view_storage_key = 'k', view_size_bytes = 0, view_rendered_at = now()`,
      ),
    ).rejects.toThrow();
    await expect(update(`view_status = 'failed'`)).rejects.toThrow(); // error code missing
    await update(
      `view_status = 'ready', view_storage_key = 'k', view_size_bytes = 5, view_rendered_at = now()`,
    );
    await update(`view_status = 'failed', view_error_code = 'RENDER_FAILED'`);
    // 0017: queued needs a queued_at.
    await expect(update(`view_status = 'queued', view_queued_at = NULL`)).rejects.toThrow();
    await update(`view_status = 'queued', view_queued_at = now()`);
  });
});

// POST …/view is limited to 10 per user per 10 minutes (L5): this file keeps to the admin's budget
// and ends with the 429 test.
describe('drawing view routes', () => {
  it('queues once, is idempotent, and pushes a valid job to Redis', async () => {
    const id = await insertFile();

    const before = await as(admin)(http().get(`${viewUrl(id)}/status`)).expect(200);
    expect(DrawingViewStateSchema.parse(before.body).status).toBe('none');

    const first = await as(admin)(http().post(viewUrl(id))).expect(202);
    expect(DrawingViewStateSchema.parse(first.body).status).toBe('queued');
    await as(admin)(http().post(viewUrl(id))).expect(202);

    const jobs = await queuedJobs(id);
    expect(jobs).toHaveLength(1);
    const row = await ctx.pool.query<{ view_job_id: string }>(
      'SELECT view_job_id FROM cad_files WHERE id = $1',
      [id],
    );
    expect(CadRenderViewJobSchema.parse(jobs[0])).toMatchObject({
      id: row.rows[0]?.view_job_id,
      projectId: project,
      attempt: 1,
    });
  });

  it('requeues a view stuck in queued once it is older than the stale limit', async () => {
    const id = await insertFile();
    await as(admin)(http().post(viewUrl(id))).expect(202);
    expect(await queuedJobs(id)).toHaveLength(1);

    await ctx.pool.query(
      `UPDATE cad_files SET view_queued_at = now() - interval '20 minutes' WHERE id = $1`,
      [id],
    );
    await as(admin)(http().post(viewUrl(id))).expect(202);
    expect(await queuedJobs(id)).toHaveLength(2);
  });

  it('refuses a file that is not processed, and a role without design:write', async () => {
    const uploaded = await insertFile('uploaded');
    const refused = await as(admin)(http().post(viewUrl(uploaded))).expect(409);
    expect(refused.body).toMatchObject({ details: { reason: 'NOT_PROCESSED' } });

    const processed = await insertFile();
    await as(supervisor)(http().post(viewUrl(processed))).expect(403);
    await as(supervisor)(http().get(`${viewUrl(processed)}/status`)).expect(200);
  });

  it("hides another project's files (404 on all three routes)", async () => {
    const id = await insertFile();
    await as(admin)(http().get(`${viewUrl(id, otherProject)}/status`)).expect(404);
    await as(admin)(http().post(viewUrl(id, otherProject))).expect(404);
    await as(admin)(http().get(viewUrl(id, otherProject))).expect(404);
  });

  it('answers 404 before ready, then serves the stored gzip bytes with the right headers', async () => {
    const id = await insertFile();
    await as(admin)(http().get(viewUrl(id))).expect(404);
    await as(admin)(http().post(viewUrl(id))).expect(202);
    await as(admin)(http().get(viewUrl(id))).expect(404);

    const json = { version: 1, cadFileId: id, entities: [] };
    const gz = gzipSync(Buffer.from(JSON.stringify(json)));
    const key = `projects/${project}/cad/${id}/view.json.gz`;
    await mkdir(dirname(join(ctx.storageRoot, key)), { recursive: true });
    await writeFile(join(ctx.storageRoot, key), gz);
    await ctx.pool.query(
      `UPDATE cad_files SET view_status = 'ready', view_storage_key = $2, view_size_bytes = $3,
                            view_rendered_at = now() WHERE id = $1`,
      [id, key, gz.length],
    );

    const state = await as(admin)(http().get(`${viewUrl(id)}/status`)).expect(200);
    expect(DrawingViewStateSchema.parse(state.body)).toMatchObject({
      status: 'ready',
      sizeBytes: gz.length,
    });

    const res = await as(admin)(
      http()
        .get(viewUrl(id))
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => done(null, Buffer.concat(chunks)));
        }),
    ).expect(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // The client decodes the gzip body (content-encoding), so the bytes are the stored JSON.
    expect((res.body as Buffer).equals(gunzipSync(gz))).toBe(true);

    // Ready: POST changes nothing.
    await as(admin)(http().post(viewUrl(id))).expect(202);
    expect(await queuedJobs(id)).toHaveLength(1);
  });

  it('a reprocess resets the view to none', async () => {
    const id = await insertFile();
    await as(admin)(http().post(viewUrl(id))).expect(202);
    await as(admin)(http().post(`/projects/${project}/cad-files/${id}/reprocess`)).expect(202);
    const state = await as(admin)(http().get(`${viewUrl(id)}/status`)).expect(200);
    expect(state.body).toMatchObject({ status: 'none', sizeBytes: null, errorCode: null });
    const row = await ctx.pool.query<{ view_job_id: string | null }>(
      'SELECT view_job_id FROM cad_files WHERE id = $1',
      [id],
    );
    expect(row.rows[0]?.view_job_id).toBeNull();
  });
});

describe('drawing view rate limit', () => {
  it('answers 429 RATE_LIMITED with Retry-After once the budget is spent', async () => {
    const id = await insertFile();
    let last = 202;
    for (let i = 0; i < 12 && last === 202; i += 1) {
      last = (await as(admin)(http().post(viewUrl(id)))).status;
    }
    expect(last).toBe(429);
    const res = await as(admin)(http().post(viewUrl(id))).expect(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED' });
  });
});
