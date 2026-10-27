'use client';

import { useState, type FormEvent } from 'react';
import type { CadCurveEntityType } from '@ftth/shared';
import { useCadCurves, useCadInserts, useCadTexts } from '../api/queries';

export const EXTRACTION_PAGE_SIZE = 50;

/** Inserts: layer select applies at once; the block-name text applies on submit. */
export function useInsertsTab(projectId: string, cadFileId: string, enabled: boolean) {
  const [layer, setLayerState] = useState('');
  const [blockDraft, setBlockDraft] = useState('');
  const [blockName, setBlockName] = useState('');
  const [page, setPage] = useState(1);
  const query = useCadInserts(
    projectId,
    cadFileId,
    {
      page,
      pageSize: EXTRACTION_PAGE_SIZE,
      ...(layer ? { layer } : {}),
      ...(blockName ? { blockName } : {}),
    },
    enabled,
  );
  return {
    query,
    page,
    setPage,
    layer,
    setLayer: (value: string) => {
      setLayerState(value);
      setPage(1);
    },
    blockDraft,
    setBlockDraft,
    onSubmitBlock: (event: FormEvent) => {
      event.preventDefault();
      setBlockName(blockDraft.trim());
      setPage(1);
    },
  };
}

export function useTextsTab(projectId: string, cadFileId: string, enabled: boolean) {
  const [layer, setLayerState] = useState('');
  const [unreadableOnly, setUnreadableOnlyState] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const query = useCadTexts(
    projectId,
    cadFileId,
    {
      page,
      pageSize: EXTRACTION_PAGE_SIZE,
      ...(layer ? { layer } : {}),
      ...(unreadableOnly ? { readable: false } : {}),
      ...(search ? { q: search } : {}),
    },
    enabled,
  );
  return {
    query,
    page,
    setPage,
    layer,
    setLayer: (value: string) => {
      setLayerState(value);
      setPage(1);
    },
    unreadableOnly,
    setUnreadableOnly: (value: boolean) => {
      setUnreadableOnlyState(value);
      setPage(1);
    },
    showRaw,
    setShowRaw,
    searchDraft,
    setSearchDraft,
    onSubmitSearch: (event: FormEvent) => {
      event.preventDefault();
      setSearch(searchDraft.trim());
      setPage(1);
    },
  };
}

export function useCurvesTab(projectId: string, cadFileId: string, enabled: boolean) {
  const [layer, setLayerState] = useState('');
  const [entityType, setEntityTypeState] = useState<CadCurveEntityType | ''>('');
  const [page, setPage] = useState(1);
  const query = useCadCurves(
    projectId,
    cadFileId,
    {
      page,
      pageSize: EXTRACTION_PAGE_SIZE,
      ...(layer ? { layer } : {}),
      ...(entityType ? { entityType } : {}),
    },
    enabled,
  );
  return {
    query,
    page,
    setPage,
    layer,
    setLayer: (value: string) => {
      setLayerState(value);
      setPage(1);
    },
    entityType,
    setEntityType: (value: CadCurveEntityType | '') => {
      setEntityTypeState(value);
      setPage(1);
    },
  };
}
