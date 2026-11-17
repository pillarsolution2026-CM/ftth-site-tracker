'use client';

import { useEffect, useRef, useState } from 'react';
import type { MessageKey } from '@ftth/i18n';
import type { SecondaryPlacementSuggestion } from '@ftth/shared';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useFetchGeneralCabinets } from '../api/queries';
import { generalCabinetsErrorKey } from '../model/general-cabinets';

export interface GeneralCabinetsApplied {
  /** Points the suggestion put into the panel (not saved yet). */
  added: number;
  /** Points left out because the control point limit was reached. */
  dropped: number;
}

/**
 * «من كبائن الرئيسي» for a Secondary's placement (ADR-042 part G). The suggestion is fetched on the
 * button and once automatically when the placement has no point yet. It is only handed to the
 * mapping form (`pending`); nothing is saved until the PM saves the mapping.
 */
export function useGeneralCabinets(input: {
  projectId: string;
  cadFileId: string;
  /** A Secondary the user may edit (`cad_files:write`), file processed. */
  available: boolean;
  /** Fetch once on the first visit: the saved placement has no point. */
  auto: boolean;
}) {
  const { projectId, cadFileId, available, auto } = input;
  const fetcher = useFetchGeneralCabinets(projectId, cadFileId);
  const [report, setReport] = useState<SecondaryPlacementSuggestion | null>(null);
  const [pending, setPending] = useState<SecondaryPlacementSuggestion | null>(null);
  const [applied, setApplied] = useState<GeneralCabinetsApplied | null>(null);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const asked = useRef(false);

  const fetchNow = () => {
    if (!available || fetcher.isPending) return;
    setErrorKey(null);
    setApplied(null);
    fetcher.mutate(undefined, {
      onSuccess: (suggestion) => {
        setReport(suggestion);
        setPending(suggestion);
      },
      onError: (error) => {
        setReport(null);
        setErrorKey(generalCabinetsErrorKey(errorCodeOf(error), errorReasonOf(error)));
      },
    });
  };

  const fetchRef = useRef(fetchNow);
  useEffect(() => {
    fetchRef.current = fetchNow;
  });
  useEffect(() => {
    if (!available || !auto || asked.current) return;
    asked.current = true;
    fetchRef.current();
  }, [available, auto]);

  return {
    available,
    loading: fetcher.isPending,
    errorKey,
    report,
    /** A suggestion the form has not taken yet. */
    pending,
    applied,
    fetch: fetchNow,
    /** The form took the pending points. */
    consume: (result: GeneralCabinetsApplied) => {
      setPending(null);
      setApplied(result);
    },
  };
}

export type GeneralCabinetsState = ReturnType<typeof useGeneralCabinets>;
