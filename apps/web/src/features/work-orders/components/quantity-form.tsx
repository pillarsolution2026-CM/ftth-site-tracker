'use client';

import type { ContractItemAvailability, WorkOrderItem } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDecimal, sumDecimals } from '@/shared/lib/decimal';
import { useQuantityForm } from '../hooks/use-quantity-form';
import { WorkOrderErrorNotice } from './work-order-error';

function ReadOnlyField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm opacity-80">{label}</dt>
      <dd className="min-h-6 font-medium">{children}</dd>
    </div>
  );
}

interface QuantityFormProps {
  projectId: string;
  workOrderId: string;
  item: WorkOrderItem;
  /** The contract item's availability, when known, for the warning. */
  availability?: ContractItemAvailability | undefined;
  onDone: () => void;
}

/**
 * Edit of a work-order line (ADR-028): only the quantity changes; code, description, unit, work
 * type and price are read-only because they come from the contract.
 */
export function QuantityForm({
  projectId,
  workOrderId,
  item,
  availability,
  onDone,
}: QuantityFormProps) {
  const { t, locale } = useI18n();
  const form = useQuantityForm(projectId, workOrderId, item, availability, onDone);

  return (
    <form
      onSubmit={form.submit}
      noValidate
      aria-label={t('items.edit')}
      className="flex flex-col gap-4 rounded-lg border border-(--color-border) p-4"
    >
      <h3 className="text-lg font-semibold">{t('items.edit')}</h3>
      <p className="text-sm">{t('items.quantityOnly')}</p>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReadOnlyField label={t('items.code')}>
          <Ltr>{item.code}</Ltr>
        </ReadOnlyField>
        <ReadOnlyField label={t('items.description')}>{item.description}</ReadOnlyField>
        <ReadOnlyField label={t('items.unit')}>{item.unit}</ReadOnlyField>
        <ReadOnlyField label={t('items.unitPrice')}>
          <Ltr>{formatDecimal(item.unitPrice, locale, { minFractionDigits: 2 })}</Ltr>
        </ReadOnlyField>
      </dl>
      {form.error ? <WorkOrderErrorNotice error={form.error} /> : null}
      <Input
        id="item-quantity"
        dir="ltr"
        inputMode="decimal"
        label={t('items.quantity')}
        value={form.value}
        onChange={(event) => form.setValue(event.target.value)}
        error={form.errorKey ? t(form.errorKey) : undefined}
        className="max-w-xs"
      />
      {form.warnExceeds && availability ? (
        <Notice kind="warning">
          {t('items.picker.exceeds', {
            available: formatDecimal(
              sumDecimals([availability.availableQuantity, item.quantity]),
              locale,
            ),
          })}
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={form.pending}>
          {form.pending ? t('common.saving') : t('common.save')}
        </Button>
        <Button variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
