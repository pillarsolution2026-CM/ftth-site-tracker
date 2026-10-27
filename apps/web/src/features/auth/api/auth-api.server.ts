import {
  ApiErrorSchema,
  MeResponseSchema,
  TokenPairSchema,
  type ApiError,
  type LoginRequest,
  type MeResponse,
  type TokenPair,
} from '@ftth/shared';
import type { z } from 'zod';
import { apiUrl } from '@/shared/config/server-env';

/** Server-side client for the FTTH API auth endpoints. Never imported by browser code. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError };

const INTERNAL: ApiError = { code: 'INTERNAL', message: 'Unexpected API response' };

async function call<T>(
  path: string,
  init: RequestInit,
  schema: z.ZodType<T> | null,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl()}${path}`, { ...init, cache: 'no-store' });
  } catch {
    return { ok: false, status: 502, error: INTERNAL };
  }

  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(await response.json().catch(() => null));
    return { ok: false, status: response.status, error: parsed.success ? parsed.data : INTERNAL };
  }
  if (!schema) return { ok: true, data: undefined as T };

  const parsed = schema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, status: 502, error: INTERNAL };
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function apiLogin(body: LoginRequest): Promise<ApiResult<TokenPair>> {
  return call('/auth/login', json(body), TokenPairSchema);
}

export function apiRefresh(refreshToken: string): Promise<ApiResult<TokenPair>> {
  return call('/auth/refresh', json({ refreshToken }), TokenPairSchema);
}

export function apiLogout(refreshToken: string): Promise<ApiResult<undefined>> {
  return call<undefined>('/auth/logout', json({ refreshToken }), null);
}

export function apiMe(accessToken: string): Promise<ApiResult<MeResponse>> {
  return call(
    '/auth/me',
    { headers: { authorization: `Bearer ${accessToken}` } },
    MeResponseSchema,
  );
}
