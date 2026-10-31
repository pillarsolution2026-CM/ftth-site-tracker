import { TokenPairSchema } from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createTestContext, type TestContext } from './support/test-app.js';

let ctx: TestContext;
let projectA: string;
let projectB: string;

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  const { rows } = await ctx.pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM projects',
  );
  projectA = rows.find((row) => row.name === 'القطاع الأول – قليوب')?.id ?? '';
  projectB = rows.find((row) => row.name === 'Test Project B')?.id ?? '';
});
afterAll(async () => {
  await ctx.close();
});

async function tokenFor(email: string, password: string): Promise<string> {
  const res = await request(ctx.app.getHttpServer()).post('/auth/login').send({ email, password });
  return TokenPairSchema.parse(res.body).accessToken;
}

const getProject = (id: string, token?: string) => {
  const req = request(ctx.app.getHttpServer()).get(`/projects/${id}`);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

describe('GET /projects/:projectId', () => {
  it('returns the project for a member (supervisor of project A)', async () => {
    const res = await getProject(projectA, await tokenFor('supervisor@ftth.local', 'Super#12345'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: projectA,
      name: 'القطاع الأول – قليوب',
      client: 'WE',
      crsEpsg: 32636,
      currency: 'EGP',
      locale: 'ar',
      // The dev seed links project A to its approved contract (ADR-028).
      contractId: expect.any(String),
    });
  });

  it('answers 403 FORBIDDEN when the supervisor asks for project B', async () => {
    const res = await getProject(projectB, await tokenFor('supervisor@ftth.local', 'Super#12345'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('lets the admin read any project without an assignment', async () => {
    const res = await getProject(projectB, await tokenFor('admin@ftth.local', 'Admin#12345'));
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Test Project B');
  });

  it('answers 404 NOT_FOUND for an admin asking for a missing project', async () => {
    const res = await getProject(
      '99999999-9999-4999-8999-999999999999',
      await tokenFor('admin@ftth.local', 'Admin#12345'),
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('answers 403 (not 404) for a non-admin asking for a missing project, so existence does not leak', async () => {
    const res = await getProject(
      '99999999-9999-4999-8999-999999999999',
      await tokenFor('pm@ftth.local', 'Pm#123456'),
    );
    expect(res.status).toBe(403);
  });

  it('answers 400 for a malformed id and 401 without a token', async () => {
    const token = await tokenFor('pm@ftth.local', 'Pm#123456');
    expect((await getProject('not-a-uuid', token)).status).toBe(400);
    expect((await getProject(projectA)).status).toBe(401);
  });
});

describe('platform endpoints', () => {
  it('GET /health reports the database', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok', version: 'dev' });
  });

  it('serves the OpenAPI document with the auth routes', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/docs-json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/auth/login',
        '/auth/refresh',
        '/auth/logout',
        '/auth/me',
        '/health',
      ]),
    );
  });

  it('applies CORS_ORIGINS', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/health')
      .set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('maps unknown routes to the ApiError shape', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});
