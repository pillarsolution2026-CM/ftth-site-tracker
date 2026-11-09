import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateDesignRevisionRequest,
  CreateDrawingCorrectionRequest,
  PublishDesignRevisionRequest,
  RebuildDesignRevisionRequest,
  ReviewTextLinkRequest,
} from '@ftth/shared';
import {
  createCorrection,
  createDesignRevision,
  listCorrections,
  rebuildDesignRevision,
  withdrawCorrection,
  discardDesignRevision,
  getDesignRevision,
  getDrawingView,
  getDrawingViewState,
  requestDrawingView,
  getPublishReadiness,
  listDesignFeatures,
  listDesignRevisions,
  listDiff,
  listDrawingProblems,
  listTextLinks,
  publishDesignRevision,
  reviewTextLink,
} from './design-revisions-api';
import { REVISION_POLL_MS, isBuilding } from '../model/revision-status';

export const revisionsKey = (projectId: string) => ['design-revisions', projectId] as const;
export const revisionKey = (projectId: string, id: string) =>
  ['design-revision', projectId, id] as const;

const noRetry = { retry: false } as const;

/** Polls every 3 s while any revision is queued or building. */
export function useDesignRevisions(projectId: string, enabled = true) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: revisionsKey(projectId),
    queryFn: () => listDesignRevisions(projectId),
    refetchInterval: (query) =>
      query.state.data?.items.some((revision) => isBuilding(revision.status))
        ? REVISION_POLL_MS
        : false,
  });
}

export function useDesignRevision(projectId: string, id: string, enabled = true) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: revisionKey(projectId, id),
    queryFn: () => getDesignRevision(projectId, id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && isBuilding(status) ? REVISION_POLL_MS : false;
    },
  });
}

export function useTextLinks(
  projectId: string,
  id: string,
  query: Parameters<typeof listTextLinks>[2],
  enabled: boolean,
) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: [...revisionKey(projectId, id), 'text-links', query],
    queryFn: () => listTextLinks(projectId, id, query),
    placeholderData: keepPreviousData,
  });
}

export function useDesignFeatures(
  projectId: string,
  id: string,
  query: Parameters<typeof listDesignFeatures>[2],
  enabled: boolean,
) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: [...revisionKey(projectId, id), 'features', query],
    queryFn: () => listDesignFeatures(projectId, id, query),
    placeholderData: keepPreviousData,
  });
}

export function useDiff(
  projectId: string,
  id: string,
  query: Parameters<typeof listDiff>[2],
  enabled: boolean,
) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: [...revisionKey(projectId, id), 'diff', query],
    queryFn: () => listDiff(projectId, id, query),
    placeholderData: keepPreviousData,
  });
}

export function useCreateDesignRevision(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDesignRevisionRequest) => createDesignRevision(projectId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: revisionsKey(projectId) }),
  });
}

/** Everything under one revision (counts, links, diff) changes with publish/discard/review. */
function useInvalidateRevision(projectId: string, id: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: revisionKey(projectId, id) }),
      client.invalidateQueries({ queryKey: revisionsKey(projectId) }),
    ]);
}

export function usePublishRevision(projectId: string, id: string) {
  const invalidate = useInvalidateRevision(projectId, id);
  return useMutation({
    mutationFn: (body: PublishDesignRevisionRequest) => publishDesignRevision(projectId, id, body),
    onSuccess: invalidate,
  });
}

export function useDiscardRevision(projectId: string, id: string) {
  const invalidate = useInvalidateRevision(projectId, id);
  return useMutation({
    mutationFn: () => discardDesignRevision(projectId, id),
    onSuccess: invalidate,
  });
}

export function useReviewTextLink(projectId: string, id: string) {
  const invalidate = useInvalidateRevision(projectId, id);
  return useMutation({
    mutationFn: (input: { linkId: string; body: ReviewTextLinkRequest }) =>
      reviewTextLink(projectId, id, input.linkId, input.body),
    // Counts, box codes (features) and the list itself change after a review.
    onSuccess: invalidate,
  });
}

export function useDrawingProblems(projectId: string, id: string, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: [...revisionKey(projectId, id), 'problems'],
    queryFn: () => listDrawingProblems(projectId, id),
  });
}

export const correctionsKey = (projectId: string, cadFileId: string) =>
  ['drawing-corrections', projectId, cadFileId] as const;

/** Corrections of a CAD file, newest first (ADR-038). */
export function useCorrections(projectId: string, cadFileId: string, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: correctionsKey(projectId, cadFileId),
    queryFn: () => listCorrections(projectId, cadFileId),
  });
}

export function useCreateCorrection(projectId: string, cadFileId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDrawingCorrectionRequest) =>
      createCorrection(projectId, cadFileId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: correctionsKey(projectId, cadFileId) }),
  });
}

export function useWithdrawCorrection(projectId: string, cadFileId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => withdrawCorrection(projectId, cadFileId, id),
    onSuccess: () => client.invalidateQueries({ queryKey: correctionsKey(projectId, cadFileId) }),
  });
}

export function useRebuildRevision(projectId: string, id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RebuildDesignRevisionRequest) => rebuildDesignRevision(projectId, id, body),
    onSuccess: () => client.invalidateQueries({ queryKey: revisionsKey(projectId) }),
  });
}

const readinessKey = (projectId: string, id: string) =>
  [...revisionKey(projectId, id), 'publish-readiness'] as const;

/** The publish checklist (ADR-038); refetched after a refused publish. */
export function usePublishReadiness(projectId: string, id: string, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: readinessKey(projectId, id),
    queryFn: () => getPublishReadiness(projectId, id),
  });
}

export function useRefetchPublishReadiness(projectId: string, id: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: readinessKey(projectId, id) });
}

/** Poll interval of the drawing view status while it is being prepared. */
export const VIEW_POLL_MS = 3000;

export const drawingViewStateKey = (projectId: string, cadFileId: string) =>
  ['drawing-view-state', projectId, cadFileId] as const;

/** Status of the drawing view of a file; polled every 3 s while `queued` (ADR-039). */
export function useDrawingViewState(projectId: string, cadFileId: string, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: drawingViewStateKey(projectId, cadFileId),
    queryFn: () => getDrawingViewState(projectId, cadFileId),
    refetchInterval: (query) => (query.state.data?.status === 'queued' ? VIEW_POLL_MS : false),
  });
}

export function useRequestDrawingView(projectId: string, cadFileId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => requestDrawingView(projectId, cadFileId),
    onSuccess: (state) => client.setQueryData(drawingViewStateKey(projectId, cadFileId), state),
  });
}

/** The view file; fetched once it is ready and never refetched (it is immutable per file). */
export function useDrawingView(projectId: string, cadFileId: string, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: ['drawing-view', projectId, cadFileId],
    queryFn: () => getDrawingView(projectId, cadFileId),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}
