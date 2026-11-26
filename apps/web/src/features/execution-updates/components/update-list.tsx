'use client';

import type { UpdateListItem, UpdateListLine } from '@ftth/shared';
import { Card } from '@/shared/ui/card';
import { DrawingKindBadge } from '@/shared/ui/drawing-kind-badge';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Pagination } from '@/shared/ui/pagination';
import { Select } from '@/shared/ui/form-controls';
import { PageHeader } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDateTime } from '@/shared/lib/format';
import type { ClientErrorCode } from '@/shared/api/bff-client';
import { updatePhotoUrl } from '../api/updates-api';
import { useUpdateList } from '../hooks/use-update-list';
import {
  drawingLabel,
  FILTER_LABEL,
  FLAG_LABEL,
  gpsText,
  isStatusFilter,
  STATUS_FILTERS,
  STATUS_ICON,
  STATUS_LABEL,
  type StatusFilter,
} from '../model/update-list-model';
import { LineDimensionsText } from './line-dimensions';
import { UpdateElement } from './update-element';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

function LineRow({ line }: { line: UpdateListLine }) {
  const { t } = useI18n();
  const performer =
    line.performer === null
      ? null
      : line.performer.kind === 'self'
        ? t('updatesList.line.self')
        : line.performer.scope
          ? `${line.performer.contractorName} — ${line.performer.scope}`
          : line.performer.contractorName;
  return (
    <li className="flex flex-col gap-0.5 border-t border-(--color-border) py-1 first:border-t-0">
      <span>
        <span className="font-semibold">
          {t(line.role === 'work' ? 'updatesList.line.work' : 'updatesList.line.material')}
        </span>
        {' · '}
        <Ltr>{line.itemCode}</Ltr> {line.itemDescription}
      </span>
      <span className="text-sm">
        {line.dimensions ? (
          <LineDimensionsText dimensions={line.dimensions} quantity={line.quantity} />
        ) : (
          <span>
            <Ltr>{line.quantity}</Ltr> {line.unit}
          </span>
        )}
        {' · '}
        {t('updatesList.line.workOrder', { number: line.workOrderNumber })}
        {performer ? ` · ${performer}` : null}
      </span>
    </li>
  );
}

