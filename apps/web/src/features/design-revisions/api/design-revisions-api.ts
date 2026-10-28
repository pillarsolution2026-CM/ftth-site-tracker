import {
  DesignFeaturePageSchema,
  DesignRevisionDetailSchema,
  DesignRevisionListResponseSchema,
  DesignRevisionSummarySchema,
  DiffPageSchema,
  TextLinkPageSchema,
  TextLinkSchema,
  type CreateDesignRevisionRequest,
  type DesignFeatureListQuery,
  type DesignFeaturePage,
  type DesignRevisionDetail,
  type DesignRevisionListResponse,
  type DesignRevisionSummary,
  type DiffListQuery,
  type DiffPage,
  type PublishDesignRevisionRequest,
  type ReviewTextLinkRequest,
  type TextLink,
  type TextLinkListQuery,
  type TextLinkPage,
} from '@ftth/shared';
import { toQueryString } from '@/features/cad-files/api/cad-api';
import { bffJson, projectApiPath } from '@/shared/api/bff-client';

const root = (projectId: string) => projectApiPath(projectId, '/design-revisions');
const one = (projectId: string, id: string) => `${root(projectId)}/${encodeURIComponent(id)}`;

type PageParams = { page: number; pageSize: number };

export function listDesignRevisions(projectId: string): Promise<DesignRevisionListResponse> {
  return bffJson(root(projectId), DesignRevisionListResponseSchema);
}

export function getDesignRevision(projectId: string, id: string): Promise<DesignRevisionDetail> {
  return bffJson(one(projectId, id), DesignRevisionDetailSchema);
}

/** Queues a build from the saved mapping (202; the revision starts as `queued`). */
export function createDesignRevision(
  projectId: string,
  body: CreateDesignRevisionRequest,
): Promise<DesignRevisionSummary> {
  return bffJson(root(projectId), DesignRevisionSummarySchema, { method: 'POST', body });
}

export function publishDesignRevision(
  projectId: string,
  id: string,
  body: PublishDesignRevisionRequest,
): Promise<DesignRevisionDetail> {
  return bffJson(`${one(projectId, id)}/publish`, DesignRevisionDetailSchema, {
    method: 'POST',
    body,
  });
}

export function discardDesignRevision(
  projectId: string,
  id: string,
): Promise<DesignRevisionDetail> {
  return bffJson(`${one(projectId, id)}/discard`, DesignRevisionDetailSchema, { method: 'POST' });
}

export function listTextLinks(
  projectId: string,
  id: string,
  query: PageParams & Pick<TextLinkListQuery, 'status' | 'kind' | 'readable'>,
): Promise<TextLinkPage> {
  return bffJson(`${one(projectId, id)}/text-links${toQueryString(query)}`, TextLinkPageSchema);
}

export function reviewTextLink(
  projectId: string,
  id: string,
  linkId: string,
  body: ReviewTextLinkRequest,
): Promise<TextLink> {
  return bffJson(`${one(projectId, id)}/text-links/${encodeURIComponent(linkId)}`, TextLinkSchema, {
    method: 'PATCH',
    body,
  });
}

export function listDesignFeatures(
  projectId: string,
  id: string,
  query: PageParams & Pick<DesignFeatureListQuery, 'featureType' | 'q'>,
): Promise<DesignFeaturePage> {
  return bffJson(`${one(projectId, id)}/features${toQueryString(query)}`, DesignFeaturePageSchema);
}

export function listDiff(
  projectId: string,
  id: string,
  query: PageParams & { change?: DiffListQuery['change']; changedOnly?: boolean },
): Promise<DiffPage> {
  return bffJson(`${one(projectId, id)}/diff${toQueryString(query)}`, DiffPageSchema);
}
