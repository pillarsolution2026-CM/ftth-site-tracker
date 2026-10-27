import { cookies } from 'next/headers';
import { apiLogout } from '@/features/auth/api/auth-api.server';
import { REFRESH_COOKIE, clearSessionCookies } from '@/features/auth/model/session-cookies';

export async function POST() {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;
  // Best effort: the local session ends even if the API is unreachable.
  if (refreshToken) await apiLogout(refreshToken);
  clearSessionCookies(store);
  return new Response(null, { status: 204 });
}
