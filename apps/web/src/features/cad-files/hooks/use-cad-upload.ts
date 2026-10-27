'use client';

import { useState, type ChangeEvent } from 'react';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useUploadCadFile } from '../api/queries';
import { isCadFileName } from '../model/cad-status';

/** Pick a .dwg/.dxf and upload it through the proxy with progress. */
export function useCadUpload(projectId: string) {
  const upload = useUploadCadFile(projectId);
  const [progress, setProgress] = useState<number | null>(null);
  const [badName, setBadName] = useState(false);
  const [lastName, setLastName] = useState<string | null>(null);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    setBadName(false);
    if (!isCadFileName(file.name)) {
      setBadName(true);
      input.value = '';
      return;
    }
    setLastName(file.name);
    setProgress(0);
    upload.mutate(
      { file, onProgress: setProgress },
      {
        onSettled: () => {
          setProgress(null);
          input.value = '';
        },
      },
    );
  };

  return {
    onFileChange,
    progress,
    uploading: upload.isPending,
    badName,
    lastName,
    errorCode: upload.error ? errorCodeOf(upload.error) : null,
    succeeded: upload.isSuccess,
  };
}
