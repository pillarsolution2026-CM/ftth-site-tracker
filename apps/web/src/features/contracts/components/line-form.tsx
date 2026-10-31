'use client';

import type { ChangeEvent, FormEvent } from 'react';
import { WORK_TYPES, type ContractItem, type ContractItemInput } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Select } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { MessageKey } from '@ftth/i18n';
import { useAddContractItem, useUpdateContractItem } from '../api/queries';
import { useLineForm } from '../hooks/use-line-form';
import {
  contractErrorKey,
  type LineFormErrors,
  type LineFormValues,
  type LineKind,
} from '../model/contract-forms';

export interface LineFormViewProps {
  mode: 'add' | 'edit';
  values: LineFormValues;
  errors: LineFormErrors;
  pending: boolean;
  errorKey: MessageKey | null;
  duplicateCode: string | null;
  duplicateLines: number[] | null;
  onChange: (
    field: keyof LineFormValues,
  ) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onSubmit: (event: FormEvent) => void;
  onConfirmDuplicate: () => void;
  onCancelDuplicate: () => void;
  onCancel: () => void;
}

/** Presentational: add or edit one BOQ line; a heading needs only a code (and an optional title). */
export function LineFormView({
  mode,
  values,
  errors,
  pending,
  errorKey,
  duplicateCode,
  duplicateLines,
  onChange,
  onSubmit,
  onConfirmDuplicate,
  onCancelDuplicate,
  onCancel,
}: LineFormViewProps) {
  const { t } = useI18n();
  const err = (field: Exclude<keyof LineFormValues, 'kind'>) => {
    const key = errors[field];
    return key ? t(key) : undefined;
  };
  const heading = values.kind === 'heading';
  const title =
    mode === 'add'
      ? heading
        ? t('admin.contracts.boq.addHeading')
        : t('admin.contracts.boq.addItem')
      : heading
        ? t('admin.contracts.boq.editHeading')
        : t('admin.contracts.boq.editItem');
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label={title}
      className="flex flex-col gap-4 rounded-lg border border-(--color-border) p-4"
    >
      <h3 className="text-lg font-semibold">{title}</h3>
      {errorKey ? <Notice kind="error">{t(errorKey)}</Notice> : null}
      {duplicateLines && duplicateCode ? (
        <Notice kind="warning">
          <p className="font-semibold">
            {t('items.duplicateTitle', { code: duplicateCode, lines: duplicateLines.join(', ') })}
          </p>
          <p className="mt-1">{t('items.duplicateExplain')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={onConfirmDuplicate} disabled={pending}>
              {t('items.keepSeparate')}
            </Button>
            <Button variant="outline" onClick={onCancelDuplicate}>
              {t('items.changeCode')}
            </Button>
          </div>
        </Notice>
      ) : null}
      <div className={heading ? '' : 'grid gap-4 sm:grid-cols-2'}>
        <Input
          id="line-code"
          dir="ltr"
          label={t('items.code')}
          value={values.code}
          onChange={onChange('code')}
          error={err('code')}
        />
        {heading ? null : (
          <Input
            id="line-unit"
            label={t('items.unit')}
            value={values.unit}
            onChange={onChange('unit')}
            error={err('unit')}
          />
        )}
      </div>
      <Input
        id="line-description"
        label={heading ? t('admin.contracts.boq.headingTitle') : t('items.description')}
        value={values.description}
        onChange={onChange('description')}
        error={err('description')}
      />
      {heading ? null : (
        <>
          <Select
            id="line-workType"
            label={t('items.workType')}
            value={values.workType}
            onChange={onChange('workType')}
            error={err('workType')}
          >
            <option value="">{t('items.workTypeChoose')}</option>
            {WORK_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`items.workTypes.${type}`)}
              </option>
            ))}
          </Select>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              id="line-quantity"
              dir="ltr"
              inputMode="decimal"
              label={t('admin.contracts.boq.quantity')}
              value={values.quantity}
              onChange={onChange('quantity')}
              error={err('quantity')}
            />
            <Input
              id="line-unitPrice"
              dir="ltr"
              inputMode="decimal"
              label={t('items.unitPrice')}
              value={values.unitPrice}
              onChange={onChange('unitPrice')}
              error={err('unitPrice')}
            />
          </div>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || duplicateLines !== null}>
          {pending ? t('common.saving') : t('common.save')}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

interface LineFormProps {
  contractId: string;
  version: number;
  items: readonly ContractItem[];
  editing?: ContractItem | undefined;
  initialKind: LineKind;
  onDone: () => void;
}

/** Container: add or edit one line of a draft contract. */
export function LineForm({
  contractId,
  version,
  items,
  editing,
  initialKind,
  onDone,
}: LineFormProps) {
  const add = useAddContractItem(contractId);
  const update = useUpdateContractItem(contractId);

  const send = (item: ContractItemInput, acceptDuplicateCode: boolean) => {
    const options = { onSuccess: onDone };
    if (editing) {
      update.mutate(
        { itemId: editing.id, body: { item, acceptDuplicateCode, expectedVersion: version } },
        options,
      );
    } else {
      add.mutate({ item, acceptDuplicateCode, expectedVersion: version }, options);
    }
  };
  const form = useLineForm({ items, editing, initialKind, onSubmit: send });
  const mutation = editing ? update : add;

  return (
    <LineFormView
      mode={editing ? 'edit' : 'add'}
      values={form.values}
      errors={form.errors}
      pending={mutation.isPending}
      errorKey={mutation.error ? contractErrorKey(mutation.error) : null}
      duplicateCode={form.duplicateCode}
      duplicateLines={form.duplicateLines}
      onChange={form.onChange}
      onSubmit={form.submit}
      onConfirmDuplicate={form.confirmDuplicate}
      onCancelDuplicate={form.cancelDuplicate}
      onCancel={onDone}
    />
  );
}
