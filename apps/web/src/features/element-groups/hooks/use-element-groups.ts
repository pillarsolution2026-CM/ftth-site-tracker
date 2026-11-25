'use client';

import { useState } from 'react';
import type { MessageKey } from '@ftth/i18n';
import type { ElementKey } from '@ftth/shared';
import { useElementGroupsQuery, useReplaceElementGroups } from '../api/queries';
import {
  addMain,
  elementGroupsErrorKey,
  moveMain,
  removeMain,
  sameList,
} from '../model/element-groups-model';

/** Drafts per element; an element with no draft shows the server list. */
export function useElementGroups() {
  const query = useElementGroupsQuery();
  const replace = useReplaceElementGroups();
  const [drafts, setDrafts] = useState<Partial<Record<ElementKey, string[]>>>({});
  const [savingElement, setSavingElement] = useState<ElementKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ElementKey, MessageKey>>>({});
  const [saved, setSaved] = useState<ElementKey | null>(null);

  const data = query.data;
  const entries = (data?.elements ?? []).map((entry) => {
    const draft = drafts[entry.element];
    const mains = draft ?? entry.mains;
    return {
      element: entry.element,
      version: entry.version,
      mains,
      dirty: draft !== undefined && !sameList(draft, entry.mains),
      pending: savingElement === entry.element,
      errorKey: errors[entry.element] ?? null,
      stale: errors[entry.element] === 'elementGroups.stale',
      justSaved: saved === entry.element,
    };
  });

  const edit = (element: ElementKey, update: (mains: string[]) => string[]) => {
    const current = entries.find((entry) => entry.element === element)?.mains ?? [];
    setDrafts((all) => ({ ...all, [element]: update([...current]) }));
    setErrors((all) => ({ ...all, [element]: undefined }));
    setSaved(null);
  };

  const dropDraft = (element: ElementKey) =>
    setDrafts((all) => {
      return Object.fromEntries(Object.entries(all).filter(([key]) => key !== element));
    });

  const save = (element: ElementKey) => {
    const entry = entries.find((candidate) => candidate.element === element);
    if (!entry || !entry.dirty) return;
    setSavingElement(element);
    replace.mutate(
      { element, mains: entry.mains, expectedVersion: entry.version },
      {
        onSuccess: () => {
          dropDraft(element);
          setSaved(element);
        },
        onError: (error) =>
          setErrors((all) => ({
            ...all,
            [element]: elementGroupsErrorKey(error),
          })),
        onSettled: () => setSavingElement(null),
      },
    );
  };

  const reload = () => {
    setDrafts({});
    setErrors({});
    void query.refetch();
  };

  return {
    loading: query.isPending,
    loadErrorKey: query.error ? elementGroupsErrorKey(query.error) : null,
    entries,
    unlinked: data?.unlinked ?? [],
    knownMains: data?.knownMains ?? [],
    add: (element: ElementKey, name: string) => edit(element, (mains) => addMain(mains, name)),
    remove: (element: ElementKey, index: number) =>
      edit(element, (mains) => removeMain(mains, index)),
    move: (element: ElementKey, index: number, delta: -1 | 1) =>
      edit(element, (mains) => moveMain(mains, index, delta)),
    undo: (element: ElementKey) => {
      dropDraft(element);
      setErrors((all) => ({ ...all, [element]: undefined }));
    },
    save,
    reload,
  };
}

export type ElementGroupsModel = ReturnType<typeof useElementGroups>;
