'use client';

import Link from 'next/link';
import type {
  BoxTypesReport,
  CabinetInOtherSite,
  InstallationReport,
  PublishCheck,
  PublishCheckKey,
  PublishDrawingReadiness,
  PublishReadiness,
  SiteCabinetsComparison,
} from '@ftth/shared';
import { ltr } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
import { Ltr } from '@/shared/ui/ltr';
import { Checkbox } from '@/shared/ui/form-controls';
import { useI18n } from '@/shared/i18n/locale-provider';
import { issueMessage } from '@/features/installation/model/installation-model';
import { BoxTypeIssueList } from '@/features/box-types/components/box-type-issues';

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
  /** Link to the revision of a drawing of the site; null makes the draft name plain text. */
  revisionHref: (revisionId: string) => string | null;
  onAcknowledgedChange: (value: boolean) => void;
  onPublish: () => void;
  /** Zoom the drawing to a route (the installation issues); omitted when there is no viewer. */
  onShowRoute?: (routeHandle: string) => void;
}

const COORDINATE_CHECKS: readonly PublishCheckKey[] = ['crs_known', 'control_point'];

const LINK =
  'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';

/**
 * The checklist shown before «نشر الموقع» (ADR-038, ADR-049 part B): every drawing of the site and
 * the checks of the whole site, each with an icon and a word (never colour alone). The button
 * stays locked until every check but the open items is done; open items only ask for the
 * acknowledgement checkbox.
 */
