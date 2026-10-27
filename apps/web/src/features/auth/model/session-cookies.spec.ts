import { describe, expect, it, vi } from 'vitest';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE_SECONDS,
  clearSessionCookies,
  setSessionCookies,
} from './session-cookies';

const pair = { accessToken: 'access-jwt', refreshToken: 'r'.repeat(40), expiresIn: 900 };

function fakeStore() {
  return { set: vi.fn(), delete: vi.fn() };
}

describe('session cookies', () => {
  it('stores both tokens httpOnly and SameSite=Lax', () => {
    const store = fakeStore();
    setSessionCookies(store, pair, false);

    expect(store.set).toHaveBeenCalledWith(ACCESS_COOKIE, 'access-jwt', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: 900,
    });
    expect(store.set).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      pair.refreshToken,
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', maxAge: REFRESH_MAX_AGE_SECONDS }),
    );
  });

  it('marks cookies Secure in production', () => {
    const store = fakeStore();
    setSessionCookies(store, pair, true);
    for (const call of store.set.mock.calls) {
      expect(call[2]).toMatchObject({ secure: true });
    }
  });

  it('clears both cookies', () => {
    const store = fakeStore();
    clearSessionCookies(store);
    expect(store.delete).toHaveBeenCalledWith(ACCESS_COOKIE);
    expect(store.delete).toHaveBeenCalledWith(REFRESH_COOKIE);
  });
});
