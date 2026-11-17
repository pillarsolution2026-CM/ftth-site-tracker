'use client';

import { useState, type ChangeEvent } from 'react';
import { KindExistsDetailsSchema, type DrawingKind } from '@ftth/shared';
import { ApiClientError, errorCodeOf } from '@/shared/api/bff-client';
import { useUploadCadFile } from '../api/queries';
import { isCadFileName } from '../model/cad-status';

/** The kind already has a current file: the PM is asked «is this a new version?» (ADR-040). */
export interface KindConflict {
  kind: DrawingKind;
  currentFileId: string;
  currentFileName: string;
}

/**
 * Pick the kind (General / Secondary), then a .dwg/.dxf, and upload it through the proxy with
 * progress. On 409 KIND_EXISTS the same File object is kept so «yes, a new version» re-sends it
 * with `newVersion=true`; «no» drops it and shows that the file was not uploaded.
 */
export function useCadUpload(projectId: string) {
  const upload = useUploadCadFile(projectId);
  const [kind, setKind] = useState<DrawingKind | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [badName, setBadName] = useState(false);
  const [lastName, setLastName] = useState<string | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [conflict, setConflict] = useState<KindConflict | null>(null);
  const [declinedKind, setDeclinedKind] = useState<DrawingKind | null>(null);

  const send = (
    file: File,
    uploadKind: DrawingKind,
    newVersion: boolean,
    input?: HTMLInputElement,
  ) => {
    setLastName(file.name);
    setProgress(0);
    upload.mutate(
      { file, kind: uploadKind, newVersion, onProgress: setProgress },
      {
        onSuccess: () => {
          setPending(null);
          setConflict(null);
        },
        onError: (error) => {
          const parsed =
            error instanceof ApiClientError && error.code === 'CONFLICT'
              ? KindExistsDetailsSchema.safeParse(error.details)
              : null;
          if (parsed?.success) {
            setPending(file);
            setConflict({
              kind: parsed.data.kind,
              currentFileId: parsed.data.currentFileId,
              currentFileName: parsed.data.currentFileName,
            });
          } else {
            setPending(null);
          }
        },
        onSettled: () => {
          setProgress(null);
          if (input) input.value = '';
        },
      },
    );
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file || !kind) return;
    setBadName(false);
    setDeclinedKind(null);
    setConflict(null);
    if (!isCadFileName(file.name)) {
      setBadName(true);
      input.value = '';
      return;
    }
    send(file, kind, false, input);
  };

  return {
    kind,
    onKindChange: (next: DrawingKind) => {
      setKind(next);
      setDeclinedKind(null);
    },
    onFileChange,
    progress,
    uploading: upload.isPending,
    badName,
    lastName,
    conflict,
    declinedKind,
    onConfirmNewVersion: () => {
      if (!pending || !conflict) return;
      const file = pending;
      const conflictKind = conflict.kind;
      setConflict(null);
      send(file, conflictKind, true);
    },
    onDeclineNewVersion: () => {
      if (conflict) setDeclinedKind(conflict.kind);
      setConflict(null);
      setPending(null);
      upload.reset();
    },
    errorCode: upload.error && !conflict ? errorCodeOf(upload.error) : null,
    succeeded: upload.isSuccess,
  };
}
