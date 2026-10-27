'use client';

import { useState, type ChangeEvent } from 'react';
import type { WorkOrderAttachment } from '@ftth/shared';
import { PDF_CONTENT_TYPE } from '@ftth/shared';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useDeleteAttachment, useUploadAttachment } from '../api/queries';
import { attachmentContentUrl } from '../api/work-orders-api';

export function isPdfFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type === PDF_CONTENT_TYPE || /\.pdf$/i.test(file.name);
}

/** PDF upload with progress, delete with inline confirmation, download links. */
export function useAttachments(projectId: string, workOrderId: string) {
  const upload = useUploadAttachment(projectId, workOrderId);
  const remove = useDeleteAttachment(projectId, workOrderId);
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

  const onConfirmDelete = (attachment: WorkOrderAttachment) => {
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
    downloadUrl: (attachmentId: string) =>
      attachmentContentUrl(projectId, workOrderId, attachmentId),
  };
}
