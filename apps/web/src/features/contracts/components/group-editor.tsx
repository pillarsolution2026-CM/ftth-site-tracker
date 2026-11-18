'use client';

import { useEffect, useRef, type FormEvent } from 'react';
import { GROUP_NAME_MAX, type ContractItem } from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { GroupFormErrors, GroupFormValues } from '../model/contract-forms';

export interface GroupEditorProps {
  item: ContractItem;
  values: GroupFormValues;
  errors: GroupFormErrors;
  pending: boolean;
  errorKey: MessageKey | null;
  mains: readonly string[];
  subs: readonly string[];
  onChange: (field: keyof GroupFormValues, value: string) => void;
  onSave: () => void;
  onReset: () => void;
  onCancel: () => void;
  onReload: () => void;
}

/** Presentational: set the main and sub group of one priced line (admin, ADR-048). */
export function GroupEditor({
  item,
  values,
  errors,
  pending,
  errorKey,
  mains,
  subs,
  onChange,
  onSave,
  onReset,
  onCancel,
  onReload,
}: GroupEditorProps) {
  const { t } = useI18n();
  const mainRef = useRef<HTMLDivElement>(null);
  // Focus moves into the dialog when it opens, like the other inline dialogs.
  useEffect(() => {
    mainRef.current?.querySelector('input')?.focus();
  }, [item.id]);
  const title = t('admin.contracts.groups.editTitle', { code: item.code });
  const manual = item.group?.source === 'manual';
  const stale = errorKey === 'admin.contracts.reasons.STALE_VERSION';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave();
  };
  const message = (key: MessageKey | undefined) => (key ? t(key) : undefined);
  return (
    <form
      role="dialog"
      aria-modal="false"
      aria-labelledby="group-editor-title"
      noValidate
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
      className="mb-4 flex flex-col gap-4 rounded-lg border-2 border-(--color-brand) p-4"
    >
      <h3 id="group-editor-title" className="text-lg font-semibold">
        {title}
      </h3>
      <p className="text-sm">
        <Ltr>{item.code}</Ltr> {item.description}
      </p>
      {errorKey ? (
        <Notice kind="error">
          {t(errorKey)}
          {stale ? (
            <Button variant="outline" className="ms-3" onClick={onReload}>
              {t('admin.contracts.reload')}
            </Button>
          ) : null}
        </Notice>
      ) : null}
      <div ref={mainRef}>
        <Input
          id="group-main"
          label={t('admin.contracts.groups.main')}
          list="group-main-options"
          maxLength={GROUP_NAME_MAX}
          required
          value={values.main}
          error={message(errors.main)}
          onChange={(event) => onChange('main', event.target.value)}
        />
        <datalist id="group-main-options">
          {mains.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </div>
      <div>
        <Input
          id="group-sub"
          label={`${t('admin.contracts.groups.sub')} (${t('admin.contracts.groups.subHint')})`}
          list="group-sub-options"
          maxLength={GROUP_NAME_MAX}
          value={values.sub}
          error={message(errors.sub)}
          onChange={(event) => onChange('sub', event.target.value)}
        />
        <datalist id="group-sub-options">
          {subs.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? t('common.saving') : t('admin.contracts.groups.save')}
        </Button>
        {manual ? (
          <Button variant="outline" disabled={pending} onClick={onReset}>
            {t('admin.contracts.groups.reset')}
          </Button>
        ) : null}
        <Button variant="outline" onClick={onCancel}>
          {t('admin.contracts.groups.cancel')}
        </Button>
      </div>
    </form>
  );
}
