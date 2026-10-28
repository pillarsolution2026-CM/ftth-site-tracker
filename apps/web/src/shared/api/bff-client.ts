import { ApiErrorSchema, type ErrorCode } from '@ftth/shared';
import type { z } from 'zod';

/**
 * Browser-side client for the BFF proxy (`/api/projects/...`). The browser never sees tokens:
 * the proxy adds them from httpOnly cookies. Every response is parsed with a shared schema.
 */

export type ClientErrorCode = ErrorCode | 'NETWORK';

export class ApiClientError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(code);
    this.name = 'ApiClientError';
  }
}

export function projectApiPath(projectId: string, suffix: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
}

export function toClientError(status: number, body: unknown): ApiClientError {
  const parsed = ApiErrorSchema.safeParse(body);
  return parsed.success
    ? new ApiClientError(parsed.data.code, status, parsed.data.details)
    : new ApiClientError('INTERNAL', status);
}

export function errorCodeOf(error: unknown): ClientErrorCode {
  return error instanceof ApiClientError ? error.code : 'INTERNAL';
}

/** `details.reason` of a 409/422 (e.g. VERSION_MISMATCH, OPEN_ITEMS); null when absent. */
export function errorReasonOf(error: unknown): string | null {
  if (!(error instanceof ApiClientError)) return null;
  const details = error.details;
  if (typeof details !== 'object' || details === null || !('reason' in details)) return null;
  return typeof details.reason === 'string' ? details.reason : null;
}

interface JsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal | undefined;
}

async function send(path: string, options: JsonOptions): Promise<Response> {
  const { method = 'GET', body } = options;
  // Mutations always declare JSON: the proxy's CSRF guard only accepts JSON or multipart.
  const mutating = method !== 'GET';
  try {
    return await fetch(path, {
      method,
      credentials: 'same-origin',
      signal: options.signal ?? null,
      ...(mutating
        ? {
            headers: { 'content-type': 'application/json' },
            ...(method === 'DELETE' ? {} : { body: JSON.stringify(body ?? {}) }),
          }
        : {}),
    });
  } catch {
    throw new ApiClientError('NETWORK', 0);
  }
}

/** Requests that carry a body are not replayed by the proxy; one retry after a token refresh. */
async function sendWithRetry(path: string, options: JsonOptions): Promise<Response> {
  const first = await send(path, options);
  if (first.status !== 401) return first;
  const error = toClientError(
    401,
    await first
      .clone()
      .json()
      .catch(() => null),
  );
  return error.code === 'TOKEN_EXPIRED' ? send(path, options) : first;
}

export async function bffJson<T>(
  path: string,
  schema: z.ZodType<T>,
  options: JsonOptions = {},
): Promise<T> {
  const response = await sendWithRetry(path, options);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toClientError(response.status, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiClientError('INTERNAL', 502);
  return parsed.data;
}

/** For 204 responses. */
export async function bffVoid(path: string, options: JsonOptions = {}): Promise<void> {
  const response = await sendWithRetry(path, options);
  if (!response.ok) throw toClientError(response.status, await response.json().catch(() => null));
}

export interface UploadOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal | undefined;
}

/** multipart upload with progress (XHR: fetch has no upload progress). Retries once on TOKEN_EXPIRED. */
export async function bffUpload<T>(
  path: string,
  form: FormData,
  schema: z.ZodType<T>,
  options: UploadOptions = {},
): Promise<T> {
  const attempt = () => xhrPost(path, form, options);
  let result = await attempt();
  if (result.status === 401 && toClientError(401, result.body).code === 'TOKEN_EXPIRED') {
    result = await attempt();
  }
  if (result.status < 200 || result.status >= 300) throw toClientError(result.status, result.body);
  const parsed = schema.safeParse(result.body);
  if (!parsed.success) throw new ApiClientError('INTERNAL', 502);
  return parsed.data;
}

interface XhrResult {
  status: number;
  body: unknown;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function xhrPost(path: string, form: FormData, options: UploadOptions): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0)
        options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      resolve({ status: xhr.status, body: parseJson(xhr.responseText) });
    };
    xhr.onerror = () => reject(new ApiClientError('NETWORK', 0));
    xhr.onabort = () => reject(new ApiClientError('NETWORK', 0));
    options.signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(form);
  });
}
