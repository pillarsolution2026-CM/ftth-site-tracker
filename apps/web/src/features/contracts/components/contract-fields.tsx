'use client';

import { Input } from '@/shared/ui/input';
import { Textarea } from '@/shared/ui/form-controls';
import { useI18n } from '@/shared/i18n/locale-provider';
import type {
  ContractField,
  ContractFormErrors,
  ContractFormValues,
} from '../model/contract-forms';

interface ContractFieldsProps {
  idPrefix: string;
  values: ContractFormValues;
  errors: ContractFormErrors;
  /** Edit mode: the currency is shown read-only (fixed after creation). */
  fixedCurrency: boolean;
  onChange: (field: ContractField, value: string) => void;
}

/** Presentational: the header fields of a contract. */
export function ContractFields({
  idPrefix,
  values,
  errors,
  fixedCurrency,
  onChange,
}: ContractFieldsProps) {
  const { t } = useI18n();
  const err = (field: ContractField) => (errors[field] ? t(errors[field]) : undefined);
  const id = (field: string) => `${idPrefix}-${field}`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Input
        id={id('number')}
        label={t('admin.contracts.number')}
        value={values.number}
        dir="ltr"
        maxLength={64}
        required
        error={err('number')}
        onChange={(event) => onChange('number', event.target.value)}
      />
      <Input
        id={id('name')}
        label={t('admin.contracts.name')}
        value={values.name}
        maxLength={200}
        required
        error={err('name')}
        onChange={(event) => onChange('name', event.target.value)}
      />
      <Input
        id={id('client')}
        label={t('admin.contracts.client')}
        value={values.client}
        maxLength={200}
        required
        error={err('client')}
        onChange={(event) => onChange('client', event.target.value)}
      />
      <div className="flex flex-col gap-1">
        <Input
          id={id('currency')}
          label={t('admin.contracts.currency')}
          value={values.currency}
          dir="ltr"
          maxLength={3}
          readOnly={fixedCurrency}
          required={!fixedCurrency}
          error={err('currency')}
          onChange={(event) => onChange('currency', event.target.value)}
        />
        <p className="text-sm opacity-80">{t('admin.contracts.currencyHint')}</p>
      </div>
      <Input
        id={id('startsOn')}
        type="date"
        dir="ltr"
        label={t('admin.contracts.startsOn')}
        value={values.startsOn}
        error={err('startsOn')}
        onChange={(event) => onChange('startsOn', event.target.value)}
      />
      <Input
        id={id('durationDays')}
        dir="ltr"
        inputMode="numeric"
        label={t('admin.contracts.durationDays')}
        value={values.durationDays}
        error={err('durationDays')}
        onChange={(event) => onChange('durationDays', event.target.value)}
      />
      <div className="sm:col-span-2">
        <Textarea
          id={id('notes')}
          label={t('admin.contracts.notes')}
          rows={2}
          maxLength={4000}
          value={values.notes}
          error={err('notes')}
          onChange={(event) => onChange('notes', event.target.value)}
        />
      </div>
    </div>
  );
}
