'use client';

import type { ChangeEvent, FormEvent } from 'react';
import type { WorkOrderItem, WorkOrderItemInput } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Input } from '@/shared/ui/input';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { errorCodeOf, type ClientErrorCode } from '@/shared/api/bff-client';
import { useAddItem, useUpdateItem } from '../api/queries';
import { useItemForm } from '../hooks/use-item-form';
import type { ItemFormErrors, ItemFormValues } from '../model/item-form';

export interface ItemFormViewProps {
  mode: 'add' | 'edit';
  values: ItemFormValues;
  errors: ItemFormErrors;
  pending: boolean;
  errorCode: ClientErrorCode | null;
  duplicateCode: string | null;
  duplicateLines: number[] | null;
  onChange: (field: keyof ItemFormValues) => (event: ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: FormEvent) => void;
  onConfirmDuplicate: () => void;
  onCancelDuplicate: () => void;
  onCancel: () => void;
}

export function ItemFormView({
  mode,
  values,
  errors,
  pending,
  errorCode,
  duplicateCode,
  duplicateLines,
  onChange,
  onSubmit,
  onConfirmDuplicate,
  onCancelDuplicate,
  onCancel,
}: ItemFormViewProps) {
  const { t } = useI18n();
  const err = (field: keyof ItemFormValues) => {
    const key = errors[field];
    return key ? t(key) : undefined;
  };
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label={mode === 'add' ? t('items.add') : t('items.edit')}
      className="flex flex-col gap-4 rounded-lg border border-(--color-border) p-4"
    >
      <h3 className="text-lg font-semibold">{mode === 'add' ? t('items.add') : t('items.edit')}</h3>
      {errorCode ? <ErrorNotice code={errorCode} /> : null}
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          id="item-code"
          dir="ltr"
          label={t('items.code')}
          value={values.code}
          onChange={onChange('code')}
          error={err('code')}
        />
        <Input
          id="item-unit"
          label={t('items.unit')}
          value={values.unit}
          onChange={onChange('unit')}
          error={err('unit')}
        />
      </div>
      <Input
        id="item-description"
        label={t('items.description')}
        value={values.description}
        onChange={onChange('description')}
        error={err('description')}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          id="item-quantity"
          dir="ltr"
          inputMode="decimal"
          label={t('items.quantity')}
          value={values.quantity}
          onChange={onChange('quantity')}
          error={err('quantity')}
        />
        <Input
          id="item-unitPrice"
          dir="ltr"
          inputMode="decimal"
          label={t('items.unitPrice')}
          value={values.unitPrice}
          onChange={onChange('unitPrice')}
          error={err('unitPrice')}
        />
      </div>
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

interface ItemFormProps {
  projectId: string;
  workOrderId: string;
  items: readonly WorkOrderItem[];
  editing?: WorkOrderItem | undefined;
  onDone: () => void;
}

/** Container: add or edit one line. */
export function ItemForm({ projectId, workOrderId, items, editing, onDone }: ItemFormProps) {
  const add = useAddItem(projectId, workOrderId);
  const update = useUpdateItem(projectId, workOrderId);

  const send = (data: WorkOrderItemInput, acceptDuplicateCode: boolean) => {
    const options = { onSuccess: onDone };
    if (editing) {
      update.mutate({ itemId: editing.id, body: { ...data, acceptDuplicateCode } }, options);
    } else {
      add.mutate({ ...data, acceptDuplicateCode }, options);
    }
  };
  const form = useItemForm({ items, editing, onSubmit: send });
  const mutation = editing ? update : add;

  return (
    <ItemFormView
      mode={editing ? 'edit' : 'add'}
      values={form.values}
      errors={form.errors}
      pending={mutation.isPending}
      errorCode={mutation.error ? errorCodeOf(mutation.error) : null}
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
