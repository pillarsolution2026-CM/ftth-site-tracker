import type { TokenPair } from '@ftth/shared';

export const ACCESS_COOKIE = 'ftth_at';
export const REFRESH_COOKIE = 'ftth_rt';
/** Refresh tokens live 30 days (ADR-007). */
export const REFRESH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface CookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
}

/** The subset of Next's cookie store the helper needs (keeps it unit-testable). */
export interface CookieWriter {
  set(name: string, value: string, options: CookieOptions): unknown;
  delete(name: string): unknown;
}

function baseOptions(maxAge: number, production: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: production, path: '/', maxAge };
}

export function setSessionCookies(
  store: CookieWriter,
  pair: TokenPair,
  production: boolean = process.env.NODE_ENV === 'production',
): void {
  store.set(ACCESS_COOKIE, pair.accessToken, baseOptions(pair.expiresIn, production));
  store.set(REFRESH_COOKIE, pair.refreshToken, baseOptions(REFRESH_MAX_AGE_SECONDS, production));
}

export function clearSessionCookies(store: CookieWriter): void {
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
}
