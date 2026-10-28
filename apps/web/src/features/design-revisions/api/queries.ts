import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateDesignRevisionRequest,
  PublishDesignRevisionRequest,
  ReviewTextLinkRequest,
} from '@ftth/shared';
import {
  createDesignRevision,
  discardDesignRevision,
  getDesignRevision,
  listDesignFeatures,
  listDesignRevisions,
  listDiff,
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
