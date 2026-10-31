'use client';

import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { errorCodeOf } from '@/shared/api/bff-client';
import { formatDecimal } from '@/shared/lib/decimal';
import { workOrderConflictOf } from '../model/conflict';

const QUANTITY_PARAMS = [
  'contractQuantity',
  'reservedQuantity',
  'requestedQuantity',
  'availableQuantity',
];

/** A failed work-order write: the ADR-028 409 reason in words, else the generic error text. */
export function WorkOrderErrorNotice({ error, className }: { error: unknown; className?: string }) {
  const { t, locale } = useI18n();
  const conflict = workOrderConflictOf(error);
  if (!conflict)
    return <ErrorNotice code={errorCodeOf(error)} {...(className ? { className } : {})} />;
  const params = Object.fromEntries(
    Object.entries(conflict.params).map(([key, value]) => [
      key,
      QUANTITY_PARAMS.includes(key) ? formatDecimal(value, locale) : value,
    ]),
  );
  return (
    <Notice kind="error" {...(className ? { className } : {})}>
      {t(`workOrders.reasons.${conflict.reason}`, params)}
    </Notice>
  );
}
