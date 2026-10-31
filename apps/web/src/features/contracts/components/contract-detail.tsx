'use client';

import Link from 'next/link';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { PageHeader } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useContractDetail, type ContractDetailModel } from '../hooks/use-contract-detail';
import { ApproveDialog } from './approve-dialog';
import { BoqTable } from './boq-table';
import { ContractAttachments } from './contract-attachments';
import { ContractFields } from './contract-fields';
import { ContractSummaryFields } from './contract-summary';
import { LineForm } from './line-form';

const LINK =
  'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';

function HeaderCard({ model }: { model: ContractDetailModel }) {
  const { t } = useI18n();
  const { contract, header } = model;
  if (!contract) return null;
  if (header.editing && header.values) {
    return (
      <Card>
        <h2 className="mb-4 text-lg font-semibold">{t('admin.contracts.edit')}</h2>
        <form noValidate onSubmit={header.onSubmit} className="flex flex-col gap-4">
          <ContractFields
            idPrefix="contract-edit"
            values={header.values}
            errors={header.errors}
            fixedCurrency
            onChange={header.onChange}
          />
          {header.errorKey ? (
            <Notice kind="error">
              {t(header.errorKey)}
              {header.errorKey === 'admin.contracts.reasons.STALE_VERSION' ? (
                <Button variant="outline" className="ms-3" onClick={() => void model.reload()}>
                  {t('admin.contracts.reload')}
                </Button>
              ) : null}
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={header.pending}>
              {header.pending ? t('common.saving') : t('common.save')}
            </Button>
            <Button variant="outline" onClick={header.cancel}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      </Card>
    );
  }
  return (
    <Card>
      <ContractSummaryFields contract={contract} />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" onClick={header.start}>
          {t('admin.contracts.edit')}
        </Button>
      </div>
    </Card>
  );
}

function BoqSection({ model }: { model: ContractDetailModel }) {
  const { t, locale } = useI18n();
  const { contract } = model;
  if (!contract) return null;
  const draft = model.canEditBoq;
  return (
    <section aria-labelledby="boq-title" className="mt-8">
      <PageHeader>
        <h2 id="boq-title" className="text-lg font-semibold">
          {t('admin.contracts.boq.title')}
        </h2>
        {draft && model.lineEditor === null && !model.approving ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => model.openAddLine('item')}>
              {t('admin.contracts.boq.addItem')}
            </Button>
            <Button variant="outline" onClick={() => model.openAddLine('heading')}>
              {t('admin.contracts.boq.addHeading')}
            </Button>
            <Link
              href={`/${locale}/admin/contracts/${contract.id}/import`}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-(--color-brand) px-4 text-base font-semibold text-(--color-brand) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
            >
              {t('admin.contracts.import.button')}
            </Link>
            <Button variant="outline" onClick={() => model.askApprove(true)}>
              {t('admin.contracts.approve.button')}
            </Button>
          </div>
        ) : null}
      </PageHeader>
      {draft ? null : (
        <Notice kind="info" live={false} className="mb-3">
          {t('admin.contracts.boq.locked')}
        </Notice>
      )}
      {model.approving ? (
        <ApproveDialog
          pending={model.approvePending}
          errorKey={model.approveErrorKey}
          onConfirm={model.approve}
          onCancel={() => model.askApprove(false)}
        />
      ) : null}
      {contract.duplicateCodes.length > 0 ? (
        <Notice kind="warning" className="mb-3">
          <p className="font-semibold">{t('items.duplicatesPresent')}</p>
          <ul className="mt-1 list-disc ps-5">
            {contract.duplicateCodes.map((entry) => (
              <li key={entry.code}>
                {t('items.duplicateLine', { code: entry.code, lines: entry.lineNos.join(', ') })}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {model.lineActionErrorKey ? (
        <Notice kind="error" className="mb-3">
          {t(model.lineActionErrorKey)}
        </Notice>
      ) : null}
      {draft && model.lineEditor ? (
        <div className="mb-4">
          <LineForm
            key={model.lineEditor.mode === 'edit' ? model.lineEditor.item.id : 'add'}
            contractId={contract.id}
            version={contract.version}
            items={contract.items}
            editing={model.lineEditor.mode === 'edit' ? model.lineEditor.item : undefined}
            initialKind={model.lineEditor.mode === 'add' ? model.lineEditor.kind : 'item'}
            onDone={model.closeLineEditor}
          />
        </div>
      ) : null}
      {contract.items.length === 0 ? (
        <p>{t('admin.contracts.boq.empty')}</p>
      ) : (
        <BoqTable
          contract={contract}
          editing={
            draft
              ? {
                  confirmItemId: model.confirmItemId,
                  deleting: model.deletingLine,
                  onEdit: model.openEditLine,
                  onAskDelete: model.askDeleteLine,
                  onDelete: model.deleteLine,
                }
              : undefined
          }
        />
      )}
    </section>
  );
}

/** Presentational: one contract (header, BOQ, attachments) for the platform admin. */
export function ContractDetailView({ model }: { model: ContractDetailModel }) {
  const { t, locale } = useI18n();
  if (model.loadErrorCode) return <ErrorNotice code={model.loadErrorCode} />;
  const { contract } = model;
  if (!contract) return <p role="status">{t('common.loading')}</p>;
  return (
    <div className="flex max-w-6xl flex-col">
      <PageHeader>
        <h1 className="text-xl font-semibold">
          {t('admin.contracts.detailTitle')} <Ltr>{contract.number}</Ltr>
        </h1>
        <div className="flex flex-wrap gap-3">
          <Link className={LINK} href={`/${locale}/admin/contracts`}>
            {t('admin.contracts.back')}
          </Link>
          <Button variant="outline" onClick={() => void model.reload()}>
            {t('admin.contracts.reload')}
          </Button>
        </div>
      </PageHeader>
      <HeaderCard model={model} />
      <BoqSection model={model} />
      <ContractAttachments contractId={contract.id} attachments={contract.attachments} />
    </div>
  );
}

export function ContractDetail({ contractId }: { contractId: string }) {
  return <ContractDetailView model={useContractDetail(contractId)} />;
}
