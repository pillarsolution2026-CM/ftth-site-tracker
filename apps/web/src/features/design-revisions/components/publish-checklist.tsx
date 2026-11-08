'use client';

import Link from 'next/link';
import type { PublishCheck, PublishCheckKey, PublishReadiness } from '@ftth/shared';
import { ltr } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
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
            <CheckRow key={check.key} check={check} mappingHref={mappingHref} />
          ))}
        </ul>
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
      {readiness && !readiness.canPublish ? (
        <p id="publish-locked" className="text-sm">
          {t('design.publish.lockedHint')}
        </p>
      ) : null}
      <div>
        <Button onClick={onPublish} disabled={!allowed}>
          {publishing ? t('design.actions.publishing') : t('design.actions.publish')}
        </Button>
      </div>
    </section>
  );
}

function CheckRow({ check, mappingHref }: { check: PublishCheck; mappingHref: string | null }) {
  const { t } = useI18n();
  const label = t(`design.publish.checks.${check.key}`, {
    count: check.count === null ? '' : ltr(check.count),
  });
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span aria-hidden="true">{check.ok ? '✅' : '❌'}</span>
      <span>{label}</span>
      <span className="text-sm opacity-80">
        ({check.ok ? t('design.publish.done') : t('design.publish.notDone')})
      </span>
      {!check.ok && mappingHref && COORDINATE_CHECKS.includes(check.key) ? (
        <Link
          href={mappingHref}
          className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
        >
          {t('design.publish.fixCoordinates')}
        </Link>
      ) : null}
    </li>
  );
}
