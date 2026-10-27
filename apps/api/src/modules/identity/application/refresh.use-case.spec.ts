import { describe, expect, it } from 'vitest';
import {
  FakeAccessTokens,
  FakeClock,
  FakeHasher,
  FakeRefreshTokenFactory,
  InMemoryEventLog,
  InMemoryRefreshTokens,
  InMemoryUsers,
  makeUser,
} from '../testing/in-memory.js';
import { LoginUseCase } from './login.use-case.js';
import { LogoutUseCase } from './logout.use-case.js';
import { RefreshUseCase } from './refresh.use-case.js';
import { SessionIssuer } from './session-issuer.js';

function setup() {
  const user = makeUser();
  const users = new InMemoryUsers([user]);
  const refreshTokens = new InMemoryRefreshTokens();
  const factory = new FakeRefreshTokenFactory();
  const clock = new FakeClock();
  const sessions = new SessionIssuer(new FakeAccessTokens(), factory, refreshTokens, clock, {
    accessTtlSeconds: 900,
    refreshTtlDays: 30,
  });
  return {
    user,
    refreshTokens,
    clock,
    login: new LoginUseCase(users, new FakeHasher(), sessions, new InMemoryEventLog()),
    refresh: new RefreshUseCase(refreshTokens, factory, users, sessions, clock),
    logout: new LogoutUseCase(refreshTokens, factory, clock),
  };
}

const credentials = { email: 'pm@ftth.local', password: 'Pm#123456' };

describe('RefreshUseCase', () => {
  it('rotates: new pair issued, old token marked rotated, same family', async () => {
    const { login, refresh, refreshTokens } = setup();
    const first = await login.execute(credentials);

    const second = await refresh.execute({ refreshToken: first.refreshToken });

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(refreshTokens.rows).toHaveLength(2);
    expect(refreshTokens.rows[0]?.rotatedAt).not.toBeNull();
    expect(refreshTokens.rows[1]?.rotatedAt).toBeNull();
    expect(refreshTokens.rows[0]?.familyId).toBe(refreshTokens.rows[1]?.familyId);
  });

  it('detects reuse of a rotated token: REFRESH_TOKEN_REUSED and the whole family is revoked', async () => {
    const { login, refresh, refreshTokens } = setup();
    const first = await login.execute(credentials);
    const second = await refresh.execute({ refreshToken: first.refreshToken });

    await expect(refresh.execute({ refreshToken: first.refreshToken })).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSED',
    });

    expect(refreshTokens.rows.every((row) => row.revokedAt !== null)).toBe(true);
    // the legitimately-newest token is dead too
    await expect(refresh.execute({ refreshToken: second.refreshToken })).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('rejects an unknown token with TOKEN_INVALID', async () => {
    const { refresh } = setup();
    await expect(refresh.execute({ refreshToken: 'x'.repeat(48) })).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('rejects an expired token with TOKEN_EXPIRED', async () => {
    const { login, refresh, clock } = setup();
    const first = await login.execute(credentials);
    clock.advanceDays(31);

    await expect(refresh.execute({ refreshToken: first.refreshToken })).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
  });

  it('revokes the family and rejects when the user was deactivated', async () => {
    const { login, refresh, user, refreshTokens } = setup();
    const first = await login.execute(credentials);
    user.isActive = false;

    await expect(refresh.execute({ refreshToken: first.refreshToken })).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
    expect(refreshTokens.rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('treats a lost rotation race as reuse', async () => {
    const { login, refresh, refreshTokens } = setup();
    const first = await login.execute(credentials);
    // Simulate a concurrent request that claims the token between our read and our rotate.
    const originalRotate = refreshTokens.rotate.bind(refreshTokens);
    refreshTokens.rotate = async (...args) => {
      const row = refreshTokens.rows[0];
      if (row) row.rotatedAt = new Date();
      return originalRotate(...args);
    };

    await expect(refresh.execute({ refreshToken: first.refreshToken })).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSED',
    });
    expect(refreshTokens.rows.every((row) => row.revokedAt !== null)).toBe(true);
  });
});

describe('LogoutUseCase', () => {
  it('revokes the family so the token can no longer be refreshed', async () => {
    const { login, refresh, logout } = setup();
    const first = await login.execute(credentials);

    await logout.execute({ refreshToken: first.refreshToken });

    await expect(refresh.execute({ refreshToken: first.refreshToken })).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('is idempotent for unknown tokens', async () => {
    const { logout } = setup();
    await expect(logout.execute({ refreshToken: 'y'.repeat(48) })).resolves.toBeUndefined();
  });
});
