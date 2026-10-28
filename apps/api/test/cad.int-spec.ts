import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CAD_QUEUE_KEYS,
  CadCurvePageSchema,
  CadFileDetailSchema,
  CadFileSummarySchema,
  CadImportJobSchema,
  CadInsertPageSchema,
  CadLayerListResponseSchema,
  CadTextPageSchema,
} from '@ftth/shared';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eventTypes, ensureMember, loginAs, projectIds, SEED_LOGINS } from './support/helpers.js';
import { startRedis, type TestRedis } from './support/redis.js';
import { createTestContext, type TestContext } from './support/test-app.js';

const DXF = Buffer.from(
  '  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1032\n  0\nENDSEC\n  0\nEOF\n',
);
const DWG = Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(2000, 1)]);

let testRedis: TestRedis;
let redis: Redis;
let ctx: TestContext;
let brokenQueueCtx: TestContext;
let projectA: string;
let projectB: string;
let admin: string;
let pm: string;
let supervisor: string;
let contractor: string;

beforeAll(async () => {
  testRedis = await startRedis();
  const redisUrl = testRedis.url;
  redis = new Redis(redisUrl);

  ctx = await createTestContext(inject('databaseUrl'), { REDIS_URL: redisUrl, MAX_UPLOAD_MB: '1' });
  // Nothing listens on port 1: the real Redis adapter must fail and the upload must report it.
  brokenQueueCtx = await createTestContext(inject('databaseUrl'), {
    REDIS_URL: 'redis://127.0.0.1:1',
  });

  const ids = await projectIds(ctx.pool);
  projectA = ids.a;
  projectB = ids.b;
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
  contractor = await loginAs(ctx, 'contractor@ftth.local', 'Contractor#123');
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  await brokenQueueCtx?.close();
  redis?.disconnect();
  await testRedis?.stop();
});

const http = (context: TestContext = ctx) => request(context.app.getHttpServer());
const base = (project: string) => `/projects/${project}/cad-files`;
const as = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

const upload = (content: Buffer, name: string, token = pm, project = projectA, context = ctx) =>
  as(token)(http(context).post(base(project))).attach('file', content, name);

async function queuedJobs() {
  const raw = await redis.lrange(CAD_QUEUE_KEYS.jobs, 0, -1);
  return raw.map((message) => CadImportJobSchema.parse(JSON.parse(message)));
}

describe('CAD upload', () => {
  it('stores the original, creates a queued row, appends events and pushes one job', async () => {
    const before = (await queuedJobs()).length;
    const res = await upload(DXF, 'خريطة قليوب.dxf');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const file = CadFileSummarySchema.parse(res.body);
    expect(file).toMatchObject({
      projectId: projectA,
      originalName: 'خريطة قليوب.dxf',
      format: 'dxf',
      status: 'queued',
      sizeBytes: DXF.length,
      sha256: createHash('sha256').update(DXF).digest('hex'),
      counts: null,
      warningCount: 0,
      errorCode: null,
      processedAt: null,
    });

    const { rows } = await ctx.pool.query(
      'SELECT status, current_job_id, queued_at, storage_key, uploaded_by FROM cad_files WHERE id = $1',
      [file.id],
    );
    expect(rows[0]).toMatchObject({
      status: 'queued',
      storage_key: `projects/${projectA}/cad/${file.id}/original.dxf`,
    });
    expect(rows[0].current_job_id).toBeTruthy();
    expect(rows[0].queued_at).toBeInstanceOf(Date);
    expect(rows[0].uploaded_by).toBeTruthy();

    const stored = await readFile(join(ctx.storageRoot, rows[0].storage_key));
    expect(stored.equals(DXF)).toBe(true);
    expect(await eventTypes(ctx.pool, file.id)).toEqual(['cad_file.uploaded', 'cad_file.queued']);

    const jobs = await queuedJobs();
    expect(jobs).toHaveLength(before + 1);
    expect(jobs[0]).toMatchObject({
      // LPUSH puts the newest at the head; the worker pops from the tail (FIFO).
      id: rows[0].current_job_id,
      type: 'cad.import',
      cadFileId: file.id,
      projectId: projectA,
      storageKey: rows[0].storage_key,
      format: 'dxf',
      attempt: 1,
    });
  });

  it('accepts a DWG by its signature', async () => {
    const res = await upload(DWG, 'plan.dwg');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ format: 'dwg', status: 'queued' });
  });

  it('refuses content that does not match the extension with 415 and stores nothing', async () => {
    const countBefore = (await ctx.pool.query('SELECT count(*)::int AS n FROM cad_files')).rows[0]
      .n;
    for (const [content, name] of [
      [DXF, 'plan.dwg'],
      [DWG, 'plan.dxf'],
      [Buffer.from('%PDF-1.7 hello'), 'plan.dxf'],
      [DXF, 'plan.pdf'],
      [DXF, 'plan'],
      [Buffer.alloc(0), 'empty.dxf'],
    ] as const) {
      const res = await upload(content, name);
      expect(res.status, name).toBe(415);
      expect(res.body.code).toBe('UNSUPPORTED_FILE');
    }
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM cad_files')).rows[0].n).toBe(
      countBefore,
    );
  });

  it('refuses files above MAX_UPLOAD_MB with 413 FILE_TOO_LARGE', async () => {
    const res = await upload(Buffer.concat([DXF, Buffer.alloc(1_100_000, 0x20)]), 'big.dxf');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });

  it('marks the file failed with ENQUEUE_FAILED when Redis is unreachable, then recovers via reprocess', async () => {
    const res = await upload(DXF, 'orphan.dxf', pm, projectA, brokenQueueCtx);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'failed', errorCode: 'ENQUEUE_FAILED' });
    expect(await eventTypes(ctx.pool, res.body.id)).toEqual([
      'cad_file.uploaded',
      'cad_file.queued',
      'cad_file.failed',
    ]);
    const detail = await as(pm)(http().get(`${base(projectA)}/${res.body.id}`));
    expect(detail.body).toMatchObject({ status: 'failed', errorCode: 'ENQUEUE_FAILED' });
    expect(detail.body.errorMessage).toBeTruthy();

    const before = (await queuedJobs()).length;
    const retry = await as(pm)(http().post(`${base(projectA)}/${res.body.id}/reprocess`));
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({ status: 'queued', errorCode: null });
    expect((await queuedJobs()).length).toBe(before + 1);
  }, 60_000);
});

