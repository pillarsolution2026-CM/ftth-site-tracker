import { ApiErrorSchema, TokenPairSchema, type TokenPair } from '@ftth/shared';
import { isTrustedProxyMutation } from '@/features/auth/model/csrf-guard';

/**
 * BFF proxy for project-scoped API calls. The browser sends only its httpOnly session cookies;
 * this module adds the Bearer token, refreshes it once when missing/expired, and streams request
 * and response bodies (uploads of 100 MB and file downloads are never buffered).
 */

export interface SessionStore {
  accessToken(): string | undefined;
  refreshToken(): string | undefined;
  save(pair: TokenPair): void;
  clear(): void;
}

export interface ProxyDeps {
  /** Base URL of the API without trailing slash. */
  apiUrl: string;
  fetchImpl?: typeof fetch;
  session: SessionStore;
  /** Maps the catch-all segments to an upstream path (null = not exposed). Default: `upstreamPath`. */
  resolvePath?: (segments: readonly string[]) => string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]{1,128}$/;
/** Resources a project-scoped proxied call may reach (everything else is not exposed). */
const ALLOWED_RESOURCES = new Set(['work-orders', 'cad-files', 'design-revisions']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// `range` lets PMTiles clients read byte ranges of `…/tiles.pmtiles` (the API answers 206).
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'content-length',
  'accept',
  'accept-language',
  'range',
];
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'etag',
  'last-modified',
  'content-range',
  'accept-ranges',
];

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: { 'cache-control': 'no-store' } });
}

/** `[projectId, resource, ...rest]` → upstream path, or null when it is not allowed. */
export function upstreamPath(segments: readonly string[]): string | null {
  const [projectId, resource, ...rest] = segments;
  if (!projectId || !UUID.test(projectId)) return null;
  if (!resource || !ALLOWED_RESOURCES.has(resource)) return null;
  const all = [projectId, resource, ...rest];
  // "." and ".." match the safe pattern but would climb out of the prefix.
  if (!all.every((segment) => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..')) {
    return null;
  }
  return `/projects/${all.map(encodeURIComponent).join('/')}`;
}

// Concurrent requests share one refresh: refresh tokens rotate, so a second refresh with the
// same token would look like token reuse and end the session.
const inflightRefresh = new Map<string, Promise<TokenPair | null>>();

async function refreshOnce(deps: ProxyDeps, fetchImpl: typeof fetch): Promise<TokenPair | null> {
  const refreshToken = deps.session.refreshToken();
  if (!refreshToken) return null;
  let pending = inflightRefresh.get(refreshToken);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetchImpl(`${deps.apiUrl}/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
          cache: 'no-store',
        });
        if (!response.ok) return null;
        const parsed = TokenPairSchema.safeParse(await response.json().catch(() => null));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      } finally {
        // Keep the result around briefly for requests that raced with this one.
        setTimeout(() => inflightRefresh.delete(refreshToken), 5_000).unref?.();
      }
    })();
    inflightRefresh.set(refreshToken, pending);
  }
  const pair = await pending;
  if (pair) deps.session.save(pair);
  else deps.session.clear();
  return pair;
}

function upstreamHeaders(request: Request, accessToken: string): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('authorization', `Bearer ${accessToken}`);
  return headers;
}

function toClientResponse(upstream: Response): Response {
  const headers = new Headers({
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  const noBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  // The body is piped as a stream, never read into memory.
  return new Response(noBody ? null : upstream.body, { status: upstream.status, headers });
}

async function isTokenExpired(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  const parsed = ApiErrorSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => null),
  );
  return parsed.success && parsed.data.code === 'TOKEN_EXPIRED';
}

export function createApiProxy(deps: ProxyDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function call(
    request: Request,
    path: string,
    accessToken: string,
    body: ReadableStream | null,
  ): Promise<Response> {
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers: upstreamHeaders(request, accessToken),
      redirect: 'manual',
      cache: 'no-store',
    };
    if (body) {
      init.body = body;
      init.duplex = 'half';
    }
    return fetchImpl(`${deps.apiUrl}${path}${new URL(request.url).search}`, init);
  }

  return async function handle(request: Request, segments: readonly string[]): Promise<Response> {
    if (!METHODS.has(request.method)) {
      return errorResponse(405, 'FORBIDDEN', 'Method not allowed');
    }
    const path = (deps.resolvePath ?? upstreamPath)(segments);
    if (!path) return errorResponse(404, 'NOT_FOUND', 'Not found');
    if (request.method !== 'GET' && !isTrustedProxyMutation(request)) {
      return errorResponse(403, 'FORBIDDEN', 'Forbidden');
    }

    // The access cookie expires together with the token, so "missing" means "expired".
    let accessToken = deps.session.accessToken();
    if (!accessToken) {
      const pair = await refreshOnce(deps, fetchImpl);
      if (!pair) return errorResponse(401, 'TOKEN_INVALID', 'No session');
      accessToken = pair.accessToken;
    }

    // A request body is a one-shot stream, so it cannot be replayed after a 401.
    const hasBody =
      request.method !== 'GET' && request.method !== 'DELETE' && request.body !== null;
    let upstream: Response;
    try {
      upstream = await call(request, path, accessToken, hasBody ? request.body : null);
    } catch {
      return errorResponse(502, 'INTERNAL', 'Upstream unavailable');
    }

    if (await isTokenExpired(upstream)) {
      const pair = await refreshOnce(deps, fetchImpl);
      if (!pair) return errorResponse(401, 'TOKEN_INVALID', 'Session expired');
      if (hasBody) {
        // Cookies are renewed; the browser client repeats the upload once.
        return toClientResponse(upstream);
      }
      try {
        upstream = await call(request, path, pair.accessToken, null);
      } catch {
        return errorResponse(502, 'INTERNAL', 'Upstream unavailable');
      }
    }
    return toClientResponse(upstream);
  };
}
