'use client';

import { useState } from 'react';
import type { MessageKey } from '@ftth/i18n';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useDecideGpsProposal, useGpsProposals } from '../api/queries';
import { proposalErrorKey, proposalNeedsReload } from '../model/proposal-errors';

interface Options {
  projectId: string;
  cadFileId: string;
  /** The user can save the mapping (`cad_files:write`) and the mapping view is loaded. */
  enabled: boolean;
  /** The mapping version currently loaded; accepting sends it as the optimistic lock. */
  mappingVersion: number | null;
  /** Re-reads the mapping and restarts the editor from it (after accepting, or on a mismatch). */
  onReload: () => Promise<void> | void;
}

/** Server state and actions of the supervisor GPS proposals panel. */
export function useGpsProposalsPanel({
  projectId,
  cadFileId,
  enabled,
  mappingVersion,
  onReload,
}: Options) {
  const [showHistory, setShowHistory] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<'accepted' | 'rejected' | null>(null);
  const [error, setError] = useState<{ key: MessageKey; reload: boolean } | null>(null);
  const pending = useGpsProposals(projectId, cadFileId, 'pending', enabled);
  const history = useGpsProposals(projectId, cadFileId, 'history', enabled && showHistory);
  const { accept, reject } = useDecideGpsProposal(projectId, cadFileId);

  const fail = (cause: unknown) => {
    const code = errorCodeOf(cause);
    const reason = errorReasonOf(cause);
    setError({ key: proposalErrorKey(code, reason), reload: proposalNeedsReload(code, reason) });
  };

  return {
    pending: pending.data ?? [],
    pendingLoading: pending.isPending,
    pendingErrorCode: pending.error ? errorCodeOf(pending.error) : null,
    history: history.data ?? [],
    historyLoading: showHistory && history.isPending,
    showHistory,
    toggleHistory: () => setShowHistory((value) => !value),
    mappingVersion,
    busyId,
    notice,
    error,
    /** Sends the loaded mapping version; on success the editor restarts from the new mapping. */
    accept: async (id: string): Promise<void> => {
      if (mappingVersion === null) return;
      setError(null);
      setNotice(null);
      setBusyId(id);
      try {
        await accept.mutateAsync({ id, mappingVersion });
        setNotice('accepted');
        await onReload();
      } catch (cause) {
        fail(cause);
      } finally {
        setBusyId(null);
      }
    },
    /** Resolves true when the proposal was rejected. */
    reject: async (id: string, reason: string): Promise<boolean> => {
      setError(null);
      setNotice(null);
      setBusyId(id);
      try {
        await reject.mutateAsync({ id, reason });
        setNotice('rejected');
        return true;
      } catch (cause) {
        fail(cause);
        return false;
      } finally {
        setBusyId(null);
      }
    },
    reload: async () => {
      setError(null);
      await onReload();
    },
  };
}
