'use client';

import { useMemo, useState, type ChangeEvent } from 'react';
import type { DrawingKind, SiteDrawingsResponse } from '@ftth/shared';
import { ApiClientError, errorCodeOf } from '@/shared/api/bff-client';
import { useUploadCadFile } from '../api/queries';
import { isCadFileName } from '../model/cad-status';
import {
  EMPTY_SELECTION,
  defaultChoice,
  drawingsOfSite,
  toUploadQuery,
  uploadOptions,
  uploadRefusalOf,
  type UploadChoice,
  type UploadSelection,
} from '../model/site-drawings';

/**
 * Upload state (ADR-049 part B): pick the site of the work order, the kind, and for a Secondary
 * «new drawing» or «new version of Secondary n» (a General that exists takes only a new version);
 * then a .dwg/.dxf goes through the proxy with progress. The refusals (GENERAL_EXISTS, …) are
 * shown in plain language.
 */
export function useCadUpload(projectId: string, data: SiteDrawingsResponse | undefined) {
  const upload = useUploadCadFile(projectId);
  const [selection, setSelection] = useState<UploadSelection>(EMPTY_SELECTION);
  const [progress, setProgress] = useState<number | null>(null);
  const [badName, setBadName] = useState(false);
  const [lastName, setLastName] = useState<string | null>(null);

  const sites = data?.sites ?? [];
  // A work order with one site needs no question.
  const siteId = selection.siteId ?? (sites.length === 1 ? (sites[0]?.siteId ?? null) : null);
  const effective: UploadSelection = { ...selection, siteId };
  const drawings = useMemo(
    () => (data && siteId ? drawingsOfSite(data, siteId) : []),
    [data, siteId],
  );
  const options = useMemo(
    () => (selection.kind ? uploadOptions(drawings, selection.kind) : null),
    [drawings, selection.kind],
  );
  const query = toUploadQuery(effective);

  const onSiteChange = (next: string) =>
    setSelection({ siteId: next || null, kind: null, choice: null });
  const onKindChange = (kind: DrawingKind) =>
    setSelection({
      siteId,
      kind,
      choice: defaultChoice(uploadOptions(drawings, kind), kind),
    });
  const onChoiceChange = (choice: UploadChoice) => setSelection({ ...effective, choice });

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file || !query) return;
    setBadName(false);
    upload.reset();
    if (!isCadFileName(file.name)) {
      setBadName(true);
      input.value = '';
      return;
    }
    setLastName(file.name);
    setProgress(0);
    upload.mutate(
      { file, query, onProgress: setProgress },
      {
        onSettled: () => {
          setProgress(null);
          input.value = '';
        },
      },
    );
  };

  const error = upload.error;
  const refusal =
    error instanceof ApiClientError && (error.code === 'CONFLICT' || error.code === 'NOT_FOUND')
      ? uploadRefusalOf(error.details)
      : null;

  return {
    sites: sites.map((s) => ({ id: s.siteId, name: s.name })),
    siteId,
    kind: selection.kind,
    choice: selection.choice,
    options,
    onSiteChange,
    onKindChange,
    onChoiceChange,
    /** A file can be picked once the site, the kind and the target are known. */
    ready: query !== null,
    onFileChange,
    progress,
    uploading: upload.isPending,
    badName,
    lastName,
    refusal,
    errorCode: error && !refusal ? errorCodeOf(error) : null,
    succeeded: upload.isSuccess,
  };
}

export type CadUploadState = ReturnType<typeof useCadUpload>;
