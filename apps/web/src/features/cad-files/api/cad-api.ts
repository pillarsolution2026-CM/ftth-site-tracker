import {
  CadCurvePageSchema,
  CadFileDetailSchema,
  CadFileListResponseSchema,
  CadFileLogResponseSchema,
  CadFileSummarySchema,
  CadInsertPageSchema,
  CadLayerListResponseSchema,
  CadTextPageSchema,
  type CadCurveListQuery,
  type CadCurvePage,
  type CadFileDetail,
  type CadFileListResponse,
  type CadFileLogResponse,
  type CadFileSummary,
  type CadInsertListQuery,
  type CadInsertPage,
  type CadLayerListResponse,
  type CadTextListQuery,
  type CadTextPage,
} from '@ftth/shared';
import { bffJson, bffUpload, projectApiPath, type UploadOptions } from '@/shared/api/bff-client';

const root = (projectId: string) => projectApiPath(projectId, '/cad-files');
const one = (projectId: string, id: string) => `${root(projectId)}/${encodeURIComponent(id)}`;

/** `?a=1&b=true`; undefined and empty values are left out. */
export function toQueryString(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function listCadFiles(projectId: string): Promise<CadFileListResponse> {
  return bffJson(root(projectId), CadFileListResponseSchema);
}

export function getCadFile(projectId: string, id: string): Promise<CadFileDetail> {
  return bffJson(one(projectId, id), CadFileDetailSchema);
}

export function getCadLog(projectId: string, id: string): Promise<CadFileLogResponse> {
  return bffJson(`${one(projectId, id)}/log`, CadFileLogResponseSchema);
}

export function listCadLayers(projectId: string, id: string): Promise<CadLayerListResponse> {
  return bffJson(`${one(projectId, id)}/layers`, CadLayerListResponseSchema);
}

type PageParams = { page: number; pageSize: number };

export function listCadInserts(
  projectId: string,
  id: string,
  query: PageParams & Pick<CadInsertListQuery, 'layer' | 'blockName'>,
): Promise<CadInsertPage> {
  return bffJson(`${one(projectId, id)}/inserts${toQueryString(query)}`, CadInsertPageSchema);
}

export function listCadTexts(
  projectId: string,
  id: string,
  query: PageParams & Pick<CadTextListQuery, 'layer' | 'kind' | 'readable' | 'q'>,
): Promise<CadTextPage> {
  return bffJson(`${one(projectId, id)}/texts${toQueryString(query)}`, CadTextPageSchema);
}

export function listCadCurves(
  projectId: string,
  id: string,
  query: PageParams & Pick<CadCurveListQuery, 'layer' | 'entityType'>,
): Promise<CadCurvePage> {
  return bffJson(`${one(projectId, id)}/curves${toQueryString(query)}`, CadCurvePageSchema);
}

export function reprocessCadFile(projectId: string, id: string): Promise<CadFileSummary> {
  return bffJson(`${one(projectId, id)}/reprocess`, CadFileSummarySchema, { method: 'POST' });
}

export function uploadCadFile(
  projectId: string,
  file: File,
  options?: UploadOptions,
): Promise<CadFileSummary> {
  const form = new FormData();
  form.append('file', file);
  return bffUpload(root(projectId), form, CadFileSummarySchema, options);
}

/** Plain link to the original file; the browser sends its session cookie to the proxy. */
export function cadContentUrl(projectId: string, id: string): string {
  return `${one(projectId, id)}/content`;
}
