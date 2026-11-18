'use client';

import { useState } from 'react';
import type { MessageKey } from '@ftth/i18n';
import { ApiClientError, errorCodeOf, type ClientErrorCode } from '@/shared/api/bff-client';
import { useAssignDrawingSite, useWithdrawDrawing } from '../api/queries';

export type ActionError = { key: MessageKey } | { code: ClientErrorCode } | null;

const ASSIGN_REASONS = ['GENERAL_EXISTS', 'SITE_NOT_FOUND', 'ALREADY_ASSIGNED'] as const;

function reasonOf(error: unknown): string | null {
  if (!(error instanceof ApiClientError)) return null;
  const details = error.details as { reason?: unknown } | null | undefined;
  return typeof details?.reason === 'string' ? details.reason : null;
}

/** The refusal of «اربط بموقع» in plain words, else the generic message of the error code. */
export function assignErrorOf(error: unknown): ActionError {
  if (!error) return null;
  const reason = reasonOf(error);
  if (reason && (ASSIGN_REASONS as readonly string[]).includes(reason)) {
    return { key: `siteDrawings.unassigned.refused.${reason as (typeof ASSIGN_REASONS)[number]}` };
  }
  return { code: errorCodeOf(error) };
}

/** A drawing that was published before cannot be withdrawn (409). */
export function withdrawErrorOf(error: unknown): ActionError {
  if (!error) return null;
  return error instanceof ApiClientError && error.code === 'CONFLICT'
    ? { key: 'siteDrawings.withdraw.refused' }
    : { code: errorCodeOf(error) };
}

/**
 * «اربط بموقع» and «سحب من الموقع» (ADR-049 part B): the site picked per unassigned drawing, the
 * withdraw confirmation, and the refusals of either.
 */
export function useSiteDrawingActions(projectId: string) {
  const assign = useAssignDrawingSite(projectId);
  const withdraw = useWithdrawDrawing(projectId);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  return {
    picked,
    onPick: (drawingId: string, siteId: string) => {
      assign.reset();
      setPicked((previous) => ({ ...previous, [drawingId]: siteId }));
    },
    onAssign: (drawingId: string) => {
      const siteId = picked[drawingId];
      if (!siteId) return;
      assign.mutate({ drawingId, siteId });
    },
    assigningId: assign.isPending ? (assign.variables?.drawingId ?? null) : null,
    confirmingId,
    onAskWithdraw: (drawingId: string) => {
      withdraw.reset();
      setConfirmingId(drawingId);
    },
    onCancelWithdraw: () => setConfirmingId(null),
    onConfirmWithdraw: () => {
      if (!confirmingId) return;
      withdraw.mutate(confirmingId, { onSettled: () => setConfirmingId(null) });
    },
    withdrawing: withdraw.isPending,
    error: assignErrorOf(assign.error) ?? withdrawErrorOf(withdraw.error),
  };
}

export type SiteDrawingActions = ReturnType<typeof useSiteDrawingActions>;
