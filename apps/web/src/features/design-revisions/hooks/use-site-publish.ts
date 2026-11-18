'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useI18n } from '@/shared/i18n/locale-provider';
import { siteDrawingsKey } from '@/features/cad-files/api/queries';
import {
  usePublishRevision,
  useRefetchSiteReadiness,
  useSitePublishReadiness,
} from '../api/queries';
import {
  publishBlockedMessage,
  publishBlockedOf,
  revisionErrorKey,
  type ErrorMessage,
} from '../model/revision-errors';

/**
 * «نشر الموقع» from the drawings list (ADR-049 part B): the checklist of the whole site and one
 * publish of all its drafts. The API publishes the site of whichever draft it is asked for, so the
 * first draft of the site is used. A refusal shows its reason and refetches the checklist.
 */
export function useSitePublish(projectId: string, siteId: string, enabled: boolean) {
  const { locale } = useI18n();
  const client = useQueryClient();
  const readiness = useSitePublishReadiness(projectId, siteId, enabled);
  const refetch = useRefetchSiteReadiness(projectId, siteId);
  const data = readiness.data;
  const revisionId = data?.siteRevisionIds[0] ?? '';
  const publish = usePublishRevision(projectId, revisionId);
  const [acknowledged, setAcknowledged] = useState(false);

  const blocked = publish.error ? publishBlockedOf(publish.error) : null;
  const message: ErrorMessage | null = blocked
    ? publishBlockedMessage(blocked, locale)
    : publish.error
      ? {
          key: revisionErrorKey(errorCodeOf(publish.error), errorReasonOf(publish.error)),
          params: {},
        }
      : null;

  const allowed =
    data !== undefined &&
    data.canPublish &&
    revisionId !== '' &&
    (!data.needsAcknowledgement || acknowledged) &&
    !publish.isPending;

  return {
    readiness: data ?? null,
    loading: readiness.isLoading,
    failed: readiness.isError,
    acknowledged,
    setAcknowledged,
    allowed,
    publishing: publish.isPending,
    message,
    published: publish.isSuccess,
    publish: () => {
      if (!allowed || !data) return;
      publish.mutate(
        { acknowledgeOpenItems: data.needsAcknowledgement && acknowledged },
        {
          onSuccess: () => {
            void client.invalidateQueries({ queryKey: siteDrawingsKey(projectId) });
            void refetch();
          },
          onError: () => void refetch(),
        },
      );
    },
  };
}
