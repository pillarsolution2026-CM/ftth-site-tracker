'use client';

import type { MessageKey } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';

interface ApproveDialogProps {
  pending: boolean;
  errorKey: MessageKey | null;
  /** Codes of the lines without a group (CONTRACT_ITEMS_UNGROUPED). */
  ungroupedCodes?: readonly string[];
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmation before the irreversible approval; it says what gets locked. */
export function ApproveDialog({
  pending,
  errorKey,
  ungroupedCodes = [],
  onConfirm,
  onCancel,
}: ApproveDialogProps) {
  const { t } = useI18n();
  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="approve-title"
      aria-describedby="approve-explain"
      className="mb-4 flex flex-col gap-3 rounded-lg border-2 border-(--status-inProgress) p-4"
    >
      <h3 id="approve-title" className="text-lg font-semibold">
        {t('admin.contracts.approve.title')}
      </h3>
      <p id="approve-explain">{t('admin.contracts.approve.explain')}</p>
      {errorKey ? (
        <Notice kind="error">
          <p>{t(errorKey)}</p>
          {ungroupedCodes.length > 0 ? (
            <p className="mt-1">
              {t('admin.contracts.groups.approveCodes')}{' '}
              {ungroupedCodes.map((code, index) => (
                <span key={code}>
                  {index > 0 ? '، ' : null}
                  <Ltr>{code}</Ltr>
                </span>
              ))}
            </p>
          ) : null}
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onConfirm} disabled={pending}>
          {pending ? t('common.saving') : t('admin.contracts.approve.confirm')}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {t('admin.contracts.approve.cancel')}
        </Button>
      </div>
    </div>
  );
}
