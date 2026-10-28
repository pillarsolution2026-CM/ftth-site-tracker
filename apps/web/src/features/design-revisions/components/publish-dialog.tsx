'use client';

import type { PublishBlockedDetails } from '@ftth/shared';
import { ltr } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/form-controls';
import { useI18n } from '@/shared/i18n/locale-provider';

interface PublishDialogProps {
  blocked: PublishBlockedDetails;
  acknowledged: boolean;
  publishing: boolean;
  onAcknowledgedChange: (value: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Shown after a 409 OPEN_ITEMS: the counts, and an explicit acknowledgement before resending. */
export function PublishDialog({
  blocked,
  acknowledged,
  publishing,
  onAcknowledgedChange,
  onConfirm,
  onCancel,
}: PublishDialogProps) {
  const { t } = useI18n();
  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="publish-dialog-title"
      aria-describedby="publish-dialog-text"
      className="flex flex-col gap-3 rounded-md border-2 border-(--status-inProgress) p-4"
    >
      <h2 id="publish-dialog-title" className="text-lg font-semibold">
        <span aria-hidden="true">▲ </span>
        {t('design.publish.title')}
      </h2>
      <p id="publish-dialog-text">
        {t('design.publish.text', {
          links: ltr(blocked.textLinksToReview),
          conflicts: ltr(blocked.diffConflicts),
        })}
      </p>
      <Checkbox
        id="publish-acknowledge"
        label={t('design.publish.acknowledge')}
        checked={acknowledged}
        onChange={(event) => onAcknowledgedChange(event.target.checked)}
      />
      <div className="flex flex-wrap gap-3">
        <Button onClick={onConfirm} disabled={!acknowledged || publishing}>
          {publishing ? t('design.actions.publishing') : t('design.publish.confirm')}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={publishing}>
          {t('design.actions.cancel')}
        </Button>
      </div>
    </div>
  );
}
