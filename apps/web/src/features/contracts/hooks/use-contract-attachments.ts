'use client';

import { useState, type ChangeEvent } from 'react';
import type { ContractAttachment } from '@ftth/shared';
import { errorCodeOf } from '@/shared/api/bff-client';
import { isPdfFile } from '@/features/work-orders/hooks/use-attachments';
import { contractAttachmentUrl } from '../api/contracts-api';
import { useDeleteContractAttachment, useUploadContractAttachment } from '../api/queries';

/** PDF upload with progress, delete with inline confirmation, download links (admin only). */
export function useContractAttachments(contractId: string) {
  const upload = useUploadContractAttachment(contractId);
  const remove = useDeleteContractAttachment(contractId);
  const [progress, setProgress] = useState<number | null>(null);
  const [notPdf, setNotPdf] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    setNotPdf(false);
    if (!isPdfFile(file)) {
      setNotPdf(true);
      input.value = '';
      return;
    }
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

  const onConfirmDelete = (attachment: Pick<ContractAttachment, 'id'>) => {
    remove.mutate(attachment.id, { onSettled: () => setConfirmId(null) });
  };

  const error = upload.error ?? remove.error;
  return {
    uploading: upload.isPending,
    progress,
    notPdf,
    errorCode: error ? errorCodeOf(error) : null,
    confirmId,
    deleting: remove.isPending,
    onFileChange,
    askDelete: setConfirmId,
    onConfirmDelete,
    downloadUrl: (attachmentId: string) => contractAttachmentUrl(contractId, attachmentId),
  };
}
