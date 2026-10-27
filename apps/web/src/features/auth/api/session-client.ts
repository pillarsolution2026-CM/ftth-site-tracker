import {
  ApiErrorSchema,
  MeResponseSchema,
  type ErrorCode,
  type LoginRequest,
  type MeResponse,
} from '@ftth/shared';

/** Browser-side client for the Next.js session route handlers (never talks to the API directly). */
export class SessionApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
  ) {
    super(code);
    this.name = 'SessionApiError';
  }
}

async function toError(response: Response): Promise<SessionApiError> {
  const parsed = ApiErrorSchema.safeParse(await response.json().catch(() => null));
  return new SessionApiError(parsed.success ? parsed.data.code : 'INTERNAL', response.status);
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new SessionApiError('INTERNAL', 0);
  }
}

export async function login(body: LoginRequest): Promise<void> {
  const response = await request('/api/session/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await toError(response);
}

export async function fetchMe(): Promise<MeResponse> {
  const response = await request('/api/session/me');
  if (!response.ok) throw await toError(response);
  return MeResponseSchema.parse(await response.json());
}

export async function logout(): Promise<void> {
  const response = await request('/api/session/logout', { method: 'POST' });
  if (!response.ok) throw await toError(response);
}
