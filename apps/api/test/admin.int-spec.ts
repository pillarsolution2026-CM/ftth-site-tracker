import { randomUUID } from 'node:crypto';
import { MeResponseSchema, TokenPairSchema } from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eventTypes, loginAs, projectIds, SEED_LOGINS } from './support/helpers.js';
import { createTestContext, type TestContext } from './support/test-app.js';

let ctx: TestContext;
let adminToken: string;
let pmToken: string;
let supervisorToken: string;
let seeded: { a: string; b: string; zone: string };

const PASSWORD = 'a-good-long-password';
const MISSING = '99999999-9999-4999-8999-999999999999';
const http = () => request(ctx.app.getHttpServer());
const uniqueEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.com`;

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
  adminToken = await loginAs(ctx, ...SEED_LOGINS.admin);
  pmToken = await loginAs(ctx, ...SEED_LOGINS.pm);
  supervisorToken = await loginAs(ctx, ...SEED_LOGINS.supervisor);
  seeded = await projectIds(ctx.pool);
});
afterAll(async () => {
  await ctx.close();
});

async function createUser(email = uniqueEmail('user')): Promise<{ id: string; email: string }> {
  const res = await http()
    .post('/admin/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email, displayName: 'New User', password: PASSWORD });
  expect(res.status).toBe(201);
  return { id: res.body.id, email };
}

async function createProject(name = `Project ${randomUUID().slice(0, 8)}`): Promise<string> {
  const res = await http()
    .post('/admin/projects')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name, client: 'Client X', crsEpsg: 32636, currency: 'EGP', locale: 'ar' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function login(email: string, password = PASSWORD) {
  return http().post('/auth/login').send({ email, password });
}

/** Every admin route, with a body that would be valid for an admin. */
function adminRoutes(): {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  body?: object;
}[] {
  const userId = randomUUID();
  return [
    { method: 'get', path: '/admin/projects' },
    {
      method: 'post',
      path: '/admin/projects',
      body: { name: 'X', client: 'Y', crsEpsg: 32636, currency: 'EGP', locale: 'ar' },
    },
    { method: 'patch', path: `/admin/projects/${seeded.a}`, body: { name: 'Hijacked' } },
    { method: 'get', path: `/admin/projects/${seeded.a}/zones` },
    { method: 'post', path: `/admin/projects/${seeded.a}/zones`, body: { name: 'Z' } },
    { method: 'get', path: `/admin/projects/${seeded.a}/assignments` },
    {
      method: 'post',
      path: `/admin/projects/${seeded.a}/assignments`,
      body: { userId, role: 'pm' },
    },
    { method: 'delete', path: `/admin/projects/${seeded.a}/assignments/${randomUUID()}` },
    { method: 'get', path: '/admin/users' },
    {
      method: 'post',
      path: '/admin/users',
      body: { email: uniqueEmail('x'), displayName: 'X', password: PASSWORD },
    },
    { method: 'post', path: `/admin/users/${userId}/deactivate` },
    { method: 'post', path: `/admin/users/${userId}/reactivate` },
  ];
}

describe('admin routes are platform-admin only', () => {
  it('answers 401 without a token on every route', async () => {
    for (const route of adminRoutes()) {
      const res = await http()[route.method](route.path).send(route.body);
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it('answers 403 to a project manager and a supervisor on every route, and changes nothing', async () => {
    const before = await ctx.pool.query('SELECT count(*)::int AS n FROM events');
    for (const token of [pmToken, supervisorToken]) {
      for (const route of adminRoutes()) {
        const res = await http()
          [route.method](route.path)
          .set('Authorization', `Bearer ${token}`)
          .send(route.body);
        expect(res.status, `${route.method} ${route.path}`).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    }
    const after = await ctx.pool.query('SELECT count(*)::int AS n FROM events');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const { rows } = await ctx.pool.query('SELECT name FROM projects WHERE id = $1', [seeded.a]);
    expect(rows[0].name).not.toBe('Hijacked');
  });

  it('refuses an admin token once the admin is deactivated or demoted in the database', async () => {
    const email = uniqueEmail('admin2');
    await ctx.pool.query(
      `INSERT INTO users (email, display_name, password_hash, is_admin)
       SELECT $1, 'Admin 2', password_hash, true FROM users WHERE email = $2`,
      [email, SEED_LOGINS.admin[0]],
    );
    const token = await loginAs(ctx, email, SEED_LOGINS.admin[1]);
    const ok = await http().get('/admin/users').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);

    await ctx.pool.query('UPDATE users SET is_admin = false WHERE email = $1', [email]);
    const demoted = await http().get('/admin/users').set('Authorization', `Bearer ${token}`);
    expect(demoted.status).toBe(403);

    await ctx.pool.query('UPDATE users SET is_admin = true, is_active = false WHERE email = $1', [
      email,
    ]);
    const inactive = await http().get('/admin/users').set('Authorization', `Bearer ${token}`);
    expect(inactive.status).toBe(403);
  });
});

describe('projects', () => {
  it('creates a project, records the event and lets the admin open it', async () => {
    const id = await createProject('مشروع تجريبي');
    expect(await eventTypes(ctx.pool, id)).toEqual(['project.created']);

    const project = await http()
      .get(`/projects/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(project.status).toBe(200);
    expect(project.body).toEqual({
      id,
      name: 'مشروع تجريبي',
      client: 'Client X',
      crsEpsg: 32636,
      currency: 'EGP',
      locale: 'ar',
    });

    const list = await http().get('/admin/projects').set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    const ids = list.body.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining([id, seeded.a, seeded.b]));
  });

  it('rejects a non-UTM CRS, a bad currency and unknown fields', async () => {
    const base = { name: 'P', client: 'C', crsEpsg: 32636, currency: 'EGP', locale: 'ar' };
    for (const body of [
      { ...base, crsEpsg: 4326 },
      { ...base, currency: 'egp' },
      { ...base, id: randomUUID() },
      { ...base, name: '   ' },
    ]) {
      const res = await http()
        .post('/admin/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it('edits name, client and locale with a before/after event; the CRS and currency stay fixed', async () => {
    const id = await createProject();
    const res = await http()
      .patch(`/admin/projects/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed', locale: 'en' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Renamed', locale: 'en', crsEpsg: 32636 });
    const { rows } = await ctx.pool.query(
      `SELECT payload FROM events WHERE entity_id = $1 AND type = 'project.updated'`,
      [id],
    );
    expect(rows[0].payload).toEqual({
      before: { name: expect.any(String), locale: 'ar' },
      after: { name: 'Renamed', locale: 'en' },
    });

    for (const body of [{ crsEpsg: 32635 }, { currency: 'USD' }, {}]) {
      const bad = await http()
        .patch(`/admin/projects/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body);
      expect(bad.status).toBe(400);
    }
    const missing = await http()
      .patch(`/admin/projects/${MISSING}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'X' });
    expect(missing.status).toBe(404);
  });
});

describe('zones (name only)', () => {
  it('creates a named zone without a boundary and refuses a duplicate name', async () => {
    const id = await createProject();
    const created = await http()
      .post(`/admin/projects/${id}/zones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'القطاع ١' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'القطاع ١', hasBoundary: false });

    const duplicate = await http()
      .post(`/admin/projects/${id}/zones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: ' القطاع ١ ' });
    expect(duplicate.status).toBe(409);

    const list = await http()
      .get(`/admin/projects/${id}/zones`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.items).toHaveLength(1);

    const missing = await http()
      .post(`/admin/projects/${MISSING}/zones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Z' });
    expect(missing.status).toBe(404);
  });
});

