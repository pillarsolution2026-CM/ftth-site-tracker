import { cookies } from 'next/headers';
import { apiLogout } from '@/features/auth/api/auth-api.server';
import { isTrustedSessionRequest } from '@/features/auth/model/csrf-guard';
import { REFRESH_COOKIE, clearSessionCookies } from '@/features/auth/model/session-cookies';

export async function POST(request: Request) {
  if (!isTrustedSessionRequest(request)) {
    return Response.json({ code: 'FORBIDDEN', message: 'Forbidden' }, { status: 403 });
  }
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;
  // Best effort: the local session ends even if the API is unreachable.
  if (refreshToken) await apiLogout(refreshToken);
  clearSessionCookies(store);
  return new Response(null, { status: 204 });
}
