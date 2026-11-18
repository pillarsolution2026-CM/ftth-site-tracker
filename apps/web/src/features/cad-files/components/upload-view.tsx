'use client';

import Link from 'next/link';
import type { ChangeEventHandler } from 'react';
import { ltr } from '@ftth/i18n';
import { DRAWING_KINDS, type DrawingKind } from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { Card } from '@/shared/ui/card';
import { Select } from '@/shared/ui/form-controls';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { ClientErrorCode } from '@/shared/api/bff-client';
import {
  drawingLabel,
  versionChoice,
  type UploadChoice,
  type UploadOptions,
  type UploadRefusal,
} from '../model/site-drawings';

export interface CadUploadViewProps {
  sites: { id: string; name: string }[];
  siteId: string | null;
  kind: DrawingKind | null;
  choice: UploadChoice | null;
  options: UploadOptions | null;
  onSiteChange: (siteId: string) => void;
  onKindChange: (kind: DrawingKind) => void;
  onChoiceChange: (choice: UploadChoice) => void;
  ready: boolean;
  onFileChange: ChangeEventHandler<HTMLInputElement>;
  progress: number | null;
  uploading: boolean;
  badName: boolean;
  errorCode: ClientErrorCode | null;
  refusal: UploadRefusal | null;
  lastName: string | null;
  /** The work order page, «المواقع» section; null when unknown. */
  workOrderHref: string | null;
}

const RADIO =
  'size-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';

/**
 * The upload dialog (ADR-049 part B): the site from the work order, the kind, then «new drawing»
 * or «new version of …» (a General that exists takes only a new version), then the file.
 */
export function CadUploadView({
  sites,
  siteId,
  kind,
  choice,
  options,
  onSiteChange,
  onKindChange,
  onChoiceChange,
  ready,
  onFileChange,
  progress,
  uploading,
  badName,
  errorCode,
  refusal,
  lastName,
  workOrderHref,
}: CadUploadViewProps) {
  const { t } = useI18n();
  if (sites.length === 0) {
    return (
      <Card className="mb-6 flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t('siteDrawings.upload.title')}</h2>
        <Notice kind="warning">{t('siteDrawings.upload.noSites')}</Notice>
        {workOrderHref ? (
          <Link
            href={workOrderHref}
            className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
          >
            {t('siteDrawings.upload.openWorkOrder')}
          </Link>
        ) : null}
      </Card>
    );
  }
  const busy = uploading;
  const hint = !siteId
    ? t('siteDrawings.upload.pickSiteFirst')
    : !kind
      ? t('siteDrawings.upload.pickKindFirst')
      : !choice
        ? t('siteDrawings.upload.pickTargetFirst')
        : t('siteDrawings.upload.hint');
  return (
    <Card className="mb-6 flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{t('siteDrawings.upload.title')}</h2>
      <Select
        id="upload-site"
        label={t('siteDrawings.upload.site')}
        value={siteId ?? ''}
        disabled={busy}
        onChange={(event) => onSiteChange(event.target.value)}
      >
        <option value="">{t('siteDrawings.upload.pickSite')}</option>
        {sites.map((site) => (
          <option key={site.id} value={site.id}>
            {site.name}
          </option>
        ))}
      </Select>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" disabled={busy || !siteId}>
        <legend className="font-semibold">{t('siteDrawings.upload.kindLegend')}</legend>
        <div className="flex flex-wrap gap-4">
          {DRAWING_KINDS.map((option) => (
            <label key={option} className="inline-flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="cad-upload-kind"
                value={option}
                checked={kind === option}
                onChange={() => onKindChange(option)}
                className={RADIO}
              />
              {t(`drawingKind.${option}`)}
            </label>
          ))}
        </div>
      </fieldset>
      {kind && options ? (
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" disabled={busy}>
          <legend className="font-semibold">{t('siteDrawings.upload.targetLegend')}</legend>
          {kind === 'general' && !options.canCreate ? (
            <p className="text-sm">{t('siteDrawings.upload.generalExistsHint')}</p>
          ) : null}
          {options.canCreate ? (
            <TargetRadio
              value="new_drawing"
              checked={choice === 'new_drawing'}
              onChange={onChoiceChange}
              label={t(
                kind === 'general'
                  ? 'siteDrawings.upload.newGeneral'
                  : 'siteDrawings.upload.newDrawing',
              )}
            />
          ) : null}
          {options.versions.map((drawing) => {
            const label = drawingLabel(drawing);
            return (
              <TargetRadio
                key={drawing.id}
                value={versionChoice(drawing.id)}
                checked={choice === versionChoice(drawing.id)}
                onChange={onChoiceChange}
                label={t('siteDrawings.upload.newVersion', {
                  drawing: t(label.key, { n: ltr(label.ordinal ?? 1) }),
                })}
                note={
                  drawing.currentFileName
                    ? t('siteDrawings.upload.currentFile', { file: ltr(drawing.currentFileName) })
                    : null
                }
              />
            );
          })}
        </fieldset>
      ) : null}
      <label htmlFor="cad-file-input" className="font-semibold">
        {t('siteDrawings.upload.label')}
      </label>
      <p className="text-sm opacity-80">{hint}</p>
      {badName ? <Notice kind="error">{t('errors.UNSUPPORTED_FILE')}</Notice> : null}
      {refusal ? <Notice kind="error">{t(refusal.key, refusal.params)}</Notice> : null}
      {errorCode ? <ErrorNotice code={errorCode} /> : null}
      <input
        id="cad-file-input"
        type="file"
        accept=".dwg,.dxf"
        disabled={busy || !ready}
        onChange={onFileChange}
        className="min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
      />
      {uploading ? (
        <div role="status" className="flex flex-wrap items-center gap-2">
          <span>
            {t('siteDrawings.upload.uploading')} <Ltr>{lastName}</Ltr>
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

function TargetRadio({
  value,
  checked,
  onChange,
  label,
  note,
}: {
  value: UploadChoice;
  checked: boolean;
  onChange: (choice: UploadChoice) => void;
  label: string;
  note?: string | null;
}) {
  return (
    <label className="inline-flex min-h-11 flex-wrap items-center gap-2">
      <input
        type="radio"
        name="cad-upload-target"
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className={RADIO}
      />
      {label}
      {note ? <span className="text-sm opacity-80">({note})</span> : null}
    </label>
  );
}
