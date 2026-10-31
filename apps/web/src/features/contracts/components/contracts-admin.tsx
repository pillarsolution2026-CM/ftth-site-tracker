'use client';

import Link from 'next/link';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { PageHeader, Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatMoney } from '@/shared/lib/decimal';
import { useContractsAdmin, type ContractsAdminModel } from '../hooks/use-contracts-admin';
import { ContractFields } from './contract-fields';
import { ContractStatusBadge } from './contract-status-badge';

const LINK =
  'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';

/** Presentational: every contract, and the form that creates one. */
export function ContractsAdminView({ model }: { model: ContractsAdminModel }) {
  const { t, locale } = useI18n();
  return (
    <div className="flex flex-col gap-6">
      <section>
        <PageHeader>
          <h1 className="text-xl font-semibold">{t('admin.contracts.listTitle')}</h1>
        </PageHeader>
        {model.listError ? <Notice kind="error">{t(model.listError)}</Notice> : null}
        {model.loading ? (
          <p role="status">{t('common.loading')}</p>
        ) : model.items.length === 0 ? (
          <Notice kind="info">{t('admin.contracts.none')}</Notice>
        ) : (
          <Table aria-label={t('admin.contracts.listTitle')}>
            <thead>
              <tr>
                <Th>{t('admin.contracts.number')}</Th>
                <Th>{t('admin.contracts.name')}</Th>
                <Th>{t('admin.contracts.client')}</Th>
                <Th>{t('admin.contracts.currency')}</Th>
                <Th>{t('admin.contracts.status')}</Th>
                <Th>{t('admin.contracts.itemCount')}</Th>
                <Th>{t('admin.contracts.total')}</Th>
                <Th>{t('admin.contracts.projectCount')}</Th>
                <Th>{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {model.items.map((contract) => (
                <tr key={contract.id}>
                  <Td>
                    <Ltr>{contract.number}</Ltr>
                  </Td>
                  <Td>{contract.name}</Td>
                  <Td>{contract.client}</Td>
                  <Td>
                    <Ltr>{contract.currency}</Ltr>
                  </Td>
                  <Td>
                    <ContractStatusBadge status={contract.status} />
                  </Td>
                  <Td>
                    <Ltr>{contract.itemCount}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{formatMoney(contract.total, contract.currency, locale)}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{contract.projectCount}</Ltr>
                  </Td>
                  <Td>
                    <Link
                      className={LINK}
                      href={`/${locale}/admin/contracts/${contract.id}`}
                      aria-label={`${t('admin.contracts.manage')} ${contract.number}`}
                    >
                      {t('admin.contracts.manage')}
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <Card className="max-w-3xl">
        <h2 className="mb-4 text-lg font-semibold">{t('admin.contracts.new')}</h2>
        <form noValidate onSubmit={model.onSubmit} className="flex flex-col gap-4">
          <ContractFields
            idPrefix="contract-new"
            values={model.values}
            errors={model.errors}
            fixedCurrency={false}
            onChange={model.onChange}
          />
          {model.submitError ? <Notice kind="error">{t(model.submitError)}</Notice> : null}
          <div>
            <Button type="submit" disabled={model.pending}>
              {model.pending ? t('common.saving') : t('admin.contracts.create')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

export function ContractsAdmin() {
  return <ContractsAdminView model={useContractsAdmin()} />;
}
