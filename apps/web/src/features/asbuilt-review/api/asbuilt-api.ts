import {
  AsBuiltEditDetailSchema,
  AsBuiltEditListResponseSchema,
  AsBuiltEditSchema,
  AsBuiltExportListResponseSchema,
  AsBuiltExportSchema,
  type AsBuiltEdit,
  type AsBuiltEditDetail,
  type AsBuiltEditListResponse,
  type AsBuiltExport,
  type AsBuiltExportListResponse,
  type RejectAsBuiltEditRequest,
} from '@ftth/shared';
import { toQueryString } from '@/features/cad-files/api/cad-api';
import { bffJson, projectApiPath } from '@/shared/api/bff-client';
import type { EditListParams } from '../model/review-model';

const root = (projectId: string) => projectApiPath(projectId, '/asbuilt');
const edit = (projectId: string, id: string) =>
  `${root(projectId)}/edits/${encodeURIComponent(id)}`;
const exportOne = (projectId: string, id: string) =>
  `${root(projectId)}/exports/${encodeURIComponent(id)}`;

export function listAsBuiltEdits(
  projectId: string,
  query: EditListParams,
): Promise<AsBuiltEditListResponse> {
  return bffJson(
    `${root(projectId)}/edits${toQueryString({ ...query })}`,
    AsBuiltEditListResponseSchema,
  );
}

export function getAsBuiltEdit(projectId: string, id: string): Promise<AsBuiltEditDetail> {
  return bffJson(edit(projectId, id), AsBuiltEditDetailSchema);
}

export function approveAsBuiltEdit(projectId: string, id: string): Promise<AsBuiltEdit> {
  return bffJson(`${edit(projectId, id)}/approve`, AsBuiltEditSchema, {
    method: 'POST',
    body: {},
  });
}

export function rejectAsBuiltEdit(
  projectId: string,
  id: string,
  body: RejectAsBuiltEditRequest,
): Promise<AsBuiltEdit> {
  return bffJson(`${edit(projectId, id)}/reject`, AsBuiltEditSchema, { method: 'POST', body });
}

export function listAsBuiltExports(projectId: string): Promise<AsBuiltExportListResponse> {
  return bffJson(`${root(projectId)}/exports`, AsBuiltExportListResponseSchema);
}

export function requestAsBuiltExport(projectId: string): Promise<AsBuiltExport> {
  return bffJson(`${root(projectId)}/exports`, AsBuiltExportSchema, { method: 'POST', body: {} });
}

/** Plain link to the DXF; the browser sends its session cookie to the proxy (attachment). */
export function asBuiltExportFileUrl(projectId: string, id: string): string {
  return `${exportOne(projectId, id)}/file`;
}
