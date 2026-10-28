'use client';

import { ltr } from '@ftth/i18n';
import { DRAWING_UNITS, METRES_PER_UNIT, type CrsDetection, type DrawingUnit } from '@ftth/shared';
import { Card } from '@/shared/ui/card';
import { Input } from '@/shared/ui/input';
import { Select } from '@/shared/ui/form-controls';
import { Ltr } from '@/shared/ui/ltr';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { UnitWarning } from '../model/unit-warnings';
import { UnitWarnings } from './unit-warnings';

export interface CrsPanelProps {
  detection: CrsDetection | null;
  projectEpsg: number;
  insUnits: number | null;
  epsg: string;
  epsgError: 'required' | 'unsupported' | null;
  unit: DrawingUnit | '';
  warnings: readonly UnitWarning[];
  disabled: boolean;
  onEpsgChange: (value: string) => void;
  onUnitChange: (unit: DrawingUnit | '') => void;
}

export function CrsPanel({
  detection,
  projectEpsg,
  insUnits,
  epsg,
  epsgError,
  unit,
  warnings,
  disabled,
  onEpsgChange,
  onUnitChange,
}: CrsPanelProps) {
  const { t } = useI18n();
  const none = t('mapping.crs.none');
  const facts: [string, React.ReactNode][] = [
    [t('mapping.crs.projectEpsg'), <Ltr key="p">{projectEpsg}</Ltr>],
    [t('mapping.crs.suggestedEpsg'), <Ltr key="s">{detection?.suggestedEpsg ?? none}</Ltr>],
    [t('mapping.crs.insUnits'), <Ltr key="i">{insUnits ?? '—'}</Ltr>],
    [t('mapping.crs.declaredUnit'), <Ltr key="d">{detection?.declaredUnit ?? none}</Ltr>],
    [t('mapping.crs.impliedUnit'), <Ltr key="m">{detection?.impliedUnit ?? none}</Ltr>],
  ];
  return (
    <Card aria-labelledby="crs-title" role="region" className="flex flex-col gap-4">
      <h2 id="crs-title" className="text-lg font-semibold">
        {t('mapping.crs.title')}
      </h2>
      {detection ? (
        <div className="flex flex-col gap-1">
          <p>
            <span className="text-sm opacity-80">{t('mapping.crs.detected')}: </span>
            <span className="font-semibold">{t(`mapping.crs.kind.${detection.kind}`)}</span>
          </p>
          <p className="text-sm">{t(`mapping.crs.reason.${detection.reason}`)}</p>
        </div>
      ) : (
        <p>{t('mapping.crs.notDetected')}</p>
      )}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {facts.map(([label, value]) => (
          <div key={label} className="rounded-md border border-(--color-border) p-3">
            <dt className="text-sm opacity-80">{label}</dt>
            <dd className="font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Input
            id="mapping-epsg"
            inputMode="numeric"
            dir="ltr"
            label={t('mapping.crs.epsgLabel')}
            value={epsg}
            disabled={disabled}
            onChange={(event) => onEpsgChange(event.target.value)}
            error={
              epsgError === 'required'
                ? t('mapping.crs.epsgRequired')
                : epsgError === 'unsupported'
                  ? t('mapping.crs.epsgUnsupported')
                  : undefined
            }
          />
          <p className="mt-1 text-sm opacity-80">{t('mapping.crs.epsgHint')}</p>
        </div>
        <div>
          <Select
            id="mapping-unit"
            label={t('mapping.crs.unitLabel')}
            hint={unit === '' ? t('mapping.crs.unitRequired') : t('mapping.crs.unitHint')}
            value={unit}
            disabled={disabled}
            onChange={(event) => onUnitChange(event.target.value as DrawingUnit | '')}
          >
            <option value="">{t('mapping.crs.unitPlaceholder')}</option>
            {DRAWING_UNITS.map((value) => (
              <option key={value} value={value}>
                {t(`mapping.unit.${value}`)}
              </option>
            ))}
          </Select>
          {unit !== '' ? (
            <p className="mt-1 text-sm">
              {t('mapping.crs.factor', { factor: ltr(METRES_PER_UNIT[unit]) })}
            </p>
          ) : null}
        </div>
      </div>
      <UnitWarnings warnings={warnings} />
    </Card>
  );
}
