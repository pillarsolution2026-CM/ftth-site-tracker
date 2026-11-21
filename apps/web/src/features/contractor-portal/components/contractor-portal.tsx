'use client';

import type { MessageKey } from '@ftth/i18n';
import type { PortalRegistration, PortalTotals, PortalWork, UpdateStatus } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Select } from '@/shared/ui/form-controls';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { PageHeader, Table, Td, Th } from '@/shared/ui/table';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDecimal, formatMoney } from '@/shared/lib/decimal';
import {
  useContractorPortalPage,
  type ContractorPortalModel,
} from '../hooks/use-contractor-portal';
import { STATUS_OPTIONS } from '../model/portal-model';

const STATUS_ICON: Record<UpdateStatus, string> = { approved: '✓', pending: '◔', rejected: '✕' };
const STATUS_KEY: Record<UpdateStatus, MessageKey> = {
  approved: 'contractorPortal.approved',
  pending: 'contractorPortal.pending',
  rejected: 'contractorPortal.rejected',
};

/** Status is a word plus an icon, never colour alone. */
function StatusBadge({ status }: { status: UpdateStatus }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-0.5 text-sm">
      <span aria-hidden="true">{STATUS_ICON[status]}</span>
      {t(STATUS_KEY[status])}
    </span>
  );
}

