'use client';

import Link from 'next/link';
import type {
  CabinetsComparison,
  PublishCheck,
  PublishCheckKey,
  PublishReadiness,
} from '@ftth/shared';
import { ltr } from '@ftth/i18n';
import { otherDrawingKind, type DrawingKind } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Ltr } from '@/shared/ui/ltr';
import { Checkbox } from '@/shared/ui/form-controls';
import { useI18n } from '@/shared/i18n/locale-provider';

interface PublishChecklistProps {
  readiness: PublishReadiness | null;
  loading: boolean;
  failed: boolean;
  acknowledged: boolean;
  publishing: boolean;
  /** The Publish button is enabled (every blocking check ok, acknowledgement given if needed). */
  allowed: boolean;
  /** Where the CAD file's coordinate mapping (placement panel) lives; null when unknown. */
  mappingHref: string | null;
  /** The other drawing's open draft (published together with this one); null when there is none. */
  otherRevisionHref: string | null;
  onAcknowledgedChange: (value: boolean) => void;
  onPublish: () => void;
}

const COORDINATE_CHECKS: readonly PublishCheckKey[] = ['crs_known', 'control_point'];

/**
 * The checklist shown before «Publish» (ADR-038): four checks, each with an icon and a word
 * (never colour alone). The button stays locked until the first three are done; open items only
 * ask for the acknowledgement checkbox.
 */
export function PublishChecklist({
  readiness,
  loading,
  failed,
  acknowledged,
  publishing,
  allowed,
  mappingHref,
  otherRevisionHref,
  onAcknowledgedChange,
  onPublish,
}: PublishChecklistProps) {
  const { t } = useI18n();
  return (
    <section
      aria-labelledby="publish-checklist-title"
      className="flex flex-col gap-3 rounded-md border border-(--color-border) p-4"
    >
      <h2 id="publish-checklist-title" className="text-lg font-semibold">
        {t('design.publish.title')}
      </h2>
      {loading ? <p role="status">{t('design.publish.loading')}</p> : null}
      {failed ? <p role="alert">{t('design.publish.loadFailed')}</p> : null}
      {readiness ? (
        <ul className="flex flex-col gap-2">
          {readiness.checks.map((check) => (
            <CheckRow
              key={check.key}
              check={check}
              cabinets={readiness.cabinets}
              mappingHref={mappingHref}
              otherRevisionHref={otherRevisionHref}
              otherKind={otherDrawingKind(readiness.drawingKind)}
            />
          ))}
        </ul>
      ) : null}
      {readiness && readiness.warningCount > 0 ? (
        <p id="publish-warnings" className="text-sm">
          <span aria-hidden="true">⚠ </span>
          {t('design.publish.warnings', { count: ltr(readiness.warningCount) })}
        </p>
      ) : null}
      {readiness?.needsAcknowledgement ? (
        <>
          <p id="publish-open-items">{t('design.publish.openItemsText')}</p>
          <Checkbox
            id="publish-acknowledge"
            label={t('design.publish.acknowledge')}
            checked={acknowledged}
            onChange={(event) => onAcknowledgedChange(event.target.checked)}
          />
        </>
      ) : null}
      {readiness ? (
        <p id="publish-pair" className="text-sm font-semibold">
          {t('design.publish.pairNote', {
            first: t(`drawingKind.${readiness.drawingKind}`),
            second: t(`drawingKind.${otherDrawingKind(readiness.drawingKind)}`),
          })}
        </p>
      ) : null}
      {readiness && !readiness.canPublish ? (
        <p id="publish-locked" className="text-sm">
          {t('design.publish.lockedHint')}
        </p>
      ) : null}
      <div>
        <Button
          onClick={onPublish}
          disabled={!allowed}
          aria-describedby={readiness ? 'publish-pair' : undefined}
        >
          {publishing ? t('design.actions.publishing') : t('design.actions.publish')}
        </Button>
      </div>
    </section>
  );
}

/** Cabinet names that exist in one drawing only, so the PM sees which one to fix (ADR-041). */
function CabinetsDetail({ cabinets }: { cabinets: CabinetsComparison }) {
  const { t } = useI18n();
  const rows = [['general', cabinets.general] as const, ['secondary', cabinets.secondary] as const];
  return (
    <div className="ms-7 flex w-full flex-col gap-1 text-sm">
      <p>
        {t('design.publish.cabinetsCounts', {
          general: ltr(cabinets.general.count),
          secondary: ltr(cabinets.secondary.count),
        })}
      </p>
      {rows.map(([kind, side]) =>
        side.missingInOther.length > 0 ? (
          <p key={kind}>
            {t(`design.publish.cabinetsOnly.${kind}`)}:{' '}
            {side.missingInOther.map((name, index) => (
              <span key={name}>
                {index > 0 ? '، ' : ''}
                <Ltr>{name}</Ltr>
              </span>
            ))}
          </p>
        ) : null,
      )}
      {cabinets.general.unnamed + cabinets.secondary.unnamed > 0 ? (
        <p>
          {t('design.publish.cabinetsUnnamed', {
            count: ltr(cabinets.general.unnamed + cabinets.secondary.unnamed),
          })}
        </p>
      ) : null}
    </div>
  );
}

function CheckRow({
  check,
  cabinets,
  mappingHref,
  otherRevisionHref,
  otherKind,
}: {
  check: PublishCheck;
  cabinets: CabinetsComparison | null;
  mappingHref: string | null;
  otherRevisionHref: string | null;
  otherKind: DrawingKind;
}) {
  const { t } = useI18n();
  const drawing = t(`drawingKind.${otherKind}`);
  const isOther = check.key === 'other_drawing';
  const label = t(`design.publish.checks.${check.key}`, {
    count: check.count === null ? '' : ltr(check.count),
    drawing,
  });
  // The other drawing: say why it is not ready (no draft yet, or N errors left in it).
  const otherReason =
    isOther && !check.ok
      ? check.count === null
        ? t('design.publish.otherNoDraft', { drawing })
        : t('design.publish.otherErrors', { count: ltr(check.count) })
      : null;
  const linkClass =
    'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span aria-hidden="true">{check.ok ? '✅' : '❌'}</span>
      <span>{label}</span>
      <span className="text-sm opacity-80">
        ({check.ok ? t('design.publish.done') : t('design.publish.notDone')})
      </span>
      {otherReason ? <span className="text-sm">{otherReason}</span> : null}
      {!check.ok && mappingHref && COORDINATE_CHECKS.includes(check.key) ? (
        <Link href={mappingHref} className={linkClass}>
          {t('design.publish.fixCoordinates')}
        </Link>
      ) : null}
      {isOther && otherRevisionHref ? (
        <Link href={otherRevisionHref} className={linkClass}>
          {t('design.publish.openOther', { drawing })}
        </Link>
      ) : null}
      {check.key === 'cabinets_match' && !check.ok ? (
        cabinets ? (
          <CabinetsDetail cabinets={cabinets} />
        ) : (
          <span className="text-sm">{t('design.publish.cabinetsNoOther', { drawing })}</span>
        )
      ) : null}
    </li>
  );
}
