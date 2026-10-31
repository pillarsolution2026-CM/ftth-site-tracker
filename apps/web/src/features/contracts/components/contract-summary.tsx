'use client';

import type { ReactNode } from 'react';
import type { ContractDetail } from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDateTime } from '@/shared/lib/format';
import { formatMoney } from '@/shared/lib/decimal';
import { ContractStatusBadge } from './contract-status-badge';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm opacity-80">{label}</dt>
      <dd className="min-h-6 font-medium">{children}</dd>
    </div>
  );
}

/** Read-only header of a contract, shared by the admin page and the project page. */
export function ContractSummaryFields({ contract }: { contract: ContractDetail }) {
  const { t, locale } = useI18n();
  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label={t('admin.contracts.number')}>
        <Ltr>{contract.number}</Ltr>
      </Field>
      <Field label={t('admin.contracts.name')}>{contract.name}</Field>
      <Field label={t('admin.contracts.client')}>{contract.client}</Field>
      <Field label={t('admin.contracts.currency')}>
        <Ltr>{contract.currency}</Ltr>
      </Field>
      <Field label={t('admin.contracts.status')}>
        <ContractStatusBadge status={contract.status} />
      </Field>
      <Field label={t('admin.contracts.approvedOn')}>
        {contract.approvedAt ? <Ltr>{formatDateTime(contract.approvedAt, locale)}</Ltr> : '—'}
      </Field>
      <Field label={t('admin.contracts.startsOn')}>
        {contract.startsOn ? <Ltr>{contract.startsOn}</Ltr> : '—'}
      </Field>
      <Field label={t('admin.contracts.durationDays')}>
        {contract.durationDays === null ? '—' : <Ltr>{contract.durationDays}</Ltr>}
      </Field>
      <Field label={t('admin.contracts.total')}>
        <Ltr>{formatMoney(contract.total, contract.currency, locale)}</Ltr>
      </Field>
      <Field label={t('admin.contracts.itemCount')}>
        <Ltr>{contract.itemCount}</Ltr>
      </Field>
      <Field label={t('admin.contracts.projectCount')}>
        <Ltr>{contract.projectCount}</Ltr>
      </Field>
      <Field label={t('admin.contracts.notes')}>{contract.notes ?? '—'}</Field>
    </dl>
  );
}