export function PublishChecklist({
  readiness,
  loading,
  failed,
  acknowledged,
  publishing,
  allowed,
  mappingHref,
  revisionHref,
  onAcknowledgedChange,
  onPublish,
  onShowRoute,
}: PublishChecklistProps) {
  const { t } = useI18n();
  const kind = readiness?.drawingKind ?? null;
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
      {readiness && readiness.drawings.length > 0 ? (
        <SiteDrawingsList drawings={readiness.drawings} revisionHref={revisionHref} />
      ) : null}
      {readiness ? (
        <ul className="flex flex-col gap-2">
          {readiness.checks
            .filter((check) => !(readiness.switchedOff.includes(check.key) && check.ok))
            .map((check) => (
              <CheckRow
                key={check.key}
                check={check}
                readiness={readiness}
                drawingKind={kind}
                switchedOff={readiness.switchedOff.includes(check.key)}
                onShowRoute={onShowRoute}
                mappingHref={mappingHref}
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
          {t('siteDrawings.publish.note')}
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
          {publishing ? t('siteDrawings.publish.busy') : t('siteDrawings.publish.button')}
        </Button>
      </div>
    </section>
  );
}

/** The drawings that go out together, each with its state (a draft, already published, not ready). */
function SiteDrawingsList({
  drawings,
  revisionHref,
}: {
  drawings: PublishDrawingReadiness[];
  revisionHref: (revisionId: string) => string | null;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-semibold">{t('siteDrawings.publish.drawings')}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {drawings.map((drawing) => {
          const href = drawing.draftRevisionId ? revisionHref(drawing.draftRevisionId) : null;
          return (
            <li
              key={drawing.drawingId}
              data-state={drawing.state}
              className="flex flex-wrap items-center gap-2"
            >
              <span aria-hidden="true">
                {drawing.state === 'not_ready' ? '❌' : drawing.state === 'draft' ? '✎' : '✓'}
              </span>
              <span className="font-semibold">
                {drawing.drawingKind === 'general'
                  ? t('siteDrawings.label.general')
                  : t('siteDrawings.label.secondary', { n: ltr(drawing.ordinal) })}
              </span>
              <span>{t(`siteDrawings.publish.drawingState.${drawing.state}`)}</span>
              {href ? (
                <Link href={href} className={LINK}>
                  {t('siteDrawings.publish.openDraft')}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function NameList({ names }: { names: readonly string[] }) {
  return (
    <>
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 ? '، ' : ''}
          <Ltr>{name}</Ltr>
        </span>
      ))}
    </>
  );
}

/** The General against the Secondaries of the site: which names are where (ADR-049 part B). */
function CabinetsDetail({ cabinets }: { cabinets: SiteCabinetsComparison }) {
  const { t } = useI18n();
  const secondaryCount = cabinets.secondaries.reduce((sum, s) => sum + s.side.count, 0);
  const unnamed =
    cabinets.general.unnamed + cabinets.secondaries.reduce((sum, s) => sum + s.side.unnamed, 0);
  const rows = [
    ['onlyGeneral', cabinets.missingInSecondaries],
    ['onlySecondary', cabinets.missingInGeneral],
    ['inSeveral', cabinets.inSeveralSecondaries],
  ] as const;
  return (
    <div className="ms-7 flex w-full flex-col gap-1 text-sm">
      <p>
        {t('siteDrawings.cabinets.counts', {
          general: ltr(cabinets.general.count),
          secondary: ltr(secondaryCount),
        })}
      </p>
      {cabinets.secondaries.length > 1 ? (
        <ul className="list-inside list-disc">
          {cabinets.secondaries.map((s) => (
            <li key={s.drawingId}>
              {t('siteDrawings.cabinets.perSecondary', {
                drawing: t('siteDrawings.label.secondary', { n: ltr(s.ordinal) }),
                count: ltr(s.side.count),
              })}
            </li>
          ))}
        </ul>
      ) : null}
      {rows.map(([key, names]) =>
        names.length > 0 ? (
          <p key={key}>
            {t(`siteDrawings.cabinets.${key}`)}: <NameList names={names} />
          </p>
        ) : null,
      )}
      {unnamed > 0 ? <p>{t('siteDrawings.cabinets.unnamed', { count: ltr(unnamed) })}</p> : null}
    </div>
  );
}

/** Cabinet names that another site of the work order already has (owner rule). */
function OtherSiteDetail({ cabinets }: { cabinets: CabinetInOtherSite[] }) {
  const { t } = useI18n();
  return (
    <div className="ms-7 flex w-full flex-col gap-1 text-sm">
      <p>{t('siteDrawings.cabinets.otherSiteTitle')}:</p>
      <ul className="list-inside list-disc">
        {cabinets.map((cabinet) => (
          <li key={`${cabinet.name}-${cabinet.otherSiteId}`}>
            {t('siteDrawings.cabinets.otherSite', {
              name: ltr(cabinet.name),
              site: cabinet.otherSiteName,
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The installation issues of the General, each with the route it is about (ADR-042 part D). */
function InstallationDetail({
  report,
  onShowRoute,
}: {
  report: InstallationReport;
  onShowRoute: ((routeHandle: string) => void) | undefined;
}) {
  const { t } = useI18n();
  return (
    <ul className="ms-7 flex w-full flex-col gap-1 text-sm">
      {report.issues.map((issue, index) => {
        const message = issueMessage(issue);
        return (
          <li
            key={`${issue.code}-${issue.routeHandle ?? ''}-${index}`}
            className="flex flex-wrap items-center gap-2"
          >
            <span aria-hidden="true">⚠</span>
            <span>{t(message.key, message.params)}</span>
            {issue.routeHandle !== null && onShowRoute ? (
              <Button variant="outline" onClick={() => onShowRoute(issue.routeHandle as string)}>
                {t('design.viewer.showOnDrawing')}
              </Button>
            ) : null}
          </li>
        );
      })}
      {report.issueCount > report.issues.length ? (
        <li>
          …{' '}
          {t('design.installation.moreIssues', {
            count: ltr(report.issueCount - report.issues.length),
          })}
        </li>
      ) : null}
    </ul>
  );
}

function CheckRow({
  check,
  readiness,
  drawingKind,
  switchedOff,
  onShowRoute,
  mappingHref,
}: {
  check: PublishCheck;
  readiness: PublishReadiness;
  drawingKind: PublishReadiness['drawingKind'];
  switchedOff: boolean;
  onShowRoute: ((routeHandle: string) => void) | undefined;
  mappingHref: string | null;
}) {
  const { t } = useI18n();
  const label = t(`design.publish.checks.${check.key}`, {
    count: check.count === null ? '' : ltr(check.count),
  });
  const installation: InstallationReport | null =
    readiness.drawings.find((d) => d.installation && !d.installation.ok)?.installation ?? null;
  const boxTypes: BoxTypesReport | null =
    readiness.drawings.find((d) => d.boxTypes && !d.boxTypes.ok)?.boxTypes ?? null;
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span aria-hidden="true">{check.ok ? '✅' : '❌'}</span>
      <span>{label}</span>
      <span className="text-sm opacity-80">
        ({check.ok ? t('design.publish.done') : t('design.publish.notDone')})
      </span>
      {!check.ok && mappingHref && COORDINATE_CHECKS.includes(check.key) ? (
        <Link href={mappingHref} className={LINK}>
          {t('design.publish.fixCoordinates')}
        </Link>
      ) : null}
      {check.key === 'installation' && drawingKind === 'secondary' && !switchedOff ? (
        <span className="text-sm">{t('design.installation.secondaryOk')}</span>
      ) : null}
      {check.key === 'installation' && !check.ok && installation ? (
        <InstallationDetail report={installation} onShowRoute={onShowRoute} />
      ) : null}
      {check.key === 'box_types' && drawingKind === 'general' && !switchedOff ? (
        <span className="text-sm">{t('design.boxTypes.generalOk')}</span>
      ) : null}
      {check.key === 'box_types' && !check.ok && boxTypes ? (
        <div className="ms-7 w-full">
          <BoxTypeIssueList
            issues={boxTypes.issues}
            issueCount={boxTypes.issueCount}
            gallery={boxTypes.gallery}
            onShowHandle={onShowRoute}
          />
        </div>
      ) : null}
      {check.key === 'cabinets_match' && !check.ok && readiness.cabinets ? (
        <CabinetsDetail cabinets={readiness.cabinets} />
      ) : null}
      {check.key === 'cabinets_other_site' &&
      !check.ok &&
      readiness.cabinetsInOtherSites.length > 0 ? (
        <OtherSiteDetail cabinets={readiness.cabinetsInOtherSites} />
      ) : null}
    </li>
  );
}
