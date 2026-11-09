import {
  DesignFeaturePageSchema,
  DesignRevisionDetailSchema,
  DesignRevisionListResponseSchema,
  DesignRevisionSummarySchema,
  DiffPageSchema,
  DrawingCorrectionListSchema,
  DrawingCorrectionSchema,
  DrawingProblemListSchema,
  DrawingViewSchema,
  DrawingViewStateSchema,
  PublishReadinessSchema,
  TextLinkPageSchema,
  TextLinkSchema,
  type CreateDesignRevisionRequest,
  type CreateDrawingCorrectionRequest,
  type DrawingCorrection,
  type DrawingCorrectionList,
  type RebuildDesignRevisionRequest,
  type DesignFeatureListQuery,
  type DesignFeaturePage,
  type DesignRevisionDetail,
  type DesignRevisionListResponse,
  type DesignRevisionSummary,
  type DiffListQuery,
  type DiffPage,
  type DrawingProblemList,
  type DrawingView,
  type DrawingViewState,
  type PublishReadiness,
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

export function listDrawingProblems(projectId: string, id: string): Promise<DrawingProblemList> {
  return bffJson(`${one(projectId, id)}/problems`, DrawingProblemListSchema);
}

const correctionsPath = (projectId: string, cadFileId: string) =>
  projectApiPath(projectId, `/cad-files/${encodeURIComponent(cadFileId)}/corrections`);

export function listCorrections(
  projectId: string,
  cadFileId: string,
): Promise<DrawingCorrectionList> {
  return bffJson(correctionsPath(projectId, cadFileId), DrawingCorrectionListSchema);
}

export function createCorrection(
  projectId: string,
  cadFileId: string,
  body: CreateDrawingCorrectionRequest,
): Promise<DrawingCorrection> {
  return bffJson(correctionsPath(projectId, cadFileId), DrawingCorrectionSchema, {
    method: 'POST',
    body,
  });
}

export function withdrawCorrection(
  projectId: string,
  cadFileId: string,
  id: string,
): Promise<DrawingCorrection> {
  return bffJson(
    `${correctionsPath(projectId, cadFileId)}/${encodeURIComponent(id)}/withdraw`,
    DrawingCorrectionSchema,
    { method: 'POST' },
  );
}

/** Discards the draft and builds a new revision of the same file (202; the new one is returned). */
export function rebuildDesignRevision(
  projectId: string,
  id: string,
  body: RebuildDesignRevisionRequest,
): Promise<DesignRevisionSummary> {
  return bffJson(`${one(projectId, id)}/rebuild`, DesignRevisionSummarySchema, {
    method: 'POST',
    body,
  });
}

export function getPublishReadiness(projectId: string, id: string): Promise<PublishReadiness> {
  return bffJson(`${one(projectId, id)}/publish-readiness`, PublishReadinessSchema);
}

const viewPath = (projectId: string, cadFileId: string) =>
  projectApiPath(projectId, `/cad-files/${encodeURIComponent(cadFileId)}/view`);

/** Drawing viewer (ADR-039): is the flattened view of the file ready. */
export function getDrawingViewState(
  projectId: string,
  cadFileId: string,
): Promise<DrawingViewState> {
  return bffJson(`${viewPath(projectId, cadFileId)}/status`, DrawingViewStateSchema);
}

/** Queues the render job (202) for a file whose view is missing or failed. */
export function requestDrawingView(
  projectId: string,
  cadFileId: string,
): Promise<DrawingViewState> {
  return bffJson(viewPath(projectId, cadFileId), DrawingViewStateSchema, { method: 'POST' });
}

/** The view itself (gzip JSON, several MB; the browser decompresses it). */
export function getDrawingView(projectId: string, cadFileId: string): Promise<DrawingView> {
  return bffJson(viewPath(projectId, cadFileId), DrawingViewSchema);
}