function Totals({ totals }: { totals: readonly PortalTotals[] }) {
  const { t, locale } = useI18n();
  return (
    <section aria-labelledby="portal-totals" className="flex flex-col gap-3">
      <h2 id="portal-totals" className="text-lg font-semibold">
        {t('contractorPortal.totals')}
      </h2>
      {totals.map((entry) => (
        <Card
          key={entry.currency}
          aria-label={t('contractorPortal.totalsFor', { currency: entry.currency })}
        >
          <p className="mb-2 text-sm opacity-80">
            {t('contractorPortal.totalsFor', { currency: entry.currency })}
          </p>
          <dl className="m-0 grid gap-3 sm:grid-cols-3">
            {(['approved', 'pending', 'rejected'] as const).map((status) => (
              <div key={status}>
                <dt className="text-sm">
                  <StatusBadge status={status} />
                </dt>
                <dd className="m-0 mt-1 text-lg font-semibold">
                  <Ltr>{formatMoney(entry[status], entry.currency, locale)}</Ltr>
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      ))}
    </section>
  );
}

function RegistrationLines({ registration }: { registration: PortalRegistration }) {
  const { t, locale } = useI18n();
  const money = (value: string) => formatDecimal(value, locale, { minFractionDigits: 2 });
  return (
    <Card>
      <div className="mb-3">
        <h3 className="text-lg font-semibold">{registration.projectName}</h3>
        <p className="text-sm">
          {t('contractorPortal.workOrder')}: <Ltr>{registration.workOrderNumber}</Ltr>
          {' · '}
          {t('contractorPortal.registeredOn')}: <Ltr>{registration.registeredOn}</Ltr>
        </p>
      </div>
      {registration.lines.length === 0 ? (
        <p>{t('contractorPortal.noLines')}</p>
      ) : (
        <Table
          aria-label={t('contractorPortal.lines', {
            project: registration.projectName,
            workOrder: registration.workOrderNumber,
          })}
        >
          <thead>
            <tr>
              <Th>{t('contractorPortal.code')}</Th>
              <Th>{t('contractorPortal.description')}</Th>
              <Th>{t('contractorPortal.unit')}</Th>
              <Th>{t('contractorPortal.scope')}</Th>
              <Th>{t('contractorPortal.quantity')}</Th>
              <Th>{t('contractorPortal.recorded')}</Th>
              <Th>{t('contractorPortal.currentPrice')}</Th>
            </tr>
          </thead>
          <tbody>
            {registration.lines.map((line) => {
              const current = line.prices[line.prices.length - 1];
              return (
                <tr key={line.contractorLineId}>
                  <Td>
                    <Ltr>{line.code}</Ltr>
                  </Td>
                  <Td>{line.description}</Td>
                  <Td>{line.unit}</Td>
                  <Td>{line.scope ?? t('contractorPortal.wholeLine')}</Td>
                  <Td>
                    <Ltr>{formatDecimal(line.quantity, locale)}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{formatDecimal(line.recordedQuantity, locale)}</Ltr>
                  </Td>
                  <Td>
                    {current ? (
                      <details>
                        <summary className="min-h-11 cursor-pointer">
                          <Ltr>{money(current.unitPrice)}</Ltr>{' '}
                          <span className="text-xs opacity-80">
                            {t('contractorPortal.since', { date: current.effectiveFrom })}
                          </span>
                        </summary>
                        <p className="mt-1 text-xs font-semibold">
                          {t('contractorPortal.history')}
                        </p>
                        <ul className="m-0 list-none p-0 text-sm">
                          {line.prices.map((entry) => (
                            <li key={entry.effectiveFrom}>
                              <Ltr>{entry.effectiveFrom}</Ltr>
                              {': '}
                              <Ltr>{money(entry.unitPrice)}</Ltr>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function WorkRow({
  entry,
  model,
  currency,
}: {
  entry: PortalWork;
  model: ContractorPortalModel;
  currency: string;
}) {
  const { t, locale } = useI18n();
  const line = model.index.lineById.get(entry.contractorLineId);
  return (
    <tr>
      <Td>
        <Ltr>{entry.workDate}</Ltr>
      </Td>
      <Td>
        {t(`featureType.${entry.element.featureType}`)}
        {entry.element.code ? (
          <>
            {' '}
            <Ltr>{entry.element.code}</Ltr>
          </>
        ) : null}
      </Td>
      <Td>
        {line ? (
          <>
            <Ltr>{line.code}</Ltr> {line.description}
            <div className="text-xs opacity-80">
              {line.scope ?? t('contractorPortal.wholeLine')}
            </div>
          </>
        ) : null}
      </Td>
      <Td>
        <Ltr>{formatDecimal(entry.quantity, locale)}</Ltr>
      </Td>
      <Td>
        <StatusBadge status={entry.status} />
      </Td>
      <Td>{entry.reviewReason}</Td>
      <Td>
        <Ltr>{formatDecimal(entry.unitPrice, locale, { minFractionDigits: 2 })}</Ltr>
      </Td>
      <Td>
        <Ltr>{formatMoney(entry.value, currency, locale)}</Ltr>
      </Td>
    </tr>
  );
}

function WorkList({ model }: { model: ContractorPortalModel }) {
  const { t } = useI18n();
  const data = model.data;
  if (!data) return null;
  return (
    <section aria-labelledby="portal-work" className="flex flex-col gap-3">
      <h2 id="portal-work" className="text-lg font-semibold">
        {t('contractorPortal.work')}
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <Select
          id="portal-filter-registration"
          label={t('contractorPortal.filterRegistration')}
          value={model.filters.registrationId}
          onChange={(event) => model.onRegistrationFilter(event.target.value)}
        >
          <option value="all">{t('contractorPortal.all')}</option>
          {data.registrations.map((registration) => (
            <option key={registration.registrationId} value={registration.registrationId}>
              {`${registration.projectName} - ${registration.workOrderNumber}`}
            </option>
          ))}
        </Select>
        <Select
          id="portal-filter-status"
          label={t('contractorPortal.filterStatus')}
          value={model.filters.status}
          onChange={(event) => model.onStatusFilter(event.target.value)}
        >
          <option value="all">{t('contractorPortal.all')}</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {t(STATUS_KEY[status])}
            </option>
          ))}
        </Select>
      </div>
      {model.visibleWork.length === 0 ? (
        <p>{t('contractorPortal.noWork')}</p>
      ) : (
        <Table aria-label={t('contractorPortal.workTable')}>
          <thead>
            <tr>
              <Th>{t('contractorPortal.date')}</Th>
              <Th>{t('contractorPortal.element')}</Th>
              <Th>{t('contractorPortal.line')}</Th>
              <Th>{t('contractorPortal.quantity')}</Th>
              <Th>{t('contractorPortal.statusLabel')}</Th>
              <Th>{t('contractorPortal.reason')}</Th>
              <Th>{t('contractorPortal.unitPrice')}</Th>
              <Th>{t('contractorPortal.value')}</Th>
            </tr>
          </thead>
          <tbody>
            {model.visibleWork.map((entry) => (
              <WorkRow
                key={entry.key}
                entry={entry}
                model={model}
                currency={model.index.byRegistration.get(entry.registrationId)?.currency ?? ''}
              />
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

/** Presentational: the contractor's read-only page. No drawing, photos or supervisor. */
export function ContractorPortalView({ model }: { model: ContractorPortalModel }) {
  const { t } = useI18n();
  if (model.errorCode) return <ErrorNotice code={model.errorCode} />;
  const data = model.data;
  if (model.loading || !data) return <p role="status">{t('common.loading')}</p>;

  return (
    <div className="flex w-full max-w-6xl flex-col gap-6">
      <PageHeader>
        <div>
          <h1 className="text-xl font-semibold">{data.contractor.name}</h1>
          <p className="text-sm opacity-80">
            {t('contractorPortal.welcome', { name: model.displayName })} ·{' '}
            {t('contractorPortal.readOnly')}
          </p>
        </div>
        <Button variant="outline" onClick={model.onLogout} disabled={model.loggingOut}>
          {t('contractorPortal.logout')}
        </Button>
      </PageHeader>
      <Notice kind="info">{t('contractorPortal.pendingNote')}</Notice>
      <Totals totals={data.totals} />
      <section aria-labelledby="portal-registrations" className="flex flex-col gap-3">
        <h2 id="portal-registrations" className="text-lg font-semibold">
          {t('contractorPortal.registrations')}
        </h2>
        {data.registrations.length === 0 ? (
          <p>{t('contractorPortal.noRegistrations')}</p>
        ) : (
          data.registrations.map((registration) => (
            <RegistrationLines key={registration.registrationId} registration={registration} />
          ))
        )}
      </section>
      <WorkList model={model} />
    </div>
  );
}

export function ContractorPortal() {
  return <ContractorPortalView model={useContractorPortalPage()} />;
}
