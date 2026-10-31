'use client';

import type { FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ContractItemAvailability } from '@ftth/shared';
import { Card } from '@/shared/ui/card';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useCreateWorkOrder } from '../api/queries';
import { useHeaderForm } from '../hooks/use-header-form';
import { useLinePicker } from '../hooks/use-line-picker';
import { useWorkOrderGate, type GateBlock } from '../hooks/use-work-order-gate';
import { workOrderConflictOf } from '../model/conflict';
import { EMPTY_HEADER_FORM, headerPayload } from '../model/header-form';
import { ContractItemPicker } from './contract-item-picker';
import { HeaderFormView } from './header-form';
import { WorkOrderErrorNotice } from './work-order-error';

/** The project cannot get a work order: say why, and link to the existing one if there is one. */
export function CreateBlocked({
  reason,
  existingPath,
  existingNumber,
}: {
  reason: GateBlock;
  existingPath?: string | undefined;
  existingNumber?: string | undefined;
}) {
  const { t } = useI18n();
  return (
    <Card className="max-w-2xl">
      <h1 className="mb-4 text-xl font-semibold">{t('workOrders.new')}</h1>
      <Notice kind={reason === 'WORK_ORDER_EXISTS' ? 'info' : 'warning'}>
        {t(`workOrders.reasons.${reason}`)}
      </Notice>
      {existingPath ? (
        <Link
          href={existingPath}
          className="mt-3 inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
        >
          {t('workOrders.openExisting')}
          {existingNumber ? (
            <>
              {' '}
              <Ltr>{existingNumber}</Ltr>
            </>
          ) : null}
        </Link>
      ) : null}
    </Card>
  );
}

function CreateForm({
  projectId,
  items,
  contractNumber,
}: {
  projectId: string;
  items: ContractItemAvailability[];
  contractNumber: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const form = useHeaderForm(EMPTY_HEADER_FORM);
  const picker = useLinePicker(items);
  const create = useCreateWorkOrder(projectId);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.validate()) return;
    const lines = picker.payload ?? (picker.checks.length === 0 ? [] : null);
    if (lines === null) return;
    create.mutate(
      { ...headerPayload(form.values), lines },
      {
        onSuccess: (created) =>
          router.push(`/${locale}/projects/${projectId}/work-orders/${created.id}`),
      },
    );
  };

  const conflict = create.error ? workOrderConflictOf(create.error) : null;
  const code = create.error ? errorCodeOf(create.error) : null;
  // A CONFLICT without an ADR-028 reason is the number already used in the project.
  const numberTaken = code === 'CONFLICT' && conflict === null;
  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold">{t('workOrders.new')}</h1>
      <p className="mb-4 text-sm">
        {t('contract.title')} <Ltr>{contractNumber}</Ltr>
      </p>
      <HeaderFormView
        idPrefix="wo-create"
        values={form.values}
        errors={numberTaken ? { ...form.errors, number: 'workOrders.numberTaken' } : form.errors}
        pending={create.isPending}
        submitLabel={t('workOrders.create')}
        errorCode={null}
        conflict={false}
        onChange={form.onChange}
        onSubmit={onSubmit}
      >
        <section aria-labelledby="wo-create-lines" className="flex flex-col gap-3">
          <h2 id="wo-create-lines" className="text-lg font-semibold">
            {t('workOrders.createLines')}
          </h2>
          <p className="text-sm">{t('workOrders.linesHint')}</p>
          <ContractItemPicker
            idPrefix="wo-create-picker"
            total={items.length}
            rows={picker.rows}
            search={picker.search}
            onSearch={picker.setSearch}
            checkOf={picker.checkOf}
            onToggle={picker.toggle}
            onQuantity={picker.setQuantity}
          />
          <p role="status" className="text-sm">
            {t('items.picker.selected', { count: picker.selection.length })}
          </p>
        </section>
        {create.error && !numberTaken ? <WorkOrderErrorNotice error={create.error} /> : null}
      </HeaderFormView>
    </Card>
  );
}

export function CreateWorkOrder({ projectId }: { projectId: string }) {
  const { t, locale } = useI18n();
  const { can } = useProject();
  const gate = useWorkOrderGate(projectId);

  if (!can('work_orders:write')) return <Notice kind="error">{t('errors.FORBIDDEN')}</Notice>;
  if (gate.status === 'loading') return <p role="status">{t('common.loading')}</p>;
  if (gate.status === 'error') return <ErrorNotice code={gate.errorCode} />;
  if (gate.status === 'blocked') {
    return (
      <CreateBlocked
        reason={gate.reason}
        existingPath={
          gate.workOrder
            ? `/${locale}/projects/${projectId}/work-orders/${gate.workOrder.id}`
            : undefined
        }
        existingNumber={gate.workOrder?.number}
      />
    );
  }
  return (
    <CreateForm
      projectId={projectId}
      items={gate.availability.items}
      contractNumber={gate.availability.contractNumber}
    />
  );
}
