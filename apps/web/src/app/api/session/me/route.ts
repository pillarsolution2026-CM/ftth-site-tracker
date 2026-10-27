import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiMe, apiRefresh } from '@/features/auth/api/auth-api.server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookies,
  setSessionCookies,
} from '@/features/auth/model/session-cookies';

export const dynamic = 'force-dynamic';

export async function GET() {
  const store = await cookies();
  const accessToken = store.get(ACCESS_COOKIE)?.value;
  const refreshToken = store.get(REFRESH_COOKIE)?.value;

  if (accessToken) {
    const first = await apiMe(accessToken);
    if (first.ok) return NextResponse.json(first.data);
    if (first.error.code !== 'TOKEN_EXPIRED') {
      return NextResponse.json(first.error, { status: first.status });
    }
  }

  // The access cookie expires together with the token, so "missing" means "expired".
  if (!refreshToken) {
    return NextResponse.json({ code: 'TOKEN_INVALID', message: 'No session' }, { status: 401 });
  }

  const refreshed = await apiRefresh(refreshToken);
  if (!refreshed.ok) {
    clearSessionCookies(store);
    return NextResponse.json(refreshed.error, { status: refreshed.status });
  }
  setSessionCookies(store, refreshed.data);

  const retry = await apiMe(refreshed.data.accessToken);
  return retry.ok
    ? NextResponse.json(retry.data)
    : NextResponse.json(retry.error, { status: retry.status });
}
