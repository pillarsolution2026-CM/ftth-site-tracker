'use client';

import { useState } from 'react';
import type { MessageKey } from '@ftth/i18n';
import { ApiClientError, errorCodeOf } from '@/shared/api/bff-client';
import { useReplaceSupervisorSites, useSupervisorSites } from '../api/queries';
import { groupSitesByWorkOrder, sameSet } from '../model/site-groups';

type RowStatus = { kind: 'saved' } | { kind: 'error'; message: MessageKey };

/** 404: not a supervisor of the project; 422: a site that is not of this project. */
export function saveErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiClientError && error.status === 404) {
    return 'supervisorSites.errors.notSupervisor';
  }
  if (error instanceof ApiClientError && error.status === 422) {
    return 'supervisorSites.errors.foreignSite';
  }
  return `errors.${errorCodeOf(error)}`;
}

/** State of the site-assignment panel: drafts per supervisor, saved once per supervisor. */
export function useSupervisorSitesPanel(projectId: string) {
  const query = useSupervisorSites(projectId);
  const replace = useReplaceSupervisorSites(projectId);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [status, setStatus] = useState<Record<string, RowStatus | undefined>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const data = query.data;
  const selectedOf = (userId: string): string[] =>
    drafts[userId] ?? data?.supervisors.find((s) => s.userId === userId)?.siteIds ?? [];

  const toggle = (userId: string, siteId: string) => {
    const current = selectedOf(userId);
    const next = current.includes(siteId)
      ? current.filter((id) => id !== siteId)
      : [...current, siteId];
    setDrafts((all) => ({ ...all, [userId]: next }));
    setStatus((all) => ({ ...all, [userId]: undefined }));
  };

  const save = async (userId: string) => {
    setSaving((all) => ({ ...all, [userId]: true }));
    try {
      await replace.mutateAsync({ userId, siteIds: selectedOf(userId) });
      setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== userId)));
      setStatus((all) => ({ ...all, [userId]: { kind: 'saved' } }));
    } catch (error) {
      setStatus((all) => ({ ...all, [userId]: { kind: 'error', message: saveErrorKey(error) } }));
    } finally {
      setSaving((all) => ({ ...all, [userId]: false }));
    }
  };

  return {
    loading: query.isPending,
    loadError: query.error ? errorCodeOf(query.error) : null,
    groups: groupSitesByWorkOrder(data?.sites ?? []),
    siteCount: data?.sites.length ?? 0,
    supervisors: data?.supervisors ?? [],
    selectedOf,
    isDirty: (userId: string) => {
      const saved = data?.supervisors.find((s) => s.userId === userId)?.siteIds ?? [];
      return !sameSet(selectedOf(userId), saved);
    },
    statusOf: (userId: string) => status[userId],
    isSaving: (userId: string) => saving[userId] === true,
    toggle,
    save,
  };
}

export type SupervisorSitesPanelModel = ReturnType<typeof useSupervisorSitesPanel>;