export function UpdateCard({ projectId, update }: { projectId: string; update: UpdateListItem }) {
  const { t, locale } = useI18n();
  const drawing = drawingLabel(update.drawingKind, update.drawingOrdinal);
  return (
    <Card className="flex flex-col gap-3" data-update={update.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold">
          <UpdateElement update={update} />
          {update.featureCode ? (
            <>
              {' '}
              <Ltr>{update.featureCode}</Ltr>
            </>
          ) : null}
        </h2>
        <span
          data-status={update.status}
          className="inline-flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-0.5 text-sm font-semibold"
        >
          <span aria-hidden="true">{STATUS_ICON[update.status]}</span>
          {t(STATUS_LABEL[update.status])}
        </span>
      </div>
      <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t('updatesList.field.site')}>{update.siteName ?? '—'}</Field>
        <Field label={t('updatesList.field.drawing')}>
          <span className="inline-flex flex-wrap items-center gap-2">
            <DrawingKindBadge kind={update.drawingKind} />
            {t(drawing.key, drawing.params)}
            <span className="text-sm">{t('updatesList.field.revision', { n: update.revNo })}</span>
          </span>
        </Field>
        <Field label={t('updatesList.field.workType')}>
          {t(`items.workTypes.${update.workType}`)}
        </Field>
        <Field label={t('updatesList.field.supervisor')}>{update.supervisorName}</Field>
        <Field label={t('updatesList.field.workDate')}>
          {update.workDate ? <Ltr>{update.workDate}</Ltr> : t('updatesList.noDate')}
        </Field>
        <Field label={t('updatesList.field.received')}>
          <Ltr>{formatDateTime(update.receivedAt, locale)}</Ltr>
        </Field>
        <Field label={t('updatesList.field.captured')}>
          <Ltr>{formatDateTime(update.capturedAt, locale)}</Ltr>
        </Field>
        <Field label={t('updatesList.field.gps')}>
          {update.gps ? (
            <span className="flex flex-col">
              <Ltr>{gpsText(update.gps.lat, update.gps.lon)}</Ltr>
              {update.gps.accuracyM !== null ? (
                <span className="text-sm">
                  {t('updatesList.gps.accuracy', { accuracy: Math.round(update.gps.accuracyM) })}
                </span>
              ) : null}
              {update.gpsDistanceM !== null ? (
                <span className="text-sm">
                  {t('updatesList.gps.distance', { distance: update.gpsDistanceM })}
                </span>
              ) : null}
            </span>
          ) : (
            t('updatesList.gps.none')
          )}
        </Field>
        <Field label={t('updatesList.field.flags')}>
          {update.flags.length === 0 ? (
            t('updatesList.none')
          ) : (
            <ul className="m-0 flex list-none flex-col p-0">
              {update.flags.map((flag) => (
                <li key={flag} data-flag={flag}>
                  <span aria-hidden="true">▲</span> {t(FLAG_LABEL[flag])}
                </li>
              ))}
            </ul>
          )}
        </Field>
      </dl>
      <section aria-label={t('updatesList.field.lines')}>
        <h3 className="m-0 text-base font-semibold">{t('updatesList.field.lines')}</h3>
        <ul className="m-0 list-none p-0">
          {update.lines.map((line, index) => (
            <LineRow key={index} line={line} />
          ))}
        </ul>
      </section>
      {update.label || update.note || update.reviewReason ? (
        <dl className="m-0 flex flex-col gap-2">
          {update.label ? <Field label={t('updatesList.field.label')}>{update.label}</Field> : null}
          {update.note ? <Field label={t('updatesList.field.note')}>{update.note}</Field> : null}
          {update.reviewReason ? (
            <Field label={t('updatesList.field.reviewReason')}>{update.reviewReason}</Field>
          ) : null}
        </dl>
      ) : null}
      <section aria-label={t('updatesList.field.photos')}>
        <h3 className="m-0 text-base font-semibold">{t('updatesList.field.photos')}</h3>
        {update.photos.length === 0 ? (
          <p className="m-0">{t('updatesList.photo.none')}</p>
        ) : (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {update.photos.map((photo, index) =>
              photo.stored ? (
                <li key={photo.photoId}>
                  <a
                    href={updatePhotoUrl(projectId, photo.photoId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
                  >
                    {/* Photos come through the authenticated proxy; next/image cannot fetch them. */}
                    <img
                      src={updatePhotoUrl(projectId, photo.photoId)}
                      alt={t('updatesList.photo.open', { n: index + 1 })}
                      loading="lazy"
                      className="h-28 w-28 rounded-md border border-(--color-border) object-cover"
                    />
                  </a>
                </li>
              ) : (
                <li key={photo.photoId} className="text-sm">
                  {t('updatesList.photo.uploading', { n: index + 1 })}
                </li>
              ),
            )}
          </ul>
        )}
      </section>
    </Card>
  );
}

interface UpdateListViewProps {
  projectId: string;
  items: UpdateListItem[] | null;
  total: number;
  sites: { id: string; name: string }[];
  page: number;
  pageSize: number;
  status: StatusFilter;
  siteId: string;
  errorCode: ClientErrorCode | null;
  onStatusChange: (status: StatusFilter) => void;
  onSiteChange: (siteId: string) => void;
  onPageChange: (page: number) => void;
}

export function UpdateListView({
  projectId,
  items,
  total,
  sites,
  page,
  pageSize,
  status,
  siteId,
  errorCode,
  onStatusChange,
  onSiteChange,
  onPageChange,
}: UpdateListViewProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader className="mb-0">
        <div>
          <h1 className="text-xl font-semibold">{t('updatesList.title')}</h1>
          <p className="m-0 text-sm">{t('updatesList.hint')}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Select
            id="updates-status-filter"
            label={t('updatesList.filter.status')}
            value={status}
            onChange={(event) => {
              if (isStatusFilter(event.target.value)) onStatusChange(event.target.value);
            }}
          >
            {STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {t(FILTER_LABEL[value])}
              </option>
            ))}
          </Select>
          <Select
            id="updates-site-filter"
            label={t('updatesList.filter.site')}
            value={siteId}
            onChange={(event) => onSiteChange(event.target.value)}
          >
            <option value="">{t('updatesList.filter.allSites')}</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </Select>
        </div>
      </PageHeader>
      {errorCode ? <ErrorNotice code={errorCode} /> : null}
      {!errorCode && items === null ? <p role="status">{t('common.loading')}</p> : null}
      {items && items.length === 0 ? <p>{t('updatesList.empty')}</p> : null}
      {items && items.length > 0 ? (
        <>
          <p className="m-0">{t('updatesList.count', { count: total })}</p>
          <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label={t('updatesList.title')}>
            {items.map((update) => (
              <li key={update.id}>
                <UpdateCard projectId={projectId} update={update} />
              </li>
            ))}
          </ul>
          <Pagination page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} />
        </>
      ) : null}
    </div>
  );
}

export function UpdateList({ projectId }: { projectId: string }) {
  const state = useUpdateList(projectId);
  return (
    <UpdateListView
      projectId={projectId}
      items={state.canRead ? state.items : []}
      total={state.total}
      sites={state.sites}
      page={state.page}
      pageSize={state.pageSize}
      status={state.status}
      siteId={state.siteId}
      errorCode={!state.canRead ? 'FORBIDDEN' : state.errorCode}
      onStatusChange={state.changeStatus}
      onSiteChange={state.changeSite}
      onPageChange={state.changePage}
    />
  );
}
