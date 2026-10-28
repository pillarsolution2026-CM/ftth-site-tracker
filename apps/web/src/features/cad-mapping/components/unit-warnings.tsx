'use client';

import { ltr } from '@ftth/i18n';
import type { DrawingUnit } from '@ftth/shared';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { UnitWarning } from '../model/unit-warnings';

/** Icon + text warning box (never colour alone); nothing here blocks saving. */
export function UnitWarnings({ warnings }: { warnings: readonly UnitWarning[] }) {
  const { t } = useI18n();
  if (warnings.length === 0) return null;
  const code = (unit: DrawingUnit | null) => (unit === null ? t('mapping.crs.none') : ltr(unit));
  return (
    <Notice kind="warning">
      <p className="font-semibold">{t('mapping.warning.title')}</p>
      <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
        {warnings.map((warning) => {
          switch (warning.kind) {
            case 'conflict':
              return (
                <li key="conflict">
                  {t('mapping.warning.conflict', {
                    declared: code(warning.declared),
                    implied: code(warning.implied),
                  })}
                </li>
              );
            case 'differsDeclared':
              return (
                <li key="differsDeclared">
                  {t('mapping.warning.differsDeclared', {
                    chosen: code(warning.chosen),
                    declared: code(warning.declared),
                  })}
                </li>
              );
            case 'differsImplied':
              return (
                <li key="differsImplied">
                  {t('mapping.warning.differsImplied', {
                    chosen: code(warning.chosen),
                    implied: code(warning.implied),
                  })}
                </li>
              );
          }
        })}
      </ul>
    </Notice>
  );
}
