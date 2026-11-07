'use client';

import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { PageHeader, Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useContractorsAdmin, type ContractorsAdminModel } from '../hooks/use-contractors-admin';
import { translateMsg } from '../model/contractor-errors';
import type { ContractorField } from '../model/contractor-forms';

const FIELDS: readonly { field: ContractorField; required: boolean; ltr: boolean; max: number }[] =
  [
    { field: 'name', required: true, ltr: false, max: 200 },
    { field: 'contactName', required: true, ltr: false, max: 200 },
    { field: 'contactPhone', required: true, ltr: true, max: 32 },
    { field: 'commercialRegister', required: false, ltr: true, max: 64 },
    { field: 'taxCard', required: false, ltr: true, max: 64 },
  ];

/** Presentational: every contractor, and the form that creates or edits one. */
export function ContractorsAdminView({ model }: { model: ContractorsAdminModel }) {
  const { t, locale } = useI18n();
  return (
    <div className="flex flex-col gap-6">
      <section>
        <PageHeader>
          <h1 className="text-xl font-semibold">{t('contractors.listTitle')}</h1>
        </PageHeader>
        {model.listError ? (
          <Notice kind="error">{translateMsg(t, locale, model.listError)}</Notice>
        ) : null}
        {model.notice ? <Notice kind="success">{t(`contractors.${model.notice}`)}</Notice> : null}
        {model.loading ? (
          <p role="status">{t('common.loading')}</p>
        ) : model.items.length === 0 ? (
          <Notice kind="info">{t('contractors.none')}</Notice>
        ) : (
          <Table aria-label={t('contractors.listTitle')}>
            <thead>
              <tr>
                <Th>{t('contractors.fields.name')}</Th>
                <Th>{t('contractors.fields.contactName')}</Th>
                <Th>{t('contractors.fields.contactPhone')}</Th>
                <Th>{t('contractors.fields.commercialRegister')}</Th>
                <Th>{t('contractors.fields.taxCard')}</Th>
                <Th>{t('contractors.fields.workOrderCount')}</Th>
                <Th>{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {model.items.map((contractor) => (
                <tr key={contractor.id}>
                  <Td>{contractor.name}</Td>
                  <Td>{contractor.contactName}</Td>
                  <Td>
                    <Ltr>{contractor.contactPhone}</Ltr>
                  </Td>
                  <Td>
                    {contractor.commercialRegister ? (
                      <Ltr>{contractor.commercialRegister}</Ltr>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>{contractor.taxCard ? <Ltr>{contractor.taxCard}</Ltr> : '—'}</Td>
                  <Td>
                    <Ltr>{contractor.workOrderCount}</Ltr>
                  </Td>
                  <Td>
                    <Button
                      variant="outline"
                      aria-label={`${t('common.edit')} ${contractor.name}`}
                      onClick={() => model.onEdit(contractor)}
                    >
                      {t('common.edit')}
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <Card className="max-w-3xl">
        <h2 className="mb-4 text-lg font-semibold">
          {model.editing ? t('contractors.edit') : t('contractors.new')}
        </h2>
        <form noValidate onSubmit={model.onSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map(({ field, required, ltr, max }) => (
              <Input
                key={field}
                id={`contractor-${field}`}
                label={
                  required
                    ? t(`contractors.fields.${field}`)
                    : `${t(`contractors.fields.${field}`)} (${t('contractors.optional')})`
                }
                value={model.values[field]}
                maxLength={max}
                required={required}
                {...(ltr ? { dir: 'ltr' as const } : {})}
                {...(field === 'contactPhone' ? { type: 'tel' } : {})}
                error={model.errors[field] ? t(model.errors[field]) : undefined}
                onChange={(event) => model.onChange(field, event.target.value)}
              />
            ))}
          </div>
          {model.submitError ? (
            <Notice kind="error">{translateMsg(t, locale, model.submitError)}</Notice>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={model.pending}>
              {model.pending
                ? t('common.saving')
                : model.editing
                  ? t('common.save')
                  : t('contractors.create')}
            </Button>
            {model.editing ? (
              <Button variant="outline" onClick={model.onCancelEdit}>
                {t('contractors.cancelEdit')}
              </Button>
            ) : null}
          </div>
        </form>
      </Card>
    </div>
  );
}

export function ContractorsAdmin() {
  return <ContractorsAdminView model={useContractorsAdmin()} />;
}
