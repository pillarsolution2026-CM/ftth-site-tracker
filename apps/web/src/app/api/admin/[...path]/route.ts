import { cookies } from 'next/headers';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookies,
  setSessionCookies,
} from '@/features/auth/model/session-cookies';
import { apiUrl } from '@/shared/config/server-env';
import { adminUpstreamPath } from '@/shared/server/admin-proxy-path';
import { createApiProxy } from '@/shared/server/api-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { params: Promise<{ path: string[] }> };

/** BFF for the platform-admin routes (`/admin/...`); same session and CSRF rules as projects. */
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
    resolvePath: adminUpstreamPath,
  });
  const { path } = await context.params;
  return proxy(request, path);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
