'use client';

import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/form-controls';
import { useI18n } from '@/shared/i18n/locale-provider';

interface RejectDialogProps {
  reason: string;
  reasonMissing: boolean;
  rejecting: boolean;
  onReasonChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A rejection needs a reason the supervisor will read; an empty one is refused here. */
export function RejectDialog({
  reason,
  reasonMissing,
  rejecting,
  onReasonChange,
  onConfirm,
  onCancel,
}: RejectDialogProps) {
  const { t } = useI18n();
  return (
    <div
      role="alertdialog"
      aria-labelledby="asbuilt-reject-title"
      aria-describedby="asbuilt-reject-text"
      className="flex flex-col gap-3 rounded-md border-2 border-(--status-rejected) p-4"
    >
      <h2 id="asbuilt-reject-title" className="text-lg font-semibold">
        <span aria-hidden="true">✕ </span>
        {t('asbuiltReview.rejectDialog.title')}
      </h2>
      <p id="asbuilt-reject-text">{t('asbuiltReview.rejectDialog.text')}</p>
      <Textarea
        id="asbuilt-reject-reason"
        label={t('asbuiltReview.rejectDialog.reason')}
        rows={3}
        required
        maxLength={2000}
        value={reason}
        error={reasonMissing ? t('asbuiltReview.rejectDialog.reasonRequired') : undefined}
        onChange={(event) => onReasonChange(event.target.value)}
      />
      <div className="flex flex-wrap gap-3">
        <Button onClick={onConfirm} disabled={rejecting}>
          {rejecting
            ? t('asbuiltReview.actions.rejecting')
            : t('asbuiltReview.rejectDialog.confirm')}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={rejecting}>
          {t('asbuiltReview.actions.cancel')}
        </Button>
      </div>
    </div>
  );
}
