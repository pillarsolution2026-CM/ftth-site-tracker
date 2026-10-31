'use client';

import type { ChangeEvent } from 'react';
import type { WorkOrderAttachment } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatBytes, formatDateTime } from '@/shared/lib/format';
import type { ClientErrorCode } from '@/shared/api/bff-client';
import { useAttachments } from '../hooks/use-attachments';

/** The fields the list shows; work orders and contracts both fit. */
export type AttachmentRow = Pick<
  WorkOrderAttachment,
  'id' | 'kind' | 'fileName' | 'sizeBytes' | 'createdAt'
>;

export interface AttachmentsPanelViewProps {
  attachments: AttachmentRow[];
  canWrite: boolean;
  uploading: boolean;
  progress: number | null;
  notPdf: boolean;
  errorCode: ClientErrorCode | null;
  confirmId: string | null;
  deleting: boolean;
  downloadUrl: (attachmentId: string) => string;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onAskDelete: (id: string | null) => void;
  onConfirmDelete: (attachment: AttachmentRow) => void;
}

export function AttachmentsPanelView({
  attachments,
  canWrite,
  uploading,
  progress,
  notPdf,
  errorCode,
  confirmId,
  deleting,
  downloadUrl,
  onFileChange,
  onAskDelete,
  onConfirmDelete,
}: AttachmentsPanelViewProps) {
  const { t, locale } = useI18n();
  return (
    <section aria-labelledby="attachments-title" className="mt-8">
      <h2 id="attachments-title" className="mb-2 text-lg font-semibold">
        {t('attachments.title')}
      </h2>
      {errorCode ? <ErrorNotice code={errorCode} className="mb-2" /> : null}
      {notPdf ? (
        <Notice kind="error" className="mb-2">
          {t('attachments.onlyPdf')}
        </Notice>
      ) : null}
      {attachments.length === 0 ? <p>{t('attachments.empty')}</p> : null}
      <ul className="divide-y divide-(--color-border) rounded-md border border-(--color-border)">
        {attachments.map((attachment) => (
          <li key={attachment.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <a
                href={downloadUrl(attachment.id)}
                download
                className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
              >
                <Ltr className="break-all">{attachment.fileName}</Ltr>
              </a>
              <p className="text-sm opacity-80">
                <span>{t(`attachments.kinds.${attachment.kind}`)}</span>
                {' · '}
                <Ltr>{formatBytes(attachment.sizeBytes)}</Ltr>
                {' · '}
                <Ltr>{formatDateTime(attachment.createdAt, locale)}</Ltr>
              </p>
            </div>
            {canWrite && attachment.kind === 'document' ? (
              confirmId === attachment.id ? (
                <div
                  className="flex flex-wrap items-center gap-2"
                  role="group"
                  aria-label={t('attachments.confirmDelete')}
                >
                  <span>{t('attachments.confirmDelete')}</span>
                  <Button disabled={deleting} onClick={() => onConfirmDelete(attachment)}>
                    {t('common.delete')}
                  </Button>
                  <Button variant="outline" onClick={() => onAskDelete(null)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  aria-label={`${t('common.delete')} ${attachment.fileName}`}
                  onClick={() => onAskDelete(attachment.id)}
                >
                  {t('common.delete')}
                </Button>
              )
            ) : attachment.kind === 'import_source' ? (
              <span className="text-sm opacity-80">{t('attachments.notDeletable')}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {canWrite ? (
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor="attachment-file" className="text-sm font-medium">
            {t('attachments.upload')}
          </label>
          <input
            id="attachment-file"
            type="file"
            accept="application/pdf,.pdf"
            disabled={uploading}
            onChange={onFileChange}
            className="min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
          />
          {progress !== null ? (
            <progress
              value={progress}
              max={1}
              aria-label={t('common.uploading')}
              className="w-full max-w-md"
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function AttachmentsPanel({
  projectId,
  workOrderId,
  attachments,
  canWrite,
}: {
  projectId: string;
  workOrderId: string;
  attachments: WorkOrderAttachment[];
  canWrite: boolean;
}) {
  const state = useAttachments(projectId, workOrderId);
  return (
    <AttachmentsPanelView
      attachments={attachments}
      canWrite={canWrite}
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
