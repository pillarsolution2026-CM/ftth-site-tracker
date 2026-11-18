'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ltr } from '@ftth/i18n';
import type { CadFileSummary, SiteDrawing } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Ltr } from '@/shared/ui/ltr';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { Select } from '@/shared/ui/form-controls';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { SiteDrawingActions } from '../hooks/use-site-drawing-actions';
import { useDisclosure } from '../hooks/use-disclosure';
import {
  canWithdraw,
  drawingLabel,
  drawingState,
  missingKinds,
  type DrawingState,
} from '../model/site-drawings';
import { CadStatusBadge } from './cad-status-badge';

const LINK =
  'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';

const STATE_ICON: Record<DrawingState, string> = {
  not_built: '○',
  queued: '…',
  building: '⟳',
  draft: '✎',
  published: '✓',
};

interface SiteDrawingsViewProps {
  data: {
    sites: { siteId: string; name: string; drawings: SiteDrawing[] }[];
    unassigned: SiteDrawing[];
  };
  files: CadFileSummary[];
  cadFilesPath: string;
  revisionsPath: string;
  /** PM actions: link, withdraw, publish. */
  canManage: boolean;
  actions: SiteDrawingActions;
  /** The checklist and publish button of a site, shown on request. */
  renderPublish: (siteId: string) => ReactNode;
}

/** The drawings list grouped by site, then «بدون موقع» (ADR-049 part B). */
export function SiteDrawingsView({
  data,
  files,
  cadFilesPath,
  revisionsPath,
  canManage,
  actions,
  renderPublish,
}: SiteDrawingsViewProps) {
  const { t } = useI18n();
  const fileOf = (id: string | null) => files.find((file) => file.id === id) ?? null;
  const rowProps = { fileOf, cadFilesPath, revisionsPath, canManage, actions };
  return (
    <div className="flex flex-col gap-6">
      {actions.error ? (
        'key' in actions.error ? (
          <Notice kind="error">{t(actions.error.key)}</Notice>
        ) : (
          <ErrorNotice code={actions.error.code} />
        )
      ) : null}
      {data.sites.map((site) => (
        <SiteSection
          key={site.siteId}
          name={site.name}
          siteId={site.siteId}
          drawings={site.drawings}
          canManage={canManage}
          renderPublish={renderPublish}
          rowProps={rowProps}
        />
      ))}
      {data.unassigned.length > 0 ? (
        <section aria-labelledby="site-unassigned" data-site="unassigned">
          <h2 id="site-unassigned" className="mb-1 text-lg font-semibold">
            {t('siteDrawings.unassigned.title')}
          </h2>
          <p className="mb-2 text-sm">{t('siteDrawings.unassigned.hint')}</p>
          <DrawingsTable
            caption={t('siteDrawings.unassigned.title')}
            drawings={data.unassigned}
            sites={data.sites.map((s) => ({ id: s.siteId, name: s.name }))}
            unassigned
            {...rowProps}
          />
        </section>
      ) : null}
    </div>
  );
}

interface RowProps {
  fileOf: (id: string | null) => CadFileSummary | null;
  cadFilesPath: string;
  revisionsPath: string;
  canManage: boolean;
  actions: SiteDrawingActions;
}

function SiteSection({
  name,
  siteId,
  drawings,
  canManage,
  renderPublish,
  rowProps,
}: {
  name: string;
  siteId: string;
  drawings: SiteDrawing[];
  canManage: boolean;
  renderPublish: (siteId: string) => ReactNode;
  rowProps: RowProps;
}) {
  const { t } = useI18n();
  const panel = useDisclosure();
  const missing = missingKinds(drawings);
  const hasDraft = drawings.some((d) => d.openRevision?.status === 'draft');
  return (
    <section aria-labelledby={`site-${siteId}`} data-site={siteId}>
      <h2 id={`site-${siteId}`} className="mb-1 text-lg font-semibold">
        {name}
      </h2>
      {drawings.length === 0 ? <p>{t('siteDrawings.noDrawings')}</p> : null}
      {drawings.length > 0 ? (
        <DrawingsTable caption={name} drawings={drawings} sites={[]} {...rowProps} />
      ) : null}
      {missing.length > 0 && drawings.length > 0 ? (
        <p className="mt-2 text-sm">
          <span aria-hidden="true">▲ </span>
          {t('siteDrawings.missing', {
            kinds: missing.map((kind) => t(`drawingKind.${kind}`)).join('، '),
          })}
        </p>
      ) : null}
      {canManage && hasDraft ? (
        <div className="mt-2">
          <Button variant="outline" onClick={panel.toggle} aria-expanded={panel.open}>
            {panel.open ? t('siteDrawings.publish.hide') : t('siteDrawings.publish.show')}
          </Button>
          {panel.open ? renderPublish(siteId) : null}
        </div>
      ) : null}
    </section>
  );
}

