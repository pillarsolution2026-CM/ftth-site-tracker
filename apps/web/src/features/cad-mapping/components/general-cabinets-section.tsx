'use client';

import { ltr } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { GeneralCabinetsState } from '../hooks/use-general-cabinets';
import { UNMATCHED_LISTS, hasUnmatched } from '../model/general-cabinets';

/**
 * «من كبائن الرئيسي» (ADR-042 part G) on a Secondary's placement panel: fetches the control points
 * from the cabinets shared with the placed General, says what it did, and lists every cabinet that
 * gave no point and every refusal reason. The points land in the panel unsaved.
 */
export function GeneralCabinetsSection({
  state,
  disabled,
  hasGeneralPoints,
}: {
  state: GeneralCabinetsState;
  disabled: boolean;
  /** Some points in the panel come from the General's cabinets. */
  hasGeneralPoints: boolean;
}) {
  const { t } = useI18n();
  const { report, applied } = state;
  const rev = report?.general.revNo != null ? ` ${ltr(`#${report.general.revNo}`)}` : '';
  return (
    <section aria-labelledby="placement-cabinets" className="flex flex-col gap-3">
      <h3 id="placement-cabinets" className="font-semibold">
        {t('mapping.placement.cabinets.title')}
      </h3>
      <p className="text-sm">{t('mapping.placement.cabinets.hint')}</p>
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || state.loading}
          onClick={state.fetch}
        >
          {state.loading
            ? t('mapping.placement.cabinets.fetching')
            : t('mapping.placement.cabinets.button')}
        </Button>
      </div>
      {state.errorKey ? <Notice kind="error">{t(state.errorKey)}</Notice> : null}
      {report ? (
        <p className="text-sm">
          {t('mapping.placement.cabinets.general', {
            state: t(`mapping.placement.cabinets.generalState.${report.general.status}`),
            rev,
          })}
        </p>
      ) : null}
      {applied && applied.added > 0 ? (
        <Notice kind="success">
          {t('mapping.placement.cabinets.applied', { count: ltr(applied.added) })}
        </Notice>
      ) : null}
      {report && report.matchedCount === 0 ? (
        <Notice kind="warning">{t('mapping.placement.cabinets.noMatch')}</Notice>
      ) : null}
      {applied && applied.dropped > 0 ? (
        <Notice kind="warning">
          {t('mapping.placement.cabinets.dropped', { count: ltr(applied.dropped) })}
        </Notice>
      ) : null}
      {report?.truncated ? (
        <Notice kind="warning">
          {t('mapping.placement.cabinets.truncated', { matched: ltr(report.matchedCount) })}
        </Notice>
      ) : null}
      {hasGeneralPoints ? (
        <p className="text-sm">{t('mapping.placement.cabinets.readOnly')}</p>
      ) : null}
      {report && hasUnmatched(report.unmatched) ? (
        <div className="flex flex-col gap-1 text-sm">
          <h4 className="font-semibold">{t('mapping.placement.cabinets.unmatchedTitle')}</h4>
          {UNMATCHED_LISTS.map((key) =>
            report.unmatched[key].length === 0 ? null : key === 'withoutDrawingPosition' ? (
              <p key={key}>
                {t('mapping.placement.cabinets.withoutDrawingPosition', {
                  names: report.unmatched[key].map(ltr).join('، '),
                })}
              </p>
            ) : (
              <p key={key}>
                {t(`mapping.placement.cabinets.${key}`)}:{' '}
                {report.unmatched[key].map((name, index) => (
                  <span key={name}>
                    {index > 0 ? '، ' : ''}
                    <Ltr>{name}</Ltr>
                  </span>
                ))}
              </p>
            ),
          )}
          {report.unmatched.listCapped ? <p>{t('mapping.placement.cabinets.listCapped')}</p> : null}
          {report.unmatched.unnamedSecondary + report.unmatched.unnamedGeneral > 0 ? (
            <p>
              {t('mapping.placement.cabinets.unnamed', {
                secondary: ltr(report.unmatched.unnamedSecondary),
                general: ltr(report.unmatched.unnamedGeneral),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
