import { cookies } from 'next/headers';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookies,
  setSessionCookies,
} from '@/features/auth/model/session-cookies';
import { apiUrl } from '@/shared/config/server-env';
import { contractorUpstreamPath } from '@/shared/server/contractor-proxy-path';
import { createApiProxy } from '@/shared/server/api-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { params: Promise<{ path: string[] }> };

/** BFF for the contractor's read-only view (`GET /contractor/me`, ADR-053). */
async function handle(request: Request, context: Context): Promise<Response> {
  const store = await cookies();
  const proxy = createApiProxy({
    apiUrl: apiUrl(),
    session: {
      accessToken: () => store.get(ACCESS_COOKIE)?.value,
      refreshToken: () => store.get(REFRESH_COOKIE)?.value,
      save: (pair) => setSessionCookies(store, pair),
      clear: () => clearSessionCookies(store),
    },
    resolvePath: contractorUpstreamPath,
  });
  const { path } = await context.params;
  return proxy(request, path);
}

export const GET = handle;
