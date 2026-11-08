'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useMapping } from '@/features/cad-mapping/api/queries';
import { useCorrections, useRebuildRevision, useWithdrawCorrection } from '../api/queries';
import { changesSinceBuild, correctionError, isMappingMismatch } from '../model/corrections';
import type { ErrorMessage } from '../model/revision-errors';

/**
 * The corrections panel and the rebuild button of a revision page (ADR-038). Anyone who can read
 * designs sees the list; only a draft and `design:write` can withdraw or rebuild. The rebuild
 * sends the mapping version loaded for the file; on a mismatch the mapping is reloaded and the
 * user presses the button again. On success the page moves to the new revision.
 */
export function useCorrectionsPanel(input: {
  projectId: string;
  revisionId: string;
  cadFileId: string;
  builtAt: string | null;
  listPath: string;
  enabled: boolean;
  canEdit: boolean;
}) {
  const { projectId, revisionId, cadFileId, builtAt, listPath, enabled, canEdit } = input;
  const router = useRouter();
  const corrections = useCorrections(projectId, cadFileId, enabled);
  const mapping = useMapping(projectId, cadFileId, enabled && canEdit);
  const withdraw = useWithdrawCorrection(projectId, cadFileId);
  const rebuild = useRebuildRevision(projectId, revisionId);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [error, setError] = useState<ErrorMessage | null>(null);

  const items = corrections.data?.items ?? [];
  const mappingVersion = mapping.data?.mapping?.version ?? null;
  const changes = changesSinceBuild(items, builtAt);

  function fail(caught: unknown) {
    const reason = errorReasonOf(caught);
    setError(correctionError(errorCodeOf(caught), reason));
    if (isMappingMismatch(reason)) void mapping.refetch();
  }

  return {
    loading: corrections.isLoading,
    loadErrorCode: corrections.error ? errorCodeOf(corrections.error) : null,
    items,
    activeCount: corrections.data?.activeCount ?? 0,
    canEdit,
    error,
    withdrawingId,
    askWithdraw: (id: string) => {
      setError(null);
      setWithdrawingId(id);
    },
    cancelWithdraw: () => setWithdrawingId(null),
    withdrawing: withdraw.isPending,
    withdraw: () => {
      if (withdrawingId === null) return;
      setError(null);
      withdraw.mutate(withdrawingId, {
        onError: fail,
        onSettled: () => setWithdrawingId(null),
      });
    },
    changes,
    /** The mapping must be saved (it has a version) before a build. */
    mappingMissing: canEdit && !mapping.isLoading && mappingVersion === null,
    rebuilding: rebuild.isPending,
    canRebuild: canEdit && mappingVersion !== null && !rebuild.isPending,
    rebuild: () => {
      if (mappingVersion === null) return;
      setError(null);
      rebuild.mutate(
        { mappingVersion },
        {
          onSuccess: (revision) => router.push(`${listPath}/${revision.id}`),
          onError: fail,
        },
      );
    },
  };
}
