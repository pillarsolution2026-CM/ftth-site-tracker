'use client';

import Link from 'next/link';
import type { ChangeEventHandler } from 'react';
import { DRAWING_KINDS, type CadFileSummary, type DrawingKind } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
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
import { useCadUpload, type KindConflict } from '../hooks/use-cad-upload';
import { groupByKind, isSuperseded } from '../model/drawing-groups';
import { CadStatusBadge } from './cad-status-badge';

export interface CadUploadViewProps {
  kind: DrawingKind | null;
  onKindChange: (kind: DrawingKind) => void;
  onFileChange: ChangeEventHandler<HTMLInputElement>;
  progress: number | null;
  uploading: boolean;
  badName: boolean;
  errorCode: ClientErrorCode | null;
  lastName: string | null;
  /** The kind already has a current file: ask «is this a new version?». */
  conflict: KindConflict | null;
  /** The PM answered «no»: the file was not uploaded. */
  declinedKind: DrawingKind | null;
  onConfirmNewVersion: () => void;
  onDeclineNewVersion: () => void;
}

export function CadUploadView({
  kind,
  onKindChange,
  onFileChange,
  progress,
  uploading,
  badName,
  errorCode,
  lastName,
  conflict,
  declinedKind,
  onConfirmNewVersion,
  onDeclineNewVersion,
}: CadUploadViewProps) {
  const { t } = useI18n();
  return (
    <Card className="mb-6 flex flex-col gap-3">
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="font-semibold">{t('cad.upload.kindLegend')}</legend>
        <div className="flex flex-wrap gap-4">
          {DRAWING_KINDS.map((option) => (
            <label key={option} className="inline-flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="cad-upload-kind"
                value={option}
                checked={kind === option}
                disabled={uploading || conflict !== null}
                onChange={() => onKindChange(option)}
                className="size-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
              />
              {t(`drawingKind.${option}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <label htmlFor="cad-file-input" className="font-semibold">
        {t('cad.upload.label')}
      </label>
      <p className="text-sm opacity-80">
        {kind ? t('cad.upload.hint') : t('cad.upload.pickKindFirst')}
      </p>
      {badName ? <Notice kind="error">{t('errors.UNSUPPORTED_FILE')}</Notice> : null}
      {errorCode ? <ErrorNotice code={errorCode} /> : null}
      {declinedKind ? (
        <Notice kind="info">{t(`cad.kindExists.declined.${declinedKind}`)}</Notice>
      ) : null}
      {conflict ? (
        <div
          role="alertdialog"
          aria-labelledby="kind-exists-title"
          aria-describedby="kind-exists-text"
          className="flex flex-col gap-3 rounded-md border-2 border-(--color-brand) p-4"
        >
          <h2 id="kind-exists-title" className="text-lg font-semibold">
            {t(`cad.kindExists.title.${conflict.kind}`)}
          </h2>
          <p id="kind-exists-text">
            {t(`cad.kindExists.text.${conflict.kind}`)}{' '}
            <Ltr className="break-all">{conflict.currentFileName}</Ltr>
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={onConfirmNewVersion}>{t('cad.kindExists.yes')}</Button>
            <Button variant="outline" onClick={onDeclineNewVersion}>
              {t('cad.kindExists.no')}
            </Button>
          </div>
        </div>
      ) : null}
      <input
        id="cad-file-input"
        type="file"
        accept=".dwg,.dxf"
        disabled={uploading || kind === null || conflict !== null}
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

function FilesTable({
  files,
  basePath,
  caption,
}: {
  files: CadFileSummary[];
  basePath: string;
  caption: string;
}) {
  const { t, locale } = useI18n();
  return (
    <Table aria-label={caption}>
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
              {isSuperseded(file) ? (
                <span
                  data-superseded="true"
                  className="ms-2 inline-flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-0.5 text-sm"
                >
                  <span aria-hidden="true">⌛</span>
                  {t('cad.superseded')}
                </span>
              ) : null}
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
  );
}

export function CadFileListView({
  basePath,
  files,
  errorCode,
  canWrite,
  upload,
}: CadFileListViewProps) {
  const { t } = useI18n();
  const groups = files ? groupByKind(files) : null;
  return (
    <div>
      <PageHeader>
        <h1 className="text-xl font-semibold">{t('cad.listTitle')}</h1>
      </PageHeader>
      {canWrite ? <CadUploadView {...upload} /> : null}
      {errorCode ? <ErrorNotice code={errorCode} /> : null}
      {!errorCode && files === null ? <p role="status">{t('common.loading')}</p> : null}
      {groups
        ? DRAWING_KINDS.map((kind) => (
            <section
              key={kind}
              aria-labelledby={`cad-section-${kind}`}
              data-kind={kind}
              className="mb-6"
            >
              <h2 id={`cad-section-${kind}`} className="mb-2 text-lg font-semibold">
                {t(`cad.section.${kind}`)}
              </h2>
              {groups[kind].length === 0 ? (
                <p>{t(`cad.sectionEmpty.${kind}`)}</p>
              ) : (
                <FilesTable
                  files={groups[kind]}
                  basePath={basePath}
                  caption={t(`cad.section.${kind}`)}
                />
              )}
            </section>
          ))
        : null}
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
