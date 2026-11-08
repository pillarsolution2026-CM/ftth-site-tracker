'use client';

import { useState } from 'react';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import {
  useDesignRevision,
  useDiscardRevision,
  usePublishReadiness,
  usePublishRevision,
  useRefetchPublishReadiness,
} from '../api/queries';
import { isBuilt } from '../model/revision-status';
import {
  publishBlockedMessage,
  publishBlockedOf,
  revisionErrorKey,
  type ErrorMessage,
} from '../model/revision-errors';

/**
 * Detail screen state: the revision (polled while queued/building), the publish checklist
 * (ADR-038) and the publish/discard flows. Publish is only offered when the server says
 * `canPublish`; open items need the acknowledgement checkbox. A refused publish shows the reason
 * and refetches the checklist.
 */
export function useRevisionDetail(projectId: string, revisionId: string) {
  const { can } = useProject();
  const canRead = can('design:read');
  const canWrite = can('design:write');
  const query = useDesignRevision(projectId, revisionId, canRead);
  const publish = usePublishRevision(projectId, revisionId);
  const discard = useDiscardRevision(projectId, revisionId);
  const refetchReadiness = useRefetchPublishReadiness(projectId, revisionId);

  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const revision = query.data ?? null;
  const status = revision?.status ?? null;
  const isDraft = status === 'draft';
  const readiness = usePublishReadiness(projectId, revisionId, canRead && canWrite && isDraft);

  const publishError = publish.error;
  const blocked = publishError ? publishBlockedOf(publishError) : null;
  const actionError = publishError ?? discard.error;
  const actionMessage: ErrorMessage | null = blocked
    ? publishBlockedMessage(blocked)
    : actionError
      ? {
          key: revisionErrorKey(errorCodeOf(actionError), errorReasonOf(actionError)),
          params: {},
        }
      : null;

  const checks = readiness.data;
  const publishAllowed =
    checks !== undefined &&
    checks.canPublish &&
    (!checks.needsAcknowledgement || acknowledged) &&
    !publish.isPending;

  return {
    canRead,
    canWrite,
    revision,
    loadErrorCode: query.error ? errorCodeOf(query.error) : null,
    built: status !== null && isBuilt(status),
    canReview: canWrite && isDraft,
    canPublish: canWrite && isDraft,
    canDiscard:
      canWrite && (isDraft || status === 'failed' || status === 'queued' || status === 'building'),
    publishing: publish.isPending,
    discarding: discard.isPending,
    actionMessage,
    readiness: checks ?? null,
    readinessLoading: readiness.isLoading,
    readinessFailed: readiness.isError,
    acknowledged,
    setAcknowledged,
    publishAllowed,
    publish: () => {
      if (!publishAllowed || !checks) return;
      discard.reset();
      publish.mutate(
        { acknowledgeOpenItems: checks.needsAcknowledgement && acknowledged },
        { onError: () => void refetchReadiness() },
      );
    },
    confirmingDiscard,
    askDiscard: () => {
      publish.reset();
      setConfirmingDiscard(true);
    },
    cancelDiscard: () => setConfirmingDiscard(false),
    discard: () => discard.mutate(undefined, { onSettled: () => setConfirmingDiscard(false) }),
  };
}
