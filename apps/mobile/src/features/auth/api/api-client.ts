import {
  ApiErrorSchema,
  MeResponseSchema,
  TokenPairSchema,
  type ErrorCode,
  type LoginRequest,
  type MeResponse,
  type TokenPair,
} from '@ftth/shared';
import type { TokenStorage } from '../../../shared/storage/token-storage';

export type ApiErrorCode = ErrorCode | 'NETWORK';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  storage: TokenStorage;
  fetchFn?: typeof fetch;
}

export interface AuthApi {
  login(credentials: LoginRequest): Promise<TokenPair>;
  me(): Promise<MeResponse>;
  logout(): Promise<void>;
  /** True when a token pair is stored (session may still be expired). */
  hasSession(): Promise<boolean>;
  /** The stored access token for other API clients (sync); null when signed out. */
  accessToken(): Promise<string | null>;
  /** Rotates the token pair after a 401; false when the session is over (sign in again). */
  refreshSession(): Promise<boolean>;
}

export function createAuthApi({ baseUrl, storage, fetchFn }: ApiClientOptions): AuthApi {
  const doFetch: typeof fetch = fetchFn ?? ((...args) => fetch(...args));

  async function send(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; accessToken?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.accessToken) headers.Authorization = `Bearer ${init.accessToken}`;
    try {
      return await doFetch(`${baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new ApiError('NETWORK', 0);
    }
  }

  async function toError(response: Response): Promise<ApiError> {
    let code: ApiErrorCode = response.status === 401 ? 'TOKEN_INVALID' : 'INTERNAL';
    try {
      const parsed = ApiErrorSchema.safeParse(await response.json());
      if (parsed.success) code = parsed.data.code;
    } catch {
      // Body was not JSON; keep the status-based fallback code.
    }
    return new ApiError(code, response.status);
  }

  async function parse<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
    if (!response.ok) throw await toError(response);
    try {
      return schema.parse(await response.json());
    } catch {
      throw new ApiError('INTERNAL', response.status);
    }
  }

  // A single in-flight refresh, shared by concurrent requests, so a rotated token is never reused.
  let refreshing: Promise<TokenPair> | null = null;

  function refresh(): Promise<TokenPair> {
    refreshing ??= (async () => {
      try {
        const current = await storage.read();
        if (!current) throw new ApiError('TOKEN_INVALID', 401);
        const response = await send('/auth/refresh', {
          method: 'POST',
          body: { refreshToken: current.refreshToken },
        });
        const next = await parse(response, TokenPairSchema);
        await storage.write(next);
        return next;
      } catch (error) {
        // A rejected or unreachable-but-definitive refresh ends the session; network errors keep it.
        if (!(error instanceof ApiError) || error.code !== 'NETWORK') await storage.clear();
        throw error;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** Authenticated call. On 401 TOKEN_EXPIRED, rotates the refresh token and retries exactly once. */
  async function authed<T>(
    path: string,
    schema: { parse(value: unknown): T },
    init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
  ): Promise<T> {
    const tokens = await storage.read();
    if (!tokens) throw new ApiError('TOKEN_INVALID', 401);

    const first = await send(path, { ...init, accessToken: tokens.accessToken });
    if (first.status !== 401) return parse(first, schema);

    const firstError = await toError(first);
    if (firstError.code !== 'TOKEN_EXPIRED') throw firstError;

    const renewed = await refresh();
    const second = await send(path, { ...init, accessToken: renewed.accessToken });
    return parse(second, schema);
  }

  return {
    async login(credentials) {
      const response = await send('/auth/login', { method: 'POST', body: credentials });
      const tokens = await parse(response, TokenPairSchema);
      await storage.write(tokens);
      return tokens;
    },

    me: () => authed('/auth/me', MeResponseSchema),

    async logout() {
      const tokens = await storage.read();
      try {
        if (tokens) {
          await send('/auth/logout', {
            method: 'POST',
            body: { refreshToken: tokens.refreshToken },
            accessToken: tokens.accessToken,
          });
        }
      } catch {
        // Offline logout still clears the local session.
      } finally {
        await storage.clear();
      }
    },

    async hasSession() {
      return (await storage.read()) !== null;
    },

    async accessToken() {
      return (await storage.read())?.accessToken ?? null;
    },

    async refreshSession() {
      try {
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
  };
}
