'use client';

import { useState } from 'react';
import type { PublishBlockedDetails } from '@ftth/shared';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useDesignRevision, useDiscardRevision, usePublishRevision } from '../api/queries';
import { isBuilt } from '../model/revision-status';
import { publishBlockedOf, revisionErrorKey } from '../model/revision-errors';

/**
 * Detail screen state: the revision (polled while queued/building), and the publish/discard flows.
 * Publishing first tries without acknowledgement; a 409 OPEN_ITEMS opens the acknowledgement
 * dialog with the counts, and only then is `acknowledgeOpenItems: true` sent.
 */
export function useRevisionDetail(projectId: string, revisionId: string) {
  const { can } = useProject();
  const canRead = can('design:read');
  const canWrite = can('design:write');
  const query = useDesignRevision(projectId, revisionId, canRead);
  const publish = usePublishRevision(projectId, revisionId);
  const discard = useDiscardRevision(projectId, revisionId);

  const [blocked, setBlocked] = useState<PublishBlockedDetails | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const revision = query.data ?? null;
  const status = revision?.status ?? null;

  const actionError = blocked ? null : (publish.error ?? discard.error);

  const closePublishDialog = () => {
    setBlocked(null);
    setAcknowledged(false);
    publish.reset();
  };

  return {
    canRead,
    canWrite,
    revision,
    loadErrorCode: query.error ? errorCodeOf(query.error) : null,
    built: status !== null && isBuilt(status),
    canReview: canWrite && status === 'draft',
    canPublish: canWrite && status === 'draft',
    canDiscard:
      canWrite &&
      (status === 'draft' || status === 'failed' || status === 'queued' || status === 'building'),
    publishing: publish.isPending,
    discarding: discard.isPending,
    actionErrorKey: actionError
      ? revisionErrorKey(errorCodeOf(actionError), errorReasonOf(actionError))
      : null,
    blocked,
    acknowledged,
    setAcknowledged,
    startPublish: () => {
      discard.reset();
      publish.mutate(
        { acknowledgeOpenItems: false },
        {
          onError: (error) => {
            const details = publishBlockedOf(error);
            if (details) setBlocked(details);
          },
        },
      );
    },
    confirmPublish: () => {
      if (!acknowledged) return;
      publish.mutate({ acknowledgeOpenItems: true }, { onSuccess: closePublishDialog });
    },
    cancelPublish: closePublishDialog,
    confirmingDiscard,
    askDiscard: () => {
      publish.reset();
      setConfirmingDiscard(true);
    },
    cancelDiscard: () => setConfirmingDiscard(false),
    discard: () => discard.mutate(undefined, { onSettled: () => setConfirmingDiscard(false) }),
  };
}
