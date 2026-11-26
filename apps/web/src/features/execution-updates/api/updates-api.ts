import { UpdateListResponseSchema, type UpdateListResponse } from '@ftth/shared';
import { toQueryString } from '@/features/cad-files/api/cad-api';
import { bffJson, projectApiPath } from '@/shared/api/bff-client';
import type { listQuery } from '../model/update-list-model';

const root = (projectId: string) => projectApiPath(projectId, '/execution-updates');

export function listUpdates(
  projectId: string,
  query: ReturnType<typeof listQuery>,
): Promise<UpdateListResponse> {
  return bffJson(`${root(projectId)}${toQueryString({ ...query })}`, UpdateListResponseSchema);
}

/** Plain URL of a stored photo; the browser sends its session cookie to the proxy. */
export function updatePhotoUrl(projectId: string, photoId: string): string {
  return `${root(projectId)}/photos/${encodeURIComponent(photoId)}`;
}
