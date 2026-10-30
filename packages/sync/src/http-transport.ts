import {
  ApiErrorSchema,
  PhotoUploadStatusSchema,
  SyncChangesResponseSchema,
  SyncPushResponseSchema,
  UPLOAD_OFFSET_HEADER,
  type PhotoUploadStatus,
  type SyncChangesResponse,
  type SyncPushRequest,
  type SyncPushResponse,
} from '@ftth/shared';
import type { ZodType } from 'zod';
import { TransportError, type SyncTransport } from './ports.js';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpTransportOptions {
  /** API origin, e.g. https://api.ftthtracker.projectflow.site */
  baseUrl: string;
  projectId: string;
  getAccessToken(): Promise<string | null>;
  fetch?: FetchLike;
  /** Aborts a request that takes longer (weak networks must not hang a sync round). */
  timeoutMs?: number;
}

/** `SyncTransport` over the API's sync endpoints (`/projects/:projectId/sync/*`). */
export function createHttpTransport(options: HttpTransportOptions): SyncTransport {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const root = `${options.baseUrl.replace(/\/+$/, '')}/projects/${options.projectId}/sync`;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function call<T>(path: string, init: RequestInit, schema: ZodType<T>): Promise<T> {
    const token = await options.getAccessToken();
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${root}${path}`, { ...init, headers, signal: controller.signal });
    } catch {
      throw new TransportError('network');
    } finally {
      clearTimeout(timer);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const error = ApiErrorSchema.safeParse(body);
      throw new TransportError(
        'http',
        response.status,
        error.success ? error.data.code : null,
        error.success ? error.data.details : undefined,
        error.success ? error.data.message : `HTTP ${response.status}`,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new TransportError('http', response.status, 'INTERNAL', undefined, 'Bad response');
    }
    return parsed.data;
  }

  return {
    push: (request: SyncPushRequest): Promise<SyncPushResponse> =>
      call(
        '/push',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        SyncPushResponseSchema,
      ),
    changes: (cursor: string, limit: number): Promise<SyncChangesResponse> =>
      call(
        `/changes?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
        { method: 'GET' },
        SyncChangesResponseSchema,
      ),
    photoStatus: (photoId: string): Promise<PhotoUploadStatus> =>
      call(`/photos/${encodeURIComponent(photoId)}`, { method: 'GET' }, PhotoUploadStatusSchema),
    putPhotoChunk: (
      photoId: string,
      offset: number,
      bytes: Uint8Array,
    ): Promise<PhotoUploadStatus> =>
      call(
        `/photos/${encodeURIComponent(photoId)}/content`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            [UPLOAD_OFFSET_HEADER]: String(offset),
          },
          body: bytes as unknown as BodyInit,
        },
        PhotoUploadStatusSchema,
      ),
  };
}