describe('CAD access control', () => {
  it('lets a supervisor read but not upload or reprocess; contractors get nothing', async () => {
    const created = await upload(DXF, 'acl.dxf');
    const id = created.body.id as string;
    const sup = as(supervisor);
    expect((await sup(http().get(base(projectA)))).status).toBe(200);
    expect((await sup(http().get(`${base(projectA)}/${id}`))).status).toBe(200);
    expect((await sup(http().get(`${base(projectA)}/${id}/content`))).status).toBe(200);
    expect((await sup(http().get(`${base(projectA)}/${id}/layers`))).status).toBe(200);
    expect((await upload(DXF, 'x.dxf', supervisor)).status).toBe(403);
    expect((await sup(http().post(`${base(projectA)}/${id}/reprocess`))).status).toBe(403);

    const con = as(contractor);
    expect((await con(http().get(base(projectA)))).status).toBe(403);
    expect((await upload(DXF, 'x.dxf', contractor)).status).toBe(403);
    expect((await http().get(base(projectA))).status).toBe(401);
  });

  it('answers NOT_FOUND for a file id that belongs to another project', async () => {
    const inB = await upload(DXF, 'b.dxf', admin, projectB);
    expect(inB.status).toBe(201);
    const id = inB.body.id as string;
    for (const path of ['', '/content', '/log', '/layers', '/inserts', '/texts', '/curves']) {
      const res = await as(pm)(http().get(`${base(projectA)}/${id}${path}`));
      expect(res.status, path).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    const reprocess = await as(pm)(http().post(`${base(projectA)}/${id}/reprocess`));
    expect(reprocess.status).toBe(404);

    const list = await as(pm)(http().get(base(projectA)));
    expect(list.body.items.some((f: { id: string }) => f.id === id)).toBe(false);
    expect((await as(pm)(http().get(`${base(projectB)}/${id}`))).status).toBe(403);
  });
});

describe('CAD reads', () => {
  it('lists newest first, serves the original and an empty log', async () => {
    const first = await upload(DXF, 'list-1.dxf');
    const second = await upload(DXF, 'list-2.dxf');
    const list = await as(pm)(http().get(base(projectA)));
    const ids = list.body.items.map((f: { id: string }) => f.id);
    expect(ids.indexOf(second.body.id)).toBeLessThan(ids.indexOf(first.body.id));

    const content = await as(pm)(http().get(`${base(projectA)}/${first.body.id}/content`))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(content.status).toBe(200);
    expect(content.headers['content-disposition']).toBe("attachment; filename*=UTF-8''list-1.dxf");
    expect((content.body as Buffer).equals(DXF)).toBe(true);

    const log = await as(pm)(http().get(`${base(projectA)}/${first.body.id}/log`));
    expect(log.body).toEqual({ log: '' });
  });

  it('returns empty pages until the worker has processed the file', async () => {
    const created = await upload(DXF, 'pending.dxf');
    const id = created.body.id as string;
    const layers = await as(pm)(http().get(`${base(projectA)}/${id}/layers`));
    expect(CadLayerListResponseSchema.parse(layers.body).items).toEqual([]);
    const texts = await as(pm)(http().get(`${base(projectA)}/${id}/texts?pageSize=5`));
    expect(CadTextPageSchema.parse(texts.body)).toEqual({
      items: [],
      page: 1,
      pageSize: 5,
      total: 0,
    });
  });

  /** Fills the extraction tables the way the worker does, then marks the file processed. */
  async function processedFile(): Promise<string> {
    const created = await upload(DXF, `processed-${Math.random()}.dxf`);
    const id = created.body.id as string;
    const { rows } = await ctx.pool.query<{ current_job_id: string }>(
      'SELECT current_job_id FROM cad_files WHERE id = $1',
      [id],
    );
    const point = (x: number, y: number) => `ST_GeomFromText('POINTZ(${x} ${y} 0)', 0)`;
    const run = (sql: string, params: unknown[] = []) =>
      ctx.pool.query(sql, [projectA, id, ...params]);

    await run(
      `INSERT INTO cad_layers (project_id, cad_file_id, name, aci_color, true_color, linetype, is_on, is_frozen, is_locked, entity_counts, entity_total)
       VALUES ($1, $2, 'FIBER', 3, NULL, 'Continuous', true, false, false, '{"LWPOLYLINE": 2, "INSERT": 1}', 3),
              ($1, $2, '0', 7, 16711680, NULL, true, false, true, '{}', 0),
              ($1, $2, 'TEXT', 1, NULL, NULL, false, false, false, '{"TEXT": 3}', 3)`,
    );
    await run(
      `INSERT INTO cad_inserts (project_id, cad_file_id, handle, layer, block_name, position, rotation, scale_x, scale_y, scale_z, aci_color, attributes)
       VALUES ($1, $2, 'A1', 'FIBER', 'MANHOLE', ${point(10.5, 20.25)}, 90, 1, 1, 1, 256,
               '[{"tag":"ID","rawValue":"MH-1","value":"MH-1","readable":true}]'),
              ($1, $2, 'A2', 'FIBER', 'POLE', ${point(30, 40)}, 0, 2, 2, 1, 3, '[]'),
              ($1, $2, 'A3', '0', 'MANHOLE', ${point(50, 60)}, 0, 1, 1, 1, 0, '[]')`,
    );
    await run(
      `INSERT INTO cad_texts (project_id, cad_file_id, handle, kind, layer, position, height, rotation, raw_text, text, readable, style, font, aci_color)
       VALUES ($1, $2, 'T1', 'text', 'TEXT', ${point(1, 2)}, 2.5, 0, 'عمارة 5', 'عمارة 5', true, 'Standard', 'arial.ttf', 256),
              ($1, $2, 'T2', 'mtext', 'TEXT', ${point(3, 4)}, 2.5, 45, '\\\\fxarb.shx;50% done_', '50% done_', false, 'ARB', 'xarb.shx', 1),
              ($1, $2, 'T3', 'text', 'FIBER', ${point(5, 6)}, 1, 0, 'MH-1', 'MH-1', true, NULL, NULL, 256)`,
    );
    await run(
      `INSERT INTO cad_curves (project_id, cad_file_id, handle, entity_type, layer, geom, is_closed, flatten_tolerance, aci_color)
       VALUES ($1, $2, 'C1', 'LINE', 'FIBER', ST_GeomFromText('LINESTRINGZ(0 0 0, 3 4 0)', 0), false, NULL, 256),
              ($1, $2, 'C2', 'LWPOLYLINE', 'FIBER', ST_GeomFromText('LINESTRINGZ(0 0 0, 10 0 0, 10 10 0, 0 0 0)', 0), true, NULL, 3),
              ($1, $2, 'C3', 'ARC', '0', ST_GeomFromText('LINESTRINGZ(0 0 0, 1 1 0, 2 0 0)', 0), false, 0.01, 256)`,
    );
    await ctx.pool.query(
      `UPDATE cad_files SET status = 'processed', processed_at = now(), converter = 'none', dxf_version = 'AC1032',
         ins_units = 6, extents_min_x = 0, extents_min_y = 0, extents_max_x = 50, extents_max_y = 60,
         layer_count = 3, insert_count = 3, text_count = 3, curve_count = 3,
         warnings = '[{"code":"UNREADABLE_TEXT","count":1,"params":{"font":"xarb.shx"}}]', log = 'ezdxf 1.4 ok'
       WHERE id = $1 AND current_job_id = $2`,
      [id, rows[0]?.current_job_id],
    );
    return id;
  }

  it('shows summary, detail, log and layers of a processed file', async () => {
    const id = await processedFile();
    const url = `${base(projectA)}/${id}`;

    const detail = CadFileDetailSchema.parse((await as(pm)(http().get(url))).body);
    expect(detail).toMatchObject({
      status: 'processed',
      counts: { layers: 3, inserts: 3, texts: 3, curves: 3 },
      warningCount: 1,
      dxfVersion: 'AC1032',
      converter: 'none',
      insUnits: 6,
      extents: { minX: 0, minY: 0, maxX: 50, maxY: 60 },
      warnings: [{ code: 'UNREADABLE_TEXT', count: 1, params: { font: 'xarb.shx' } }],
    });
    expect((await as(pm)(http().get(`${url}/log`))).body).toEqual({ log: 'ezdxf 1.4 ok' });

    const layers = CadLayerListResponseSchema.parse(
      (await as(pm)(http().get(`${url}/layers`))).body,
    );
    expect(layers.items.map((l) => l.name)).toEqual(['0', 'FIBER', 'TEXT']); // ordered by name
    expect(layers.items[1]).toMatchObject({
      aciColor: 3,
      isOn: true,
      entityCounts: { LWPOLYLINE: 2, INSERT: 1 },
      entityTotal: 3,
    });
    expect(layers.items[0]).toMatchObject({ trueColor: 16711680, isLocked: true, linetype: null });
    expect(layers.items[2]?.isOn).toBe(false);
  });

  it('pages and filters inserts, ordered by layer then handle', async () => {
    const id = await processedFile();
    const url = `${base(projectA)}/${id}/inserts`;
    const get = async (query = '') =>
      CadInsertPageSchema.parse((await as(pm)(http().get(url + query))).body);

    const all = await get();
    expect(all).toMatchObject({ page: 1, pageSize: 100, total: 3 });
    expect(all.items.map((i) => i.handle)).toEqual(['A3', 'A1', 'A2']);
    expect(all.items[1]).toEqual({
      id: expect.any(String),
      handle: 'A1',
      layer: 'FIBER',
      blockName: 'MANHOLE',
      position: { x: 10.5, y: 20.25, z: 0 },
      rotation: 90,
      scale: { x: 1, y: 1, z: 1 },
      aciColor: 256,
      attributes: [{ tag: 'ID', rawValue: 'MH-1', value: 'MH-1', readable: true }],
    });

    expect((await get('?layer=FIBER')).items.map((i) => i.handle)).toEqual(['A1', 'A2']);
    expect((await get('?blockName=MANHOLE')).total).toBe(2);
    const page2 = await get('?pageSize=2&page=2');
    expect(page2).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page2.items.map((i) => i.handle)).toEqual(['A2']);
    expect((await as(pm)(http().get(`${url}?pageSize=501`))).status).toBe(400);
  });

  it('filters texts by readability, kind, layer and a literal substring', async () => {
    const id = await processedFile();
    const url = `${base(projectA)}/${id}/texts`;
    const get = async (query = '') =>
      CadTextPageSchema.parse((await as(pm)(http().get(url + query))).body);

    expect((await get()).items.map((t) => t.handle)).toEqual(['T3', 'T1', 'T2']);
    const unreadable = await get('?readable=false');
    expect(unreadable.items.map((t) => t.handle)).toEqual(['T2']);
    expect(unreadable.items[0]).toMatchObject({
      kind: 'mtext',
      rawText: '\\\\fxarb.shx;50% done_',
      text: '50% done_',
      readable: false,
      font: 'xarb.shx',
      rotation: 45,
      aciColor: 1,
      position: { x: 3, y: 4, z: 0 },
    });
    expect((await get('?readable=true')).total).toBe(2);
    expect((await get('?kind=mtext')).total).toBe(1);
    expect((await get('?layer=FIBER')).items.map((t) => t.handle)).toEqual(['T3']);
    expect((await get('?q=mh-')).items.map((t) => t.handle)).toEqual(['T3']);
    // "%" and "_" are literal characters, not wildcards.
    expect((await get(`?q=${encodeURIComponent('50% done_')}`)).total).toBe(1);
    expect((await get(`?q=${encodeURIComponent('%')}`)).items.map((t) => t.handle)).toEqual(['T2']);
    expect((await get(`?q=${encodeURIComponent('_')}`)).items.map((t) => t.handle)).toEqual(['T2']);
    expect((await get('?q=عمارة')).items.map((t) => t.handle)).toEqual(['T1']);
    expect((await as(pm)(http().get(`${url}?readable=maybe`))).status).toBe(400);
  });

  it('summarises curves with length, bbox and approximation, and filters them', async () => {
    const id = await processedFile();
    const url = `${base(projectA)}/${id}/curves`;
    const get = async (query = '') =>
      CadCurvePageSchema.parse((await as(pm)(http().get(url + query))).body);

    const all = await get();
    expect(all.items.map((c) => c.handle)).toEqual(['C3', 'C1', 'C2']);
    const byHandle = Object.fromEntries(all.items.map((c) => [c.handle, c]));
    expect(byHandle.C1).toMatchObject({
      entityType: 'LINE',
      vertexCount: 2,
      length: 5,
      isClosed: false,
      approximated: false,
      bbox: { minX: 0, minY: 0, maxX: 3, maxY: 4 },
    });
    expect(byHandle.C2).toMatchObject({ vertexCount: 4, isClosed: true, aciColor: 3 });
    expect(byHandle.C2?.length).toBeCloseTo(20 + Math.sqrt(200), 9);
    expect(byHandle.C3).toMatchObject({ entityType: 'ARC', approximated: true });

    expect((await get('?entityType=LINE')).items.map((c) => c.handle)).toEqual(['C1']);
    expect((await get('?layer=FIBER')).total).toBe(2);
    expect((await as(pm)(http().get(`${url}?entityType=HATCH`))).status).toBe(400);
  });
});

