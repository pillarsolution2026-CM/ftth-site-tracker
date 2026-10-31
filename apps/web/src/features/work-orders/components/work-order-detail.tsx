'use client';

import Link from 'next/link';
import type {
  ContractItemAvailability,
  WorkOrderDetail as WorkOrderDetailData,
} from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { PageHeader, Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDecimal, formatMoney } from '@/shared/lib/decimal';
import { useWorkOrderDetail } from '../hooks/use-work-order-detail';
import { AttachmentsPanel } from './attachments-panel';
import { HeaderFormView } from './header-form';
import { AddLinesPanel } from './add-lines-panel';
import { QuantityForm } from './quantity-form';
import { WorkOrderErrorNotice } from './work-order-error';

type DetailState = ReturnType<typeof useWorkOrderDetail>;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm opacity-80">{label}</dt>
      <dd className="min-h-6 font-medium">{children}</dd>
    </div>
  );
}

function HeaderSummary({
  workOrder,
  state,
}: {
  workOrder: WorkOrderDetailData;
  state: DetailState;
}) {
  const { t, locale } = useI18n();
  return (
    <Card>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('workOrders.number')}>
          <Ltr>{workOrder.number}</Ltr>
        </Field>
        <Field label={t('workOrders.title')}>{workOrder.title ?? '—'}</Field>
        <Field label={t('workOrders.issuedOn')}>
          {workOrder.issuedOn ? <Ltr>{workOrder.issuedOn}</Ltr> : '—'}
        </Field>
        <Field label={t('workOrders.source')}>{t(`workOrders.sources.${workOrder.source}`)}</Field>
        <Field label={t('workOrders.total')}>
          <Ltr>{formatMoney(workOrder.total, workOrder.currency, locale)}</Ltr>
        </Field>
        <Field label={t('workOrders.itemCount')}>
          <Ltr>{workOrder.itemCount}</Ltr>
        </Field>
        <Field label={t('workOrders.version')}>
          <Ltr>{workOrder.version}</Ltr>
        </Field>
        <Field label={t('workOrders.notes')}>{workOrder.notes ?? '—'}</Field>
      </dl>
      {state.canWrite ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" onClick={state.startEditHeader}>
            {t('workOrders.editHeader')}
          </Button>
          {state.confirmOrder ? (
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label={t('workOrders.confirmDelete')}
            >
              <span>{t('workOrders.confirmDelete')}</span>
              <Button disabled={state.deletingOrder} onClick={state.deleteOrder}>
                {t('common.delete')}
              </Button>
              <Button variant="outline" onClick={() => state.askDeleteOrder(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => state.askDeleteOrder(true)}>
              {t('workOrders.delete')}
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function ContractCells({ available }: { available: ContractItemAvailability | undefined }) {
  const { locale } = useI18n();
  return (
    <>
      <Td>{available ? <Ltr>{formatDecimal(available.contractQuantity, locale)}</Ltr> : '—'}</Td>
      <Td>{available ? <Ltr>{formatDecimal(available.availableQuantity, locale)}</Ltr> : '—'}</Td>
    </>
  );
}

function ItemsTable({ workOrder, state }: { workOrder: WorkOrderDetailData; state: DetailState }) {
  const { t, locale } = useI18n();
  const showContract = state.canWrite && state.availabilityItems.length > 0;
  const duplicateCodes = new Set(workOrder.duplicateCodes.map((entry) => entry.code));
  return (
    <section aria-labelledby="items-title" className="mt-8">
      <PageHeader>
        <h2 id="items-title" className="text-lg font-semibold">
          {t('items.title')}
        </h2>
        {state.canWrite && state.itemEditor === null ? (
          <Button onClick={state.openAddItem}>{t('items.add')}</Button>
        ) : null}
      </PageHeader>
      {workOrder.duplicateCodes.length > 0 ? (
        <Notice kind="warning" className="mb-3">
          <p className="font-semibold">{t('items.duplicatesPresent')}</p>
          <ul className="mt-1 list-disc ps-5">
            {workOrder.duplicateCodes.map((entry) => (
              <li key={entry.code}>
                {t('items.duplicateLine', {
                  code: entry.code,
                  lines: entry.lineNos.join(', '),
                })}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {state.actionError ? (
        <WorkOrderErrorNotice error={state.actionError} className="mb-3" />
      ) : null}
      {state.canWrite && state.itemEditor?.mode === 'add' ? (
        <div className="mb-4">
          <AddLinesPanel
            projectId={workOrder.projectId}
            workOrderId={workOrder.id}
            items={state.availabilityItems}
            disabledIds={state.contractItemIdsInOrder}
            onDone={state.closeItemEditor}
          />
        </div>
      ) : null}
      {state.canWrite && state.itemEditor?.mode === 'edit' ? (
        <div className="mb-4">
          <QuantityForm
            key={state.itemEditor.item.id}
            projectId={workOrder.projectId}
            workOrderId={workOrder.id}
            item={state.itemEditor.item}
            availability={
              state.itemEditor.item.contractItemId
                ? state.availabilityByContractItem.get(state.itemEditor.item.contractItemId)
                : undefined
            }
            onDone={state.closeItemEditor}
          />
        </div>
      ) : null}
      {workOrder.items.length === 0 ? (
        <p>{t('items.empty')}</p>
      ) : (
        <Table aria-label={t('items.title')}>
          <thead>
            <tr>
              <Th>{t('items.lineNo')}</Th>
              <Th>{t('items.code')}</Th>
              <Th>{t('items.workType')}</Th>
              <Th>{t('items.description')}</Th>
              <Th>{t('items.unit')}</Th>
              <Th>{t('items.quantity')}</Th>
              {showContract ? <Th>{t('items.contractQuantity')}</Th> : null}
              {showContract ? <Th>{t('items.availableAfter')}</Th> : null}
              <Th>{t('items.unitPrice')}</Th>
              <Th>{t('items.amount')}</Th>
              {state.canWrite ? <Th>{t('common.actions')}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {workOrder.items.map((item) => (
              <tr key={item.id}>
                <Td>
                  <Ltr>{item.lineNo}</Ltr>
                </Td>
                <Td>
                  <Ltr>{item.code}</Ltr>
                  {item.contractItemId === null ? (
                    <span className="ms-2 rounded border border-(--color-border) px-1 text-xs">
                      {t('items.legacy')}
                    </span>
                  ) : null}
                  {duplicateCodes.has(item.code) ? (
                    <span className="ms-2 rounded border border-(--status-inProgress) px-1 text-xs">
                      <span aria-hidden="true">▲ </span>
                      {t('items.duplicateBadge')}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  {item.workType ? (
                    t(`items.workTypes.${item.workType}`)
                  ) : (
                    <span className="text-(--status-rejected)">{t('items.workTypeNone')}</span>
                  )}
                </Td>
                <Td>{item.description}</Td>
                {/* Units can be up to 64 characters: wrap inside a bounded column (ADR-016). */}
                <Td className="max-w-48 min-w-24 wrap-break-word">{item.unit}</Td>
                <Td>
                  <Ltr>{formatDecimal(item.quantity, locale)}</Ltr>
                </Td>
                {showContract ? (
                  <ContractCells
                    available={
                      item.contractItemId
                        ? state.availabilityByContractItem.get(item.contractItemId)
                        : undefined
                    }
                  />
                ) : null}
                <Td>
                  <Ltr>{formatDecimal(item.unitPrice, locale, { minFractionDigits: 2 })}</Ltr>
                </Td>
                <Td>
                  <Ltr>{formatDecimal(item.amount, locale, { minFractionDigits: 2 })}</Ltr>
                </Td>
                {state.canWrite ? (
                  <Td>
                    {state.confirmItemId === item.id ? (
                      <div
                        className="flex flex-wrap items-center gap-2"
                        role="group"
                        aria-label={t('items.confirmDelete')}
                      >
                        <span>{t('items.confirmDelete')}</span>
                        <Button
                          disabled={state.deletingItem}
                          onClick={() => state.deleteItem(item.id)}
                        >
                          {t('common.delete')}
                        </Button>
                        <Button variant="outline" onClick={() => state.askDeleteItem(null)}>
                          {t('common.cancel')}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {item.contractItemId === null ? (
                          <span className="self-center text-sm">{t('items.legacyNoEdit')}</span>
                        ) : (
                          <Button
                            variant="outline"
                            aria-label={`${t('common.edit')} ${item.code}`}
                            onClick={() => state.openEditItem(item)}
                          >
                            {t('common.edit')}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          aria-label={`${t('common.delete')} ${item.code}`}
                          onClick={() => state.askDeleteItem(item.id)}
                        >
                          {t('common.delete')}
                        </Button>
                      </div>
                    )}
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

export function WorkOrderDetail({
  projectId,
  workOrderId,
  listPath,
}: {
  projectId: string;
  workOrderId: string;
  listPath: string;
}) {
  const { t } = useI18n();
  const state = useWorkOrderDetail(projectId, workOrderId);

  if (!state.canRead) return <ErrorNotice code="FORBIDDEN" />;
  if (state.loadErrorCode) return <ErrorNotice code={state.loadErrorCode} />;
  const workOrder = state.workOrder;
  if (!workOrder) return <p role="status">{t('common.loading')}</p>;

  return (
    <div>
      <PageHeader>
        <h1 className="text-xl font-semibold">
          {t('workOrders.detailTitle')} <Ltr>{workOrder.number}</Ltr>
        </h1>
        <Link
          href={listPath}
          className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
        >
          {t('workOrders.backToList')}
        </Link>
      </PageHeader>
      {state.editingHeader ? (
        <Card>
          <HeaderFormView
            idPrefix="wo-edit"
            values={state.form.values}
            errors={state.form.errors}
            pending={state.savingHeader}
            submitLabel={t('common.save')}
            errorCode={state.headerErrorCode}
            conflict={state.conflict}
            onChange={state.form.onChange}
            onSubmit={state.saveHeader}
            onCancel={state.cancelEditHeader}
            onReload={() => void state.reload()}
          />
        </Card>
      ) : (
        <HeaderSummary workOrder={workOrder} state={state} />
      )}
      <ItemsTable workOrder={workOrder} state={state} />
      <AttachmentsPanel
        projectId={projectId}
        workOrderId={workOrderId}
        attachments={workOrder.attachments}
        canWrite={state.canWrite}
      />
    </div>
  );
}
