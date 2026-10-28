'use client';

import { useState } from 'react';
import type { FeatureType, TextLink } from '@ftth/shared';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useDesignFeatures, useReviewTextLink, useTextLinks } from '../api/queries';
import { revisionErrorKey } from '../model/revision-errors';
import {
  DEFAULT_REVIEW_FILTER,
  FEATURE_SEARCH_PAGE_SIZE,
  allowedFeatureTypes,
  reviewQuery,
  sortByConfidence,
  type ReviewFilter,
} from '../model/review-list';

/**
 * Text review list: filter (default status=review), paging, confirm / reject, and reassign through
 * a feature search limited to the types allowed for the text's kind.
 */
export function useTextReview(projectId: string, revisionId: string, enabled: boolean) {
  const [filter, setFilterState] = useState<ReviewFilter>(DEFAULT_REVIEW_FILTER);
  const [page, setPage] = useState(1);
  const links = useTextLinks(projectId, revisionId, reviewQuery(filter, page), enabled);
  const review = useReviewTextLink(projectId, revisionId);

  const [reassigning, setReassigning] = useState<TextLink | null>(null);
  const [featureType, setFeatureType] = useState<FeatureType | null>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [searchApplied, setSearchApplied] = useState('');
  const features = useDesignFeatures(
    projectId,
    revisionId,
    {
      page: 1,
      pageSize: FEATURE_SEARCH_PAGE_SIZE,
      ...(featureType ? { featureType } : {}),
      ...(searchApplied.trim() ? { q: searchApplied.trim() } : {}),
    },
    enabled && reassigning !== null && featureType !== null,
  );

  const closeReassign = () => setReassigning(null);

  return {
    filter,
    setFilter: (next: ReviewFilter) => {
      setFilterState(next);
      setPage(1);
    },
    page,
    setPage,
    links: links.data ? sortByConfidence(links.data.items) : null,
    total: links.data?.total ?? 0,
    pageSize: links.data?.pageSize ?? 0,
    loadErrorCode: links.error ? errorCodeOf(links.error) : null,
    pendingLinkId: review.isPending ? (review.variables?.linkId ?? null) : null,
    errorKey: review.error
      ? revisionErrorKey(errorCodeOf(review.error), errorReasonOf(review.error))
      : null,
    confirm: (link: TextLink) => review.mutate({ linkId: link.id, body: { action: 'confirm' } }),
    reject: (link: TextLink) => review.mutate({ linkId: link.id, body: { action: 'reject' } }),
    reassign: {
      link: reassigning,
      featureType,
      allowedTypes: reassigning ? allowedFeatureTypes(reassigning.kind) : [],
      searchDraft,
      setSearchDraft,
      applySearch: () => setSearchApplied(searchDraft),
      setFeatureType,
      results: features.data?.items ?? null,
      loading: features.isFetching,
      errorCode: features.error ? errorCodeOf(features.error) : null,
      open: (link: TextLink) => {
        review.reset();
        setReassigning(link);
        setFeatureType(allowedFeatureTypes(link.kind)[0] ?? null);
        setSearchDraft('');
        setSearchApplied('');
      },
      close: closeReassign,
      /** Confirms the link with the picked feature (the API checks the type and the revision). */
      pick: (featureId: string) => {
        if (!reassigning) return;
        review.mutate(
          { linkId: reassigning.id, body: { action: 'confirm', featureId } },
          { onSuccess: closeReassign },
        );
      },
    },
  };
}
