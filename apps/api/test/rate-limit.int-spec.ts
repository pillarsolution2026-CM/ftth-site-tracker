import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createTestContext, type TestContext } from './support/test-app.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext(inject('databaseUrl'), {
    AUTH_LOGIN_RATE_LIMIT: '5',
    AUTH_REFRESH_RATE_LIMIT: '30',
  });
});
afterAll(async () => {
  await ctx.close();
});

const badLogin = (email: string, forwardedFor?: string) => {
  const req = request(ctx.app.getHttpServer()).post('/auth/login');
  if (forwardedFor) req.set('X-Forwarded-For', forwardedFor);
  return req.send({ email, password: 'wrong-password' });
};

describe('auth rate limiting', () => {
  it('returns 429 RATE_LIMITED with Retry-After on the 6th failed login in a minute', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await badLogin('victim@ftth.local')).status).toBe(401);
    }
    const res = await badLogin('VICTIM@ftth.local');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts other emails separately', async () => {
    expect((await badLogin('someone-else@ftth.local')).status).toBe(401);
  });

  it('does not trust X-Forwarded-For from non-loopback peers but supertest is loopback', async () => {
    // Loopback peer: X-Forwarded-For is honoured, so a different client IP has its own budget.
    const res = await badLogin('victim@ftth.local', '203.0.113.9');
    expect(res.status).toBe(401);
  });

  it('does not limit other routes', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await request(ctx.app.getHttpServer()).get('/health')).status).toBe(200);
    }
  });
});
