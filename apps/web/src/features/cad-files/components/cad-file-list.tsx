'use client';

import Link from 'next/link';
import type { ChangeEventHandler } from 'react';
import type { CadFileSummary } from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { Card } from '@/shared/ui/card';
import { PageHeader, Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatBytes, formatDateTime } from '@/shared/lib/format';
import { errorCodeOf, type ClientErrorCode } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useCadFiles } from '../api/queries';
import { useCadUpload } from '../hooks/use-cad-upload';
import { CadStatusBadge } from './cad-status-badge';

export interface CadUploadViewProps {
  onFileChange: ChangeEventHandler<HTMLInputElement>;
  progress: number | null;
  uploading: boolean;
  badName: boolean;
  errorCode: ClientErrorCode | null;
  lastName: string | null;
}

export function CadUploadView({
  onFileChange,
  progress,
  uploading,
  badName,
  errorCode,
  lastName,
}: CadUploadViewProps) {
  const { t } = useI18n();
  return (
    <Card className="mb-6 flex flex-col gap-2">
      <label htmlFor="cad-file-input" className="font-semibold">
        {t('cad.upload.label')}
      </label>
      <p className="text-sm opacity-80">{t('cad.upload.hint')}</p>
      {badName ? <Notice kind="error">{t('errors.UNSUPPORTED_FILE')}</Notice> : null}
      {errorCode ? <ErrorNotice code={errorCode} /> : null}
      <input
        id="cad-file-input"
        type="file"
        accept=".dwg,.dxf"
        disabled={uploading}
        onChange={onFileChange}
        className="min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
      />
      {uploading ? (
        <div role="status" className="flex flex-wrap items-center gap-2">
          <span>
            {t('cad.upload.uploading')} <Ltr>{lastName}</Ltr>
          </span>
          <progress
            value={progress ?? 0}
            max={1}
            aria-label={t('common.uploading')}
            className="w-full max-w-md"
          />
          <Ltr>{Math.round((progress ?? 0) * 100)}%</Ltr>
        </div>
      ) : null}
    </Card>
  );
}

interface CadFileListViewProps {
  basePath: string;
  files: CadFileSummary[] | null;
  errorCode: ClientErrorCode | null;
  canWrite: boolean;
  upload: CadUploadViewProps;
}

export function CadFileListView({
  basePath,
  files,
  errorCode,
  canWrite,
  upload,
}: CadFileListViewProps) {
  const { t, locale } = useI18n();
  return (
    <div>
      <PageHeader>
        <h1 className="text-xl font-semibold">{t('cad.listTitle')}</h1>
      </PageHeader>
      {canWrite ? <CadUploadView {...upload} /> : null}
      {errorCode ? <ErrorNotice code={errorCode} /> : null}
      {!errorCode && files === null ? <p role="status">{t('common.loading')}</p> : null}
      {files && files.length === 0 ? <p>{t('cad.empty')}</p> : null}
      {files && files.length > 0 ? (
        <Table aria-label={t('cad.listTitle')}>
          <thead>
            <tr>
              <Th>{t('cad.fileName')}</Th>
              <Th>{t('cad.format')}</Th>
              <Th>{t('cad.size')}</Th>
              <Th>{t('cad.statusLabel')}</Th>
              <Th>{t('cad.counts.layers')}</Th>
              <Th>{t('cad.counts.inserts')}</Th>
              <Th>{t('cad.counts.texts')}</Th>
              <Th>{t('cad.counts.curves')}</Th>
              <Th>{t('cad.warningsShort')}</Th>
              <Th>{t('cad.uploadedAt')}</Th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.id}>
                <Td>
                  <Link
                    href={`${basePath}/${file.id}`}
                    className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
                  >
                    <Ltr className="break-all">{file.originalName}</Ltr>
                  </Link>
                </Td>
                <Td>
                  <Ltr>{file.format.toUpperCase()}</Ltr>
                </Td>
                <Td>
                  <Ltr>{formatBytes(file.sizeBytes)}</Ltr>
                </Td>
                <Td>
                  <CadStatusBadge status={file.status} />
                  {file.status === 'failed' && file.errorCode ? (
                    <p className="mt-1 text-sm">{t(`cad.failure.${file.errorCode}`)}</p>
                  ) : null}
                </Td>
                <Td>
                  <Ltr>{file.counts?.layers ?? '—'}</Ltr>
                </Td>
                <Td>
                  <Ltr>{file.counts?.inserts ?? '—'}</Ltr>
                </Td>
                <Td>
                  <Ltr>{file.counts?.texts ?? '—'}</Ltr>
                </Td>
                <Td>
                  <Ltr>{file.counts?.curves ?? '—'}</Ltr>
                </Td>
                <Td>
                  <Ltr>{file.warningCount}</Ltr>
                </Td>
                <Td>
                  <Ltr>{formatDateTime(file.createdAt, locale)}</Ltr>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </div>
  );
}

export function CadFileList({ projectId }: { projectId: string }) {
  const { locale } = useI18n();
  const { can } = useProject();
  const canRead = can('cad_files:read');
  const query = useCadFiles(projectId, canRead);
  const upload = useCadUpload(projectId);
  return (
    <CadFileListView
      basePath={`/${locale}/projects/${projectId}/cad-files`}
      files={canRead ? (query.data?.items ?? null) : []}
      errorCode={!canRead ? 'FORBIDDEN' : query.error ? errorCodeOf(query.error) : null}
      canWrite={can('cad_files:write')}
      upload={upload}
    />
  );
}
