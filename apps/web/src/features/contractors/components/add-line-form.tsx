'use client';

import { ltr } from '@ftth/i18n';
import type { ContractorLineAvailability, ContractorRegistration } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Select } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDecimal } from '@/shared/lib/decimal';
import type { LineActionsModel } from '../hooks/use-line-actions';
import { translateMsg } from '../model/contractor-errors';
import { addLineBlockReason } from '../model/contractor-forms';

interface AddLineFormProps {
  registration: ContractorRegistration;
  availability: readonly ContractorLineAvailability[];
  actions: LineActionsModel;
}

/** Presentational: add one more work-order line to a registered contractor. */
export function AddLineForm({ registration, availability, actions }: AddLineFormProps) {
  const { t, locale } = useI18n();
  const name = registration.contractor.name;
  const text = (message: Parameters<typeof translateMsg>[2] | undefined) =>
    message ? translateMsg(t, locale, message) : undefined;
  const id = `add-line-${registration.id}`;
  const values = actions.addValues;
  return (
    <form
      noValidate
      aria-label={t('contractors.line.addTitle', { name })}
      onSubmit={(event) => actions.submitAddLine(event, registration)}
      className="mt-3 flex flex-col gap-3 rounded-md border border-(--color-border) p-3"
    >
      <h4 className="font-semibold">{t('contractors.line.addTitle', { name })}</h4>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select
          id={`${id}-item`}
          label={t('contractors.line.chooseLine')}
          value={values.workOrderItemId}
          error={text(actions.addErrors.workOrderItemId)}
          onChange={(event) => actions.onAddChange('workOrderItemId', event.target.value)}
        >
          <option value="">{t('contractors.line.chooseLineOption')}</option>
          {availability.map((line) => {
            const blocked = addLineBlockReason(line, registration);
            return (
              <option
                key={line.workOrderItemId}
                value={line.workOrderItemId}
                disabled={blocked !== null}
              >
                {line.code} — {line.description}
                {blocked
                  ? ` (${t(blocked)})`
                  : ` (${t('contractors.line.availableShort', {
                      available: formatDecimal(line.availableQuantity, locale),
                    })})`}
              </option>
            );
          })}
        </Select>
        <Input
          id={`${id}-quantity`}
          dir="ltr"
          inputMode="decimal"
          label={t('contractors.line.quantity')}
          value={values.quantity}
          error={text(actions.addErrors.quantity)}
          onChange={(event) => actions.onAddChange('quantity', event.target.value)}
        />
        <Input
          id={`${id}-price`}
          dir="ltr"
          inputMode="decimal"
          label={t('contractors.register.priceHeader')}
          value={values.unitPrice}
          error={text(actions.addErrors.unitPrice)}
          onChange={(event) => actions.onAddChange('unitPrice', event.target.value)}
        />
      </div>
      <p className="text-sm opacity-80">
        {t('contractors.line.firstPriceHint', { date: ltr(registration.registeredOn) })}
      </p>
      {actions.actionError ? (
        <Notice kind="error">{translateMsg(t, locale, actions.actionError)}</Notice>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={actions.pending}>
          {actions.pending ? t('common.saving') : t('contractors.line.submitAdd')}
        </Button>
        <Button variant="outline" onClick={actions.close}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
