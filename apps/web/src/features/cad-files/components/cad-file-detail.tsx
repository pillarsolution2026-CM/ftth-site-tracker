'use client';

import Link from 'next/link';
import { useRef, type KeyboardEvent } from 'react';
import { ltr } from '@ftth/i18n';
import type { CadFileDetail } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { PageHeader } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatBytes, formatDateTime, formatNumber } from '@/shared/lib/format';
import { CAD_TABS, useCadDetail, type CadTab } from '../hooks/use-cad-detail';
import { CadStatusBadge } from './cad-status-badge';
import { CurvesTab, InsertsTab, TextsTab } from './extraction-tabs';
import { LayersTable } from './layers-table';

function Overview({ file }: { file: CadFileDetail }) {
  const { t, locale } = useI18n();
  const facts: [string, React.ReactNode][] = [
    [t('cad.format'), <Ltr key="f">{file.format.toUpperCase()}</Ltr>],
    [t('cad.size'), <Ltr key="s">{formatBytes(file.sizeBytes)}</Ltr>],
    [t('cad.dxfVersion'), <Ltr key="v">{file.dxfVersion ?? '—'}</Ltr>],
    [
      t('cad.converter'),
      <Ltr key="c">
        {file.converter
          ? `${file.converter}${file.converterVersion ? ` ${file.converterVersion}` : ''}`
          : '—'}
      </Ltr>,
    ],
    [t('cad.insUnits'), <Ltr key="u">{file.insUnits ?? '—'}</Ltr>],
    [t('cad.uploadedAt'), <Ltr key="t">{formatDateTime(file.createdAt, locale)}</Ltr>],
    [
      t('cad.processedAt'),
      <Ltr key="p">{file.processedAt ? formatDateTime(file.processedAt, locale) : '—'}</Ltr>,
    ],
    [
      t('cad.sha256'),
      <Ltr key="h" className="font-mono text-xs break-all">
        {file.sha256}
      </Ltr>,
    ],
  ];
  const counts: [string, number | string][] = [
    [t('cad.counts.layers'), file.counts?.layers ?? '—'],
    [t('cad.counts.inserts'), file.counts?.inserts ?? '—'],
    [t('cad.counts.texts'), file.counts?.texts ?? '—'],
    [t('cad.counts.curves'), file.counts?.curves ?? '—'],
    [t('cad.warningsShort'), file.warningCount],
  ];
  return (
    <div className="flex flex-col gap-6">
      {file.status === 'failed' ? (
        <Notice kind="error">
          <p className="font-semibold">
            {file.errorCode ? t(`cad.failure.${file.errorCode}`) : t('cad.status.failed')}
          </p>
          {file.errorMessage ? (
            <Ltr className="mt-1 block font-mono text-xs break-all">{file.errorMessage}</Ltr>
          ) : null}
        </Notice>
      ) : null}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {counts.map(([label, value]) => (
          <div key={label} className="rounded-md border border-(--color-border) p-3">
            <dt className="text-sm opacity-80">{label}</dt>
            <dd className="text-xl font-semibold">
              <Ltr>{value}</Ltr>
            </dd>
          </div>
        ))}
      </dl>
      <dl className="grid gap-3 sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm opacity-80">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="extents-title">
        <h3 id="extents-title" className="mb-1 font-semibold">
          {t('cad.extents')}
        </h3>
        {file.extents ? (
          <>
            <Ltr>
              X {formatNumber(file.extents.minX, 'en')} → {formatNumber(file.extents.maxX, 'en')} ·
              Y {formatNumber(file.extents.minY, 'en')} → {formatNumber(file.extents.maxY, 'en')}
            </Ltr>
            <p className="text-sm opacity-80">{t('cad.extentsNote')}</p>
          </>
        ) : (
          <p>—</p>
        )}
      </section>
      <section aria-labelledby="warnings-title">
        <h3 id="warnings-title" className="mb-1 font-semibold">
          {t('cad.warnings')}
        </h3>
        {file.warnings.length === 0 ? (
          <p>{t('cad.noWarnings')}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {file.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`} className="flex items-start gap-2">
                <span aria-hidden="true">▲</span>
                <span>
                  {t(`cad.warning.${warning.code}`, {
                    entityType: String(warning.params?.entityType ?? ''),
                    font: String(warning.params?.font ?? ''),
                    declared: ltr(String(warning.params?.declared ?? '—')),
                    implied: ltr(String(warning.params?.implied ?? '—')),
                  })}
                  {warning.count > 1 ? (
                    <>
                      {' '}
                      <Ltr>× {warning.count}</Ltr>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function CadFileDetailScreen({
  projectId,
  cadFileId,
  listPath,
}: {
  projectId: string;
  cadFileId: string;
  listPath: string;
}) {
  const { t } = useI18n();
  const state = useCadDetail(projectId, cadFileId);
  const tabRefs = useRef<Partial<Record<CadTab, HTMLButtonElement | null>>>({});

  if (!state.canRead) return <ErrorNotice code="FORBIDDEN" />;
  if (state.loadErrorCode) return <ErrorNotice code={state.loadErrorCode} />;
  const file = state.file;
  if (!file) return <p role="status">{t('common.loading')}</p>;

  const layerNames = (state.layers ?? []).map((layer) => layer.name);
  const inFlight =
    file.status === 'queued' || file.status === 'processing' || file.status === 'uploaded';

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onTabKey = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    // In RTL the visual direction is mirrored, so ArrowRight moves to the previous tab there.
    const dirStep = document.documentElement.dir === 'rtl' ? -step : step;
    const next = CAD_TABS[(index + dirStep + CAD_TABS.length) % CAD_TABS.length];
    if (next) {
      state.setTab(next);
      tabRefs.current[next]?.focus();
      event.preventDefault();
    }
  };

  return (
    <div>
      <PageHeader>
        <h1 className="text-xl font-semibold">
          <Ltr className="break-all">{file.originalName}</Ltr>
        </h1>
        <Link
          href={listPath}
          className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
        >
          {t('cad.backToList')}
        </Link>
      </PageHeader>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <CadStatusBadge status={file.status} />
        {inFlight ? <span aria-live="polite">{t('cad.autoRefresh')}</span> : null}
        <a
          href={state.downloadUrl}
          download
          className="inline-flex min-h-11 items-center rounded-md border border-(--color-brand) px-4 font-semibold text-(--color-brand) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
        >
          {t('cad.downloadOriginal')}
        </a>
        {state.processed ? (
          <Link
            href={`${listPath}/${cadFileId}/mapping`}
            className="inline-flex min-h-11 items-center rounded-md border border-(--color-brand) px-4 font-semibold text-(--color-brand) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
          >
            {t('cad.mappingLink')}
          </Link>
        ) : null}
        {state.canWrite ? (
          <Button
            variant="outline"
            onClick={state.reprocess}
            disabled={
              state.reprocessing || file.status === 'queued' || file.status === 'processing'
            }
          >
            {state.reprocessing ? t('common.loading') : t('cad.reprocess')}
          </Button>
        ) : null}
      </div>
      {state.reprocessErrorCode ? (
        <ErrorNotice code={state.reprocessErrorCode} className="mb-3" />
      ) : null}
      <Card>
        <div role="tablist" aria-label={t('cad.tabs.label')} className="mb-4 flex flex-wrap gap-1">
          {CAD_TABS.map((tab, index) => (
            <button
              key={tab}
              ref={(element) => {
                tabRefs.current[tab] = element;
              }}
              role="tab"
              type="button"
              id={`cad-tab-${tab}`}
              aria-selected={state.tab === tab}
              aria-controls={`cad-panel-${tab}`}
              tabIndex={state.tab === tab ? 0 : -1}
              onClick={() => state.setTab(tab)}
              onKeyDown={(event) => onTabKey(event, index)}
              className={
                'min-h-11 rounded-md border px-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus) ' +
                (state.tab === tab
                  ? 'border-transparent bg-(--color-brand) text-(--color-brandContrast)'
                  : 'border-(--color-border) text-(--color-brand)')
              }
            >
              {t(`cad.tabs.${tab}`)}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`cad-panel-${state.tab}`}
          aria-labelledby={`cad-tab-${state.tab}`}
          tabIndex={0}
        >
          {state.tab === 'overview' ? <Overview file={file} /> : null}
          {state.tab !== 'overview' && state.tab !== 'log' && !state.processed ? (
            <Notice kind="info">{t('cad.notProcessed')}</Notice>
          ) : null}
          {state.processed && state.tab === 'layers' ? (
            state.layersErrorCode ? (
              <ErrorNotice code={state.layersErrorCode} />
            ) : state.layers ? (
              <LayersTable layers={state.layers} />
            ) : (
              <p role="status">{t('common.loading')}</p>
            )
          ) : null}
          {state.processed && state.tab === 'inserts' ? (
            <InsertsTab projectId={projectId} cadFileId={cadFileId} layerNames={layerNames} />
          ) : null}
          {state.processed && state.tab === 'texts' ? (
            <TextsTab projectId={projectId} cadFileId={cadFileId} layerNames={layerNames} />
          ) : null}
          {state.processed && state.tab === 'curves' ? (
            <CurvesTab projectId={projectId} cadFileId={cadFileId} layerNames={layerNames} />
          ) : null}
          {state.tab === 'log' ? (
            state.log.error ? (
              <ErrorNotice code="INTERNAL" />
            ) : state.log.data ? (
              state.log.data.log === '' ? (
                <p>{t('cad.logEmpty')}</p>
              ) : (
                <pre
                  dir="ltr"
                  className="max-h-[32rem] overflow-auto rounded-md border border-(--color-border) p-3 text-xs whitespace-pre-wrap"
                >
                  {state.log.data.log}
                </pre>
              )
            ) : (
              <p role="status">{t('common.loading')}</p>
            )
          ) : null}
        </div>
      </Card>
    </div>
  );
}
