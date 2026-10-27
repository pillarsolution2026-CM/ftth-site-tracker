import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
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
import { SessionIssuer } from './session-issuer.js';

function setup() {
  const user = makeUser();
  const users = new InMemoryUsers([user]);
  const hasher = new FakeHasher();
  const refreshTokens = new InMemoryRefreshTokens();
  const events = new InMemoryEventLog();
  const sessions = new SessionIssuer(
    new FakeAccessTokens(),
    new FakeRefreshTokenFactory(),
    refreshTokens,
    new FakeClock(),
    { accessTtlSeconds: 900, refreshTtlDays: 30 },
  );
  return {
    user,
    users,
    hasher,
    refreshTokens,
    events,
    useCase: new LoginUseCase(users, hasher, sessions, events),
  };
}

describe('LoginUseCase', () => {
  it('returns a token pair, stores only the refresh hash and logs user.logged_in', async () => {
    const { useCase, user, refreshTokens, events } = setup();

    const pair = await useCase.execute({ email: 'PM@ftth.local', password: 'Pm#123456' });

    expect(pair.accessToken).toBe(`jwt:${user.id}:false`);
    expect(pair.expiresIn).toBe(900);
    expect(refreshTokens.rows).toHaveLength(1);
    expect(refreshTokens.rows[0]?.tokenHash).not.toBe(pair.refreshToken);
    expect(events.events).toEqual([
      expect.objectContaining({ type: 'user.logged_in', entityId: user.id, actorId: user.id }),
    ]);
  });

  it('rejects a wrong password with INVALID_CREDENTIALS and no session', async () => {
    const { useCase, refreshTokens, events } = setup();

    await expect(
      useCase.execute({ email: 'pm@ftth.local', password: 'wrong-password' }),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(refreshTokens.rows).toHaveLength(0);
    expect(events.events).toHaveLength(0);
  });

  it('gives unknown email the same error and still performs a hash verification', async () => {
    const { useCase, hasher } = setup();

    const error = await useCase
      .execute({ email: 'nobody@ftth.local', password: 'whatever-pass' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    });
    expect(hasher.verifyCalls).toBe(1);
  });

  it('rejects inactive users even with the right password', async () => {
    const { useCase, user } = setup();
    user.isActive = false;

    await expect(
      useCase.execute({ email: 'pm@ftth.local', password: 'Pm#123456' }),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });
});
