'use client';

import { useState } from 'react';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useApproveAsBuiltEdit, useAsBuiltEdit, useRejectAsBuiltEdit } from '../api/queries';
import { approveBlockedReason, reviewErrorKey } from '../model/review-model';

/**
 * Detail screen state: the edit with its comparison data, and the approve / reject flows. A
 * refused review (SELF_REVIEW, NOT_PENDING, STALE_BASE, anything else) shows its message and the
 * queries are refetched so the screen shows the current state.
 */
export function useEditReview(projectId: string, editId: string) {
  const { can } = useProject();
  const canRead = can('asbuilt:read');
  const canReview = can('asbuilt:review');
  const query = useAsBuiltEdit(projectId, editId, canRead);
  const approve = useApproveAsBuiltEdit(projectId, editId);
  const reject = useRejectAsBuiltEdit(projectId, editId);

  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);

  const detail = query.data ?? null;
  const actionError = approve.error ?? reject.error;
  const blocked = detail ? approveBlockedReason(detail, canReview) : null;

  const closeDialog = () => {
    setRejecting(false);
    setReasonMissing(false);
  };

  return {
    canRead,
    canReview,
    detail,
    loadErrorCode: query.error ? errorCodeOf(query.error) : null,
    blocked,
    /** Reject is the remedy for a stale edit, so it needs only a pending edit and permission. */
    canReject: canReview && detail?.edit.status === 'pending',
    busy: approve.isPending || reject.isPending,
    approving: approve.isPending,
    rejectingNow: reject.isPending,
    actionErrorKey: actionError
      ? reviewErrorKey(errorCodeOf(actionError), errorReasonOf(actionError))
      : null,
    approve: () => {
      reject.reset();
      approve.mutate();
    },
    dialogOpen: rejecting,
    reason,
    reasonMissing,
    setReason: (value: string) => {
      setReason(value);
      if (value.trim()) setReasonMissing(false);
    },
    openReject: () => {
      approve.reset();
      reject.reset();
      setRejecting(true);
    },
    cancelReject: closeDialog,
    confirmReject: () => {
      const trimmed = reason.trim();
      if (!trimmed) {
        setReasonMissing(true);
        return;
      }
      reject.mutate({ reason: trimmed }, { onSettled: closeDialog });
    },
  };
}
