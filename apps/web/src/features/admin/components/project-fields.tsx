'use client';

import { LOCALES } from '@ftth/i18n';
import type { MessageKey } from '@ftth/i18n';
import { Input } from '@/shared/ui/input';
import { Select } from '@/shared/ui/form-controls';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { ProjectField, ProjectFormValues } from '../model/admin-forms';

interface ProjectFieldsProps {
  idPrefix: string;
  values: ProjectFormValues;
  errors: Partial<Record<ProjectField, MessageKey>>;
  /** Suggestions from existing projects (datalists); any valid value may be typed. */
  suggestions: { crsEpsg: string[]; currency: string[]; clients: string[] };
  /** Edit mode: the CRS and the currency are shown read-only. */
  fixedCrsAndCurrency: boolean;
  onChange: (field: ProjectField, value: string) => void;
}

/** Presentational: the fields of the project form. */
export function ProjectFields({
  idPrefix,
  values,
  errors,
  suggestions,
  fixedCrsAndCurrency,
  onChange,
}: ProjectFieldsProps) {
  const { t } = useI18n();
  const err = (field: ProjectField) => (errors[field] ? t(errors[field]) : undefined);
  const id = (field: string) => `${idPrefix}-${field}`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Input
        id={id('name')}
        label={t('admin.project.name')}
        value={values.name}
        maxLength={200}
        required
        error={err('name')}
        onChange={(event) => onChange('name', event.target.value)}
      />
      <Input
        id={id('client')}
        label={t('admin.project.client')}
        value={values.client}
        maxLength={200}
        required
        list={id('client-list')}
        error={err('client')}
        onChange={(event) => onChange('client', event.target.value)}
      />
      <datalist id={id('client-list')}>
        {suggestions.clients.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <div className="flex flex-col gap-1">
        <Input
          id={id('crsEpsg')}
          label={t('admin.project.crs')}
          value={values.crsEpsg}
          dir="ltr"
          inputMode="numeric"
          list={id('crs-list')}
          readOnly={fixedCrsAndCurrency}
          error={err('crsEpsg')}
          onChange={(event) => onChange('crsEpsg', event.target.value)}
        />
        {fixedCrsAndCurrency ? null : (
          <p className="text-sm opacity-80">{t('admin.project.crsHint')}</p>
        )}
      </div>
      <datalist id={id('crs-list')}>
        {suggestions.crsEpsg.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <div className="flex flex-col gap-1">
        <Input
          id={id('currency')}
          label={t('admin.project.currency')}
          value={values.currency}
          dir="ltr"
          maxLength={3}
          list={id('currency-list')}
          readOnly={fixedCrsAndCurrency}
          error={err('currency')}
          onChange={(event) => onChange('currency', event.target.value.toUpperCase())}
        />
        {fixedCrsAndCurrency ? null : (
          <p className="text-sm opacity-80">{t('admin.project.currencyHint')}</p>
        )}
      </div>
      <datalist id={id('currency-list')}>
        {suggestions.currency.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <Select
        id={id('locale')}
        label={t('admin.project.locale')}
        value={values.locale}
        error={err('locale')}
        onChange={(event) => onChange('locale', event.target.value)}
      >
        {LOCALES.map((value) => (
          <option key={value} value={value}>
            {t(`admin.locales.${value}`)}
          </option>
        ))}
      </Select>
    </div>
  );
}