function DrawingsTable({
  caption,
  drawings,
  sites,
  unassigned = false,
  fileOf,
  cadFilesPath,
  revisionsPath,
  canManage,
  actions,
}: RowProps & {
  caption: string;
  drawings: SiteDrawing[];
  /** The sites an unassigned drawing can be linked to. */
  sites: { id: string; name: string }[];
  unassigned?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Table aria-label={caption}>
      <thead>
        <tr>
          <Th>{t('siteDrawings.title')}</Th>
          <Th>{t('siteDrawings.file')}</Th>
          <Th>{t('cad.statusLabel')}</Th>
          <Th>
            <span className="sr-only">{t('common.actions')}</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {drawings.map((drawing) => {
          const label = drawingLabel(drawing);
          const file = fileOf(drawing.currentFileId);
          const state = drawingState(drawing);
          const revision = drawing.openRevision ?? drawing.latestPublished;
          const confirming = actions.confirmingId === drawing.id;
          return (
            <tr key={drawing.id} data-drawing={drawing.id}>
              <Td>
                <span className="font-semibold">
                  {t(label.key, { n: ltr(label.ordinal ?? 1) })}
                </span>
              </Td>
              <Td>
                {drawing.currentFileId && drawing.currentFileName ? (
                  <Link href={`${cadFilesPath}/${drawing.currentFileId}`} className={LINK}>
                    <Ltr className="break-all">{drawing.currentFileName}</Ltr>
                  </Link>
                ) : (
                  '—'
                )}
              </Td>
              <Td>
                <div className="flex flex-col gap-1">
                  {file ? <CadStatusBadge status={file.status} /> : null}
                  <span data-state={state} className="inline-flex items-center gap-1">
                    <span aria-hidden="true">{STATE_ICON[state]}</span>
                    {t(`siteDrawings.state.${state}`, {
                      n: ltr(drawing.latestPublished?.revNo ?? 0),
                    })}
                  </span>
                  {revision ? (
                    <Link href={`${revisionsPath}/${revision.id}`} className={LINK}>
                      {t('siteDrawings.openRevision')}
                    </Link>
                  ) : null}
                </div>
              </Td>
              <Td>
                {canManage && unassigned ? (
                  <AssignControl drawing={drawing} sites={sites} actions={actions} />
                ) : null}
                {canManage && !unassigned && canWithdraw(drawing) && !confirming ? (
                  <Button variant="outline" onClick={() => actions.onAskWithdraw(drawing.id)}>
                    {t('siteDrawings.withdraw.button')}
                  </Button>
                ) : null}
                {confirming ? (
                  <div
                    role="alertdialog"
                    aria-labelledby={`withdraw-title-${drawing.id}`}
                    className="flex flex-col gap-2 rounded-md border-2 border-(--status-rejected) p-3"
                  >
                    <p id={`withdraw-title-${drawing.id}`} className="font-semibold">
                      <span aria-hidden="true">⚠ </span>
                      {t('siteDrawings.withdraw.title')}
                    </p>
                    <p>{t('siteDrawings.withdraw.text')}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={actions.onConfirmWithdraw} disabled={actions.withdrawing}>
                        {t('siteDrawings.withdraw.yes')}
                      </Button>
                      <Button variant="outline" onClick={actions.onCancelWithdraw}>
                        {t('siteDrawings.withdraw.no')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function AssignControl({
  drawing,
  sites,
  actions,
}: {
  drawing: SiteDrawing;
  sites: { id: string; name: string }[];
  actions: SiteDrawingActions;
}) {
  const { t } = useI18n();
  if (sites.length === 0) return <p className="text-sm">{t('siteDrawings.unassigned.noSites')}</p>;
  const picked = actions.picked[drawing.id] ?? '';
  const busy = actions.assigningId === drawing.id;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select
        id={`assign-${drawing.id}`}
        label={t('siteDrawings.unassigned.select')}
        value={picked}
        onChange={(event) => actions.onPick(drawing.id, event.target.value)}
      >
        <option value="">{t('siteDrawings.unassigned.pick')}</option>
        {sites.map((site) => (
          <option key={site.id} value={site.id}>
            {site.name}
          </option>
        ))}
      </Select>
      <Button onClick={() => actions.onAssign(drawing.id)} disabled={!picked || busy}>
        {busy ? t('siteDrawings.unassigned.assigning') : t('siteDrawings.unassigned.assign')}
      </Button>
    </div>
  );
}
