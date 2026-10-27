import { createHash } from 'node:crypto';
import { MeResponseSchema, TokenPairSchema, type MeResponse, type TokenPair } from '@ftth/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createTestContext, type TestContext } from './support/test-app.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'));
});
afterAll(async () => {
  await ctx.close();
});

async function login(email: string, password: string): Promise<TokenPair> {
  const res = await request(ctx.app.getHttpServer()).post('/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return TokenPairSchema.parse(res.body);
}

const refresh = (refreshToken: string) =>
  request(ctx.app.getHttpServer()).post('/auth/refresh').send({ refreshToken });

async function backdateRotation(refreshToken: string, seconds: number): Promise<void> {
  const hash = createHash('sha256').update(refreshToken).digest('hex');
  await ctx.pool.query(
    `UPDATE refresh_tokens SET rotated_at = rotated_at - make_interval(secs => $2) WHERE token_hash = $1`,
    [hash, seconds],
  );
}

describe('POST /auth/login', () => {
  it('logs in the seeded admin and returns a token pair', async () => {
    const pair = await login('admin@ftth.local', 'Admin#12345');
    expect(pair.expiresIn).toBe(900);
    expect(pair.accessToken.split('.')).toHaveLength(3);
  });

  it('stores only the SHA-256 hash of the refresh token', async () => {
    const pair = await login('pm@ftth.local', 'Pm#123456');
    const hash = createHash('sha256').update(pair.refreshToken).digest('hex');
    const { rows } = await ctx.pool.query(
      'SELECT token_hash FROM refresh_tokens WHERE token_hash = $1',
      [hash],
    );
    expect(rows).toHaveLength(1);
    const plain = await ctx.pool.query('SELECT 1 FROM refresh_tokens WHERE token_hash = $1', [
      pair.refreshToken,
    ]);
    expect(plain.rows).toHaveLength(0);
  });

  it('writes a user.logged_in event', async () => {
    const before = await ctx.pool.query(
      "SELECT count(*)::int AS n FROM events WHERE type = 'user.logged_in'",
    );
    await login('supervisor@ftth.local', 'Super#12345');
    const after = await ctx.pool.query(
      "SELECT count(*)::int AS n FROM events WHERE type = 'user.logged_in'",
    );
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('answers wrong password and unknown email identically with 401 INVALID_CREDENTIALS', async () => {
    const wrongPassword = await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin@ftth.local', password: 'Not-the-password' });
    const unknownEmail = await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ghost@ftth.local', password: 'Not-the-password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 400 VALIDATION_FAILED for a malformed body', async () => {
    const res = await request(ctx.app.getHttpServer()).post('/auth/login').send({ email: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /auth/refresh and /auth/logout', () => {
  it('rotates the refresh token', async () => {
    const first = await login('pm@ftth.local', 'Pm#123456');

    const res = await refresh(first.refreshToken);

    expect(res.status).toBe(200);
    const second = TokenPairSchema.parse(res.body);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await refresh(second.refreshToken)).status).toBe(200);
  });

  it('re-presenting a just-rotated token (inside the grace window) is 401 TOKEN_INVALID and keeps the family', async () => {
    const first = await login('pm@ftth.local', 'Pm#123456');
    const second = TokenPairSchema.parse((await refresh(first.refreshToken)).body);

    const retry = await refresh(first.refreshToken);
    expect(retry.status).toBe(401);
    expect(retry.body.code).toBe('TOKEN_INVALID');

    expect((await refresh(second.refreshToken)).status).toBe(200);
  });

  it('reusing a rotated token returns 401 REFRESH_TOKEN_REUSED and revokes the whole family', async () => {
    const first = await login('pm@ftth.local', 'Pm#123456');
    const second = TokenPairSchema.parse((await refresh(first.refreshToken)).body);
    await backdateRotation(first.refreshToken, 60);

    const reuse = await refresh(first.refreshToken);
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');

    // The newest token of the same family no longer works either.
    const afterRevoke = await refresh(second.refreshToken);
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body.code).toBe('TOKEN_INVALID');

    const hash = createHash('sha256').update(second.refreshToken).digest('hex');
    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS total, count(revoked_at)::int AS revoked
         FROM refresh_tokens
        WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
      [hash],
    );
    expect(rows[0]).toEqual({ total: 2, revoked: 2 });
  });

  it('only one of two concurrent refreshes with the same token succeeds', async () => {
    const first = await login('pm@ftth.local', 'Pm#123456');

    const results = await Promise.all([refresh(first.refreshToken), refresh(first.refreshToken)]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 401]);
  });

  it('rejects an unknown refresh token with 401 TOKEN_INVALID', async () => {
    const res = await refresh('z'.repeat(64));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('logout revokes the family and returns 204', async () => {
    const pair = await login('pm@ftth.local', 'Pm#123456');

    const out = await request(ctx.app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken: pair.refreshToken });
    expect(out.status).toBe(204);

    expect((await refresh(pair.refreshToken)).status).toBe(401);
  });
});

describe('GET /auth/me', () => {
  it('requires a bearer token', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('rejects a garbage token', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('returns the supervisor with a zone-scoped membership', async () => {
    const pair = await login('supervisor@ftth.local', 'Super#12345');

    const res = await request(ctx.app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${pair.accessToken}`);

    expect(res.status).toBe(200);
    const me: MeResponse = MeResponseSchema.parse(res.body);
    expect(me.email).toBe('supervisor@ftth.local');
    expect(me.isAdmin).toBe(false);
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0]).toMatchObject({
      projectName: 'القطاع الأول – قليوب',
      role: 'supervisor',
    });
    expect(me.memberships[0]?.zoneIds).toHaveLength(1);
  });

  it('returns the pm with a project-wide membership (no zones) and admin with none', async () => {
    const pmPair = await login('pm@ftth.local', 'Pm#123456');
    const pm = MeResponseSchema.parse(
      (
        await request(ctx.app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${pmPair.accessToken}`)
      ).body,
    );
    expect(pm.memberships).toEqual([expect.objectContaining({ role: 'pm', zoneIds: [] })]);

    const adminPair = await login('admin@ftth.local', 'Admin#12345');
    const admin = MeResponseSchema.parse(
      (
        await request(ctx.app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${adminPair.accessToken}`)
      ).body,
    );
    expect(admin.isAdmin).toBe(true);
    expect(admin.memberships).toEqual([]);
  });
});
