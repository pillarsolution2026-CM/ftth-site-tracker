'use client';

import { LOCALES } from '@ftth/i18n';
import type { MessageKey } from '@ftth/i18n';
import type { ContractSummary } from '@ftth/shared';
import { Input } from '@/shared/ui/input';
import { Select } from '@/shared/ui/form-controls';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { ProjectField, ProjectFormValues } from '../model/admin-forms';

interface ProjectFieldsProps {
  idPrefix: string;
  values: ProjectFormValues;
  errors: Partial<Record<ProjectField, MessageKey>>;
  /** Suggestions from existing projects (datalist); any valid value may be typed. */
  suggestions: { crsEpsg: string[] };
  /** Create mode: the contracts to choose from (client and currency come from the contract). */
  contracts: readonly ContractSummary[];
  /** Edit mode: the contract and the CRS are shown elsewhere / read-only. */
  editing: boolean;
  onChange: (field: ProjectField, value: string) => void;
}

/** Presentational: the fields of the project (work order) form. */
export function ProjectFields({
  idPrefix,
  values,
  errors,
  suggestions,
  contracts,
  editing,
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
      {editing ? null : (
        <Select
          id={id('contractId')}
          label={t('admin.project.contract')}
          value={values.contractId}
          required
          error={err('contractId')}
          hint={contracts.length === 0 ? t('admin.project.noContracts') : undefined}
          onChange={(event) => onChange('contractId', event.target.value)}
        >
          <option value="">{t('admin.project.chooseContract')}</option>
          {contracts.map((contract) => (
            <option key={contract.id} value={contract.id}>
              {t('admin.project.contractOption', {
                number: contract.number,
                name: contract.name,
                client: contract.client,
                currency: contract.currency,
              })}
            </option>
          ))}
        </Select>
      )}
      <div className="flex flex-col gap-1">
        <Input
          id={id('crsEpsg')}
          label={t('admin.project.crs')}
          value={values.crsEpsg}
          dir="ltr"
          inputMode="numeric"
          list={id('crs-list')}
          readOnly={editing}
          error={err('crsEpsg')}
          onChange={(event) => onChange('crsEpsg', event.target.value)}
        />
        {editing ? null : <p className="text-sm opacity-80">{t('admin.project.crsHint')}</p>}
      </div>
      <datalist id={id('crs-list')}>
        {suggestions.crsEpsg.map((value) => (
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
