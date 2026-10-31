'use client';

import type { ContractAttachment } from '@ftth/shared';
import {
  AttachmentsPanelView,
  type AttachmentRow,
} from '@/features/work-orders/components/attachments-panel';
import { useContractAttachments } from '../hooks/use-contract-attachments';

/** Contract PDFs (admin only): upload, download, delete; the import source is kept. */
export function ContractAttachments({
  contractId,
  attachments,
}: {
  contractId: string;
  attachments: ContractAttachment[];
}) {
  const state = useContractAttachments(contractId);
  const rows: AttachmentRow[] = attachments;
  return (
    <AttachmentsPanelView
      attachments={rows}
      canWrite
      uploading={state.uploading}
      progress={state.progress}
      notPdf={state.notPdf}
      errorCode={state.errorCode}
      confirmId={state.confirmId}
      deleting={state.deleting}
      downloadUrl={state.downloadUrl}
      onFileChange={state.onFileChange}
      onAskDelete={state.askDelete}
      onConfirmDelete={state.onConfirmDelete}
    />
  );
}
