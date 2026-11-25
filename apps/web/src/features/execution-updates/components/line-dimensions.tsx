'use client';

import type { LineDimensions as Dimensions } from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { useI18n } from '@/shared/i18n/locale-provider';
import { dimensionsText } from '../model/update-display';

/** «L × W × D = qty م3» of a dimensioned line; numbers stay left-to-right. Nothing when null. */
export function LineDimensionsText({
  dimensions,
  quantity,
}: {
  dimensions: Dimensions | null;
  quantity: string;
}) {
  const { t } = useI18n();
  if (dimensions === null) return null;
  return (
    <span title={t('qc.dimensions')}>
      <Ltr>{`${dimensionsText(dimensions)} = ${quantity}`}</Ltr> {t('qc.cubicUnit')}
    </span>
  );
}