describe('CAD reprocess', () => {
  it('refuses while a fresh job is queued, then queues a processed file again with a new job id', async () => {
    const created = await upload(DXF, 'again.dxf');
    const id = created.body.id as string;
    const url = `${base(projectA)}/${id}/reprocess`;

    const busy = await as(pm)(http().post(url));
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('CONFLICT');

    const first = (await ctx.pool.query('SELECT current_job_id FROM cad_files WHERE id = $1', [id]))
      .rows[0].current_job_id;
    await ctx.pool.query(
      "UPDATE cad_files SET status = 'processed', processed_at = now() WHERE id = $1",
      [id],
    );
    const before = (await queuedJobs()).length;
    const again = await as(pm)(http().post(url));
    expect(again.status).toBe(202);
    expect(again.body.status).toBe('queued');

    const second = (
      await ctx.pool.query('SELECT current_job_id FROM cad_files WHERE id = $1', [id])
    ).rows[0].current_job_id;
    expect(second).not.toBe(first);
    const jobs = await queuedJobs();
    expect(jobs).toHaveLength(before + 1);
    expect(jobs[0]).toMatchObject({ id: second, cadFileId: id, attempt: 1 });
    expect(await eventTypes(ctx.pool, id)).toEqual([
      'cad_file.uploaded',
      'cad_file.queued',
      'cad_file.queued',
    ]);
  });

  it('allows it for a file stuck in processing for longer than the stale window', async () => {
    const created = await upload(DXF, 'stuck.dxf');
    const id = created.body.id as string;
    await ctx.pool.query(
      `UPDATE cad_files SET status = 'processing',
         queued_at = now() - interval '30 minutes', processing_started_at = now() - interval '20 minutes'
       WHERE id = $1`,
      [id],
    );
    const res = await as(pm)(http().post(`${base(projectA)}/${id}/reprocess`));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
  });

  it('keeps the original immutable in the database', async () => {
    const created = await upload(DXF, 'immutable.dxf');
    await expect(
      ctx.pool.query("UPDATE cad_files SET original_name = 'other.dxf' WHERE id = $1", [
        created.body.id,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});
