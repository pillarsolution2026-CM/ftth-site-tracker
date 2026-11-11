'use client';

import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import type { FrozenInstallation, InstallationAnswer } from '@ftth/shared';
import type { ErrorMessage } from '@/features/design-revisions/model/revision-errors';
import { useInstallation, useSetInstallationAnswer } from '../api/queries';
import { activeMarks, installationErrorKey, needsRebuild } from '../model/installation-model';

/**
 * State of the installation question card (ADR-042): the live answer of the General file, the two
 * answers, and — on a draft page — whether the answer or marks changed since the draft froze them.
 * `enabled` is false for a Secondary (never asked) and without `cad_files:read`.
 */
export function useInstallationCard(input: {
  projectId: string;
  cadFileId: string;
  enabled: boolean;
  /** `design:write` (the API asks for it on every write). */
  canWrite: boolean;
  /** The draft's frozen installation when the card sits on a draft page; undefined elsewhere. */
  frozen?: FrozenInstallation | null;
}) {
  const { projectId, cadFileId, enabled, canWrite, frozen } = input;
  const query = useInstallation(projectId, cadFileId, enabled);
  const save = useSetInstallationAnswer(projectId, cadFileId);
  const state = query.data;
  const error: ErrorMessage | null = save.error
    ? {
        key: installationErrorKey(errorCodeOf(save.error), errorReasonOf(save.error)),
        params: {},
      }
    : null;
  return {
    loading: enabled && query.isLoading,
    loadErrorCode: query.error ? errorCodeOf(query.error) : null,
    /** The question applies to this file (a General); false hides the card. */
    asked: state?.asked === true,
    answer: state?.answer?.answer ?? null,
    activeMarkCount: activeMarks(state).length,
    canAnswer: canWrite,
    saving: save.isPending,
    error,
    rebuildNeeded: frozen !== undefined && needsRebuild(frozen, state),
    choose: (answer: InstallationAnswer) => {
      if (!canWrite || save.isPending) return;
      save.mutate({ answer });
    },
  };
}
