'use client';

import { useMemo, useState } from 'react';
import { metresToMm, mmToMetres } from '@ftth/shared';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import type { ErrorMessage } from '@/features/design-revisions/model/revision-errors';
import { useCreateTrenchMark, useInstallation, useWithdrawTrenchMark } from '../api/queries';
import {
  activeMarks,
  installationErrorKey,
  markedByRoute,
  parseTrenchLength,
} from '../model/installation-model';

export type TrenchTool = ReturnType<typeof useTrenchTool>;

const message = (error: unknown): ErrorMessage => ({
  key: installationErrorKey(errorCodeOf(error), errorReasonOf(error)),
  params: {},
});

/**
 * «حفر جديد» (ADR-042 part D): the General's trench marks on the drawing viewer. `enabled` is the
 * General's file with the viewer readable; `canEdit` is a draft with `design:write`. The tool is
 * offered only while the answer is `has_trench`; marks in force are drawn whenever there are any.
 */
export function useTrenchTool(input: {
  projectId: string;
  cadFileId: string;
  enabled: boolean;
  canEdit: boolean;
}) {
  const { projectId, cadFileId, enabled, canEdit } = input;
  const query = useInstallation(projectId, cadFileId, enabled);
  const create = useCreateTrenchMark(projectId, cadFileId);
  const withdraw = useWithdrawTrenchMark(projectId, cadFileId);
  const [on, setOn] = useState(false);
  const [lengthError, setLengthError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);

  const state = query.data;
  const marks = state?.marks ?? [];
  const inForce = useMemo(() => activeMarks(state), [state]);
  const byRoute = useMemo(() => markedByRoute(inForce), [inForce]);
  const asked = state?.asked === true;
  const hasTrench = state?.answer?.answer === 'has_trench';
  const available = enabled && canEdit && asked && hasTrench;
  const totalM = mmToMetres(inForce.reduce((sum, mark) => sum + metresToMm(mark.lengthM), 0n));

  return {
    /** The marks list and the legend are shown (a General that has marks or `has_trench`). */
    visible: enabled && asked && (hasTrench || marks.length > 0),
    available,
    canEdit,
    /** The tool is on: a click on a route piece opens the length form. */
    mode: available && on,
    toggle: () => {
      setSaved(false);
      create.reset();
      setOn((current) => !current);
    },
    marks,
    inForce,
    activeCount: inForce.length,
    totalM,
    /** Σ marked metres per route handle (labels on the drawing). */
    byRoute,
    saving: create.isPending,
    saved,
    lengthError,
    saveError: create.error ? message(create.error) : null,
    /** Saves a trench mark of `lengthText` metres on the route; resolves true when saved. */
    save: async (routeHandle: string, lengthText: string): Promise<boolean> => {
      setSaved(false);
      const parsed = parseTrenchLength(lengthText);
      if (!parsed.ok) {
        setLengthError(true);
        return false;
      }
      setLengthError(false);
      try {
        await create.mutateAsync({ routeHandle, lengthM: parsed.metres });
        setSaved(true);
        return true;
      } catch {
        return false;
      }
    },
    clearFormError: () => {
      setLengthError(false);
      create.reset();
    },
    withdrawingId,
    withdrawError: withdraw.error ? message(withdraw.error) : null,
    withdraw: (id: string) => {
      if (!canEdit || withdraw.isPending) return;
      setSaved(false);
      setWithdrawingId(id);
      withdraw.mutate(id, { onSettled: () => setWithdrawingId(null) });
    },
  };
}
