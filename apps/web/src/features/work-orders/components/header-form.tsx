'use client';

import type { ChangeEvent, FormEvent } from 'react';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Textarea } from '@/shared/ui/form-controls';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { ClientErrorCode } from '@/shared/api/bff-client';
import type { HeaderFormErrors, HeaderFormValues } from '../model/header-form';

export interface HeaderFormViewProps {
  idPrefix: string;
  values: HeaderFormValues;
  errors: HeaderFormErrors;
  pending: boolean;
  submitLabel: string;
  errorCode: ClientErrorCode | null;
  /** Version conflict on edit: somebody else changed it (or the number is taken). */
  conflict: boolean;
  onChange: (
    field: keyof HeaderFormValues,
  ) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel?: () => void;
  onReload?: () => void;
}

export function HeaderFormView({
  idPrefix,
  values,
  errors,
  pending,
  submitLabel,
  errorCode,
  conflict,
  onChange,
  onSubmit,
  onCancel,
  onReload,
}: HeaderFormViewProps) {
  const { t } = useI18n();
  const err = (field: keyof HeaderFormValues) => {
    const key = errors[field];
    return key ? t(key) : undefined;
  };
  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {conflict ? (
        <Notice kind="warning">
          <p>{t('workOrders.conflictOnUpdate')}</p>
          {onReload ? (
            <Button variant="outline" className="mt-2" onClick={onReload}>
              {t('workOrders.reload')}
            </Button>
          ) : null}
        </Notice>
      ) : errorCode ? (
        <ErrorNotice code={errorCode} />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          id={`${idPrefix}-number`}
          dir="ltr"
          label={t('workOrders.number')}
          required
          aria-required="true"
          value={values.number}
          onChange={onChange('number')}
          error={err('number')}
        />
        <Input
          id={`${idPrefix}-issuedOn`}
          type="date"
          dir="ltr"
          label={t('workOrders.issuedOn')}
          value={values.issuedOn}
          onChange={onChange('issuedOn')}
          error={err('issuedOn')}
        />
      </div>
      <Input
        id={`${idPrefix}-title`}
        label={t('workOrders.title')}
        value={values.title}
        onChange={onChange('title')}
        error={err('title')}
      />
      <Textarea
        id={`${idPrefix}-notes`}
        label={t('workOrders.notes')}
        rows={3}
        value={values.notes}
        onChange={onChange('notes')}
        error={err('notes')}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? t('common.saving') : submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
