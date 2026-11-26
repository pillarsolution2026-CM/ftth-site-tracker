'use client';

import type { ExecutionUpdate } from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';
import { updateElementLabelKey } from '../model/update-display';

/** Element type of an update; «التخطيط» when it was recorded on the drawing (no element). */
export function UpdateElement({
  update,
}: {
  update: Pick<ExecutionUpdate, 'featureId' | 'featureType'>;
}) {
  const { t } = useI18n();
  return <span>{t(updateElementLabelKey(update))}</span>;
}