describe('users', () => {
  it('creates a non-admin user with an argon2id hash who can log in', async () => {
    const email = uniqueEmail('Mixed.Case').replace('mixed', 'Mixed');
    const res = await http()
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, displayName: 'مستخدم', password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      email: email.toLowerCase(),
      displayName: 'مستخدم',
      isAdmin: false,
      isActive: true,
      locale: 'ar',
    });
    expect(res.body).not.toHaveProperty('passwordHash');

    const { rows } = await ctx.pool.query(
      'SELECT password_hash, is_admin FROM users WHERE id = $1',
      [res.body.id],
    );
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].is_admin).toBe(false);

    const events = await ctx.pool.query('SELECT payload FROM events WHERE entity_id = $1', [
      res.body.id,
    ]);
    expect(JSON.stringify(events.rows)).not.toContain(PASSWORD);
    expect((await login(email.toLowerCase())).status).toBe(200);
  });

  it('refuses isAdmin, a short password and a duplicate email (any case)', async () => {
    const { email } = await createUser();
    for (const body of [
      { email: uniqueEmail('a'), displayName: 'A', password: PASSWORD, isAdmin: true },
      { email: uniqueEmail('b'), displayName: 'B', password: 'short-pass1' },
    ]) {
      const res = await http()
        .post('/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body);
      expect(res.status).toBe(400);
    }
    const duplicate = await http()
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: email.toUpperCase(), displayName: 'Dup', password: PASSWORD });
    expect(duplicate.status).toBe(409);
  });

  it('lists users without password hashes', async () => {
    const res = await http().get('/admin/users').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(2);
    expect(JSON.stringify(res.body)).not.toContain('argon2');
  });

  it('deactivation ends sessions, project access and login; reactivation restores login', async () => {
    const user = await createUser();
    await http()
      .post(`/admin/projects/${seeded.a}/assignments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: user.id, role: 'qc' })
      .expect(201);
    const pair = TokenPairSchema.parse((await login(user.email)).body);
    await http()
      .get(`/projects/${seeded.a}`)
      .set('Authorization', `Bearer ${pair.accessToken}`)
      .expect(200);

    const res = await http()
      .post(`/admin/users/${user.id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);

    // The access token is still unexpired, but it no longer opens the project.
    const project = await http()
      .get(`/projects/${seeded.a}`)
      .set('Authorization', `Bearer ${pair.accessToken}`);
    expect(project.status).toBe(403);
    const refreshed = await http().post('/auth/refresh').send({ refreshToken: pair.refreshToken });
    expect(refreshed.status).toBe(401);
    expect((await login(user.email)).status).toBe(401);
    expect(await eventTypes(ctx.pool, user.id)).toContain('user.deactivated');

    await http()
      .post(`/admin/users/${user.id}/reactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((await login(user.email)).status).toBe(200);
  });

  it('cannot deactivate an admin, yourself, or an unknown user', async () => {
    const { rows } = await ctx.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
      SEED_LOGINS.admin[0],
    ]);
    const self = await http()
      .post(`/admin/users/${rows[0]?.id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(self.status).toBe(403);

    const otherAdmin = await ctx.pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, is_admin)
       VALUES ($1, 'Other admin', 'x', true) RETURNING id`,
      [uniqueEmail('otheradmin')],
    );
    const admin = await http()
      .post(`/admin/users/${otherAdmin.rows[0]?.id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(admin.status).toBe(403);

    const missing = await http()
      .post(`/admin/users/${MISSING}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(missing.status).toBe(404);
    const malformed = await http()
      .post('/admin/users/not-a-uuid/deactivate')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(malformed.status).toBe(400);
  });
});

describe('assignments', () => {
  const assign = (projectId: string, body: object) =>
    http()
      .post(`/admin/projects/${projectId}/assignments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

  it('assigns a project-wide role, shows it in /auth/me, refuses duplicates and removes it', async () => {
    const projectId = await createProject();
    const user = await createUser();
    const created = await assign(projectId, { userId: user.id, role: 'pm' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ userId: user.id, role: 'pm', zoneId: null });
    expect(await eventTypes(ctx.pool, created.body.id)).toEqual(['assignment.created']);

    const token = TokenPairSchema.parse((await login(user.email)).body).accessToken;
    const me = MeResponseSchema.parse(
      (await http().get('/auth/me').set('Authorization', `Bearer ${token}`)).body,
    );
    expect(me.memberships).toEqual([
      expect.objectContaining({ projectId, role: 'pm', zoneIds: [] }),
    ]);

    expect((await assign(projectId, { userId: user.id, role: 'pm' })).status).toBe(409);

    const list = await http()
      .get(`/admin/projects/${projectId}/assignments`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.items).toEqual([
      expect.objectContaining({ id: created.body.id, userEmail: user.email, userIsActive: true }),
    ]);

    const removed = await http()
      .delete(`/admin/projects/${projectId}/assignments/${created.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(removed.status).toBe(204);
    expect(await eventTypes(ctx.pool, created.body.id)).toEqual([
      'assignment.created',
      'assignment.removed',
    ]);
    const after = await http()
      .get(`/projects/${projectId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(403);
  });

  it('a supervisor needs a zone of the same project, and the zone opens the project', async () => {
    const projectId = await createProject();
    const user = await createUser();
    expect((await assign(projectId, { userId: user.id, role: 'supervisor' })).status).toBe(400);
    expect(
      (await assign(projectId, { userId: user.id, role: 'pm', zoneId: seeded.zone })).status,
    ).toBe(400);

    const foreign = await assign(projectId, {
      userId: user.id,
      role: 'supervisor',
      zoneId: seeded.zone,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.details).toEqual({ reason: 'ZONE_NOT_IN_PROJECT' });

    const zone = await http()
      .post(`/admin/projects/${projectId}/zones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Zone A' });
    const ok = await assign(projectId, {
      userId: user.id,
      role: 'supervisor',
      zoneId: zone.body.id,
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ zoneId: zone.body.id, zoneName: 'Zone A' });

    const token = TokenPairSchema.parse((await login(user.email)).body).accessToken;
    await http().get(`/projects/${projectId}`).set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('refuses the admin role, admins, deactivated users and unknown ids', async () => {
    const user = await createUser();
    expect((await assign(seeded.b, { userId: user.id, role: 'admin' })).status).toBe(400);

    const { rows } = await ctx.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
      SEED_LOGINS.admin[0],
    ]);
    const admin = await assign(seeded.b, { userId: rows[0]?.id, role: 'pm' });
    expect(admin.status).toBe(400);
    expect(admin.body.details).toEqual({ reason: 'USER_IS_ADMIN' });

    const inactive = await createUser();
    await http()
      .post(`/admin/users/${inactive.id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const refused = await assign(seeded.b, { userId: inactive.id, role: 'qc' });
    expect(refused.status).toBe(400);
    expect(refused.body.details).toEqual({ reason: 'USER_INACTIVE' });

    expect((await assign(seeded.b, { userId: MISSING, role: 'qc' })).status).toBe(404);
    expect((await assign(MISSING, { userId: user.id, role: 'qc' })).status).toBe(404);
    const list = await http()
      .get(`/admin/projects/${MISSING}/assignments`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(404);
  });

  it('cannot remove an assignment through another project id (IDOR)', async () => {
    const user = await createUser();
    const created = await assign(seeded.a, { userId: user.id, role: 'qc' });
    expect(created.status).toBe(201);
    const crossProject = await http()
      .delete(`/admin/projects/${seeded.b}/assignments/${created.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(crossProject.status).toBe(404);
    const { rows } = await ctx.pool.query('SELECT 1 FROM assignments WHERE id = $1', [
      created.body.id,
    ]);
    expect(rows).toHaveLength(1);
  });
});
