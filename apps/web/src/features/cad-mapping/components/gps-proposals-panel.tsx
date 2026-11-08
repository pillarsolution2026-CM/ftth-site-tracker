'use client';

import { useState } from 'react';
import { GPS_PROPOSAL_REJECT_REASON_MAX, type GpsProposal } from '@ftth/shared';
import { ltr, type MessageKey } from '@ftth/i18n';
import type { ClientErrorCode } from '@/shared/api/bff-client';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Textarea } from '@/shared/ui/form-controls';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDateTime, formatNumber } from '@/shared/lib/format';

export interface GpsProposalsPanelProps {
  pending: readonly GpsProposal[];
  pendingLoading: boolean;
  pendingErrorCode: ClientErrorCode | null;
  history: readonly GpsProposal[];
  historyLoading: boolean;
  showHistory: boolean;
  /** The mapping version loaded; null until a mapping is saved (accepting is then impossible). */
  mappingVersion: number | null;
  busyId: string | null;
  notice: 'accepted' | 'rejected' | null;
  error: { key: MessageKey; reload: boolean } | null;
  photoUrl: (proposalId: string) => string;
  onToggleHistory: () => void;
  onAccept: (id: string) => void;
  /** Resolves true when the proposal was rejected. */
  onReject: (id: string, reason: string) => Promise<boolean>;
  onReload: () => void;
}

/** Supervisor GPS point proposals for this CAD file: accept or reject, with the history (ADR-037). */
export function GpsProposalsPanel(props: GpsProposalsPanelProps) {
  const { t } = useI18n();
  return (
    <Card aria-labelledby="proposals-title" role="region" className="flex flex-col gap-4">
      <h2 id="proposals-title" className="text-lg font-semibold">
        {t('mapping.proposals.title')}
      </h2>
      <p className="text-sm">{t('mapping.proposals.intro')}</p>

      {props.notice ? (
        <Notice kind="success">{t(`mapping.proposals.${props.notice}`)}</Notice>
      ) : null}
      {props.error ? (
        <Notice kind="error">
          <p>{t(props.error.key)}</p>
          {props.error.reload ? (
            <Button variant="outline" className="mt-2" onClick={props.onReload}>
              {t('mapping.proposals.error.reload')}
            </Button>
          ) : null}
        </Notice>
      ) : null}
      {props.mappingVersion === null ? (
        <p className="text-sm">{t('mapping.proposals.noMapping')}</p>
      ) : null}

      <section aria-labelledby="proposals-pending" className="flex flex-col gap-3">
        <h3 id="proposals-pending" className="font-semibold">
          {t('mapping.proposals.pending')}
        </h3>
        {props.pendingLoading ? (
          <p role="status">{t('mapping.proposals.loading')}</p>
        ) : props.pendingErrorCode ? (
          <Notice kind="error">{t(`errors.${props.pendingErrorCode}`)}</Notice>
        ) : props.pending.length === 0 ? (
          <p className="text-sm">{t('mapping.proposals.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {props.pending.map((proposal) => (
              <li key={proposal.id}>
                <ProposalCard proposal={proposal} {...props} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="proposals-history" className="flex flex-col gap-3">
        <h3 id="proposals-history" className="font-semibold">
          {t('mapping.proposals.historyTitle')}
        </h3>
        <div>
          <Button
            variant="outline"
            aria-expanded={props.showHistory}
            aria-controls="proposals-history-list"
            onClick={props.onToggleHistory}
          >
            {t(
              props.showHistory ? 'mapping.proposals.hideHistory' : 'mapping.proposals.showHistory',
            )}
          </Button>
        </div>
        {props.showHistory ? (
          <div id="proposals-history-list">
            {props.historyLoading ? (
              <p role="status">{t('mapping.proposals.loading')}</p>
            ) : props.history.length === 0 ? (
              <p className="text-sm">{t('mapping.proposals.historyEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {props.history.map((proposal) => (
                  <li key={proposal.id}>
                    <ProposalCard proposal={proposal} {...props} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </section>
    </Card>
  );
}

function ProposalCard({
  proposal,
  mappingVersion,
  busyId,
  photoUrl,
  onAccept,
  onReject,
}: { proposal: GpsProposal } & GpsProposalsPanelProps) {
  const { t, locale } = useI18n();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const busy = busyId === proposal.id;
  const item = `${t(`mapping.placement.itemType.${proposal.featureType}`)} ${proposal.code ?? `#${proposal.handle}`}`;

  const confirmReject = async () => {
    const trimmed = reason.trim();
    if (trimmed === '') return setReasonError(true);
    setReasonError(false);
    if (await onReject(proposal.id, trimmed)) {
      setRejecting(false);
      setReason('');
    }
  };

  return (
    <article
      aria-label={item}
      className="flex flex-col gap-2 rounded-md border border-(--color-border) p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-semibold">
          <bdi>{item}</bdi>
        </h4>
        <span className="rounded-md border border-(--color-border) px-2 text-sm">
          <span aria-hidden="true">{STATUS_ICON[proposal.status]}</span>{' '}
          {t(`mapping.proposals.status.${proposal.status}`)}
        </span>
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <Row label={t('mapping.proposals.by')}>
          <bdi>{proposal.proposedBy.name}</bdi>
        </Row>
        <Row label={t('mapping.proposals.fixAt')}>
          <Ltr>{formatDateTime(proposal.fixAt, locale)}</Ltr>
        </Row>
        <Row label={t('mapping.proposals.accuracy')}>
          <bdi>
            {t('mapping.proposals.accuracyValue', {
              value: ltr(formatNumber(proposal.accuracyM, locale, 1)),
            })}
          </bdi>
        </Row>
        <Row label={t('mapping.proposals.latlon')}>
          <Ltr>
            {proposal.lat.toFixed(7)}, {proposal.lon.toFixed(7)}
          </Ltr>
        </Row>
        {proposal.note ? (
          <Row label={t('mapping.proposals.note')}>
            <bdi>{proposal.note}</bdi>
          </Row>
        ) : null}
        {proposal.status !== 'pending' ? (
          <Row label={t('mapping.proposals.decision')}>
            {proposal.decidedBy ? (
              <bdi>{t('mapping.proposals.decidedBy', { name: proposal.decidedBy.name })}</bdi>
            ) : null}{' '}
            {proposal.decidedAt ? <Ltr>{formatDateTime(proposal.decidedAt, locale)}</Ltr> : null}
            {proposal.rejectReason ? (
              <p>
                <bdi>{t('mapping.proposals.reason', { reason: proposal.rejectReason })}</bdi>
              </p>
            ) : null}
            {proposal.acceptedMappingVersion !== null ? (
              <p>{t('mapping.proposals.version', { version: proposal.acceptedMappingVersion })}</p>
            ) : null}
          </Row>
        ) : null}
      </dl>

      {proposal.photo?.stored ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={enlarged}
            aria-label={t('mapping.proposals.photoOpen', { item })}
            onClick={() => setEnlarged((value) => !value)}
            className="min-h-11 w-fit rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
          >
            <img
              src={photoUrl(proposal.id)}
              alt={t('mapping.proposals.photo')}
              className={enlarged ? 'max-h-[70vh] max-w-full rounded-md' : 'h-24 rounded-md'}
            />
          </button>
        </div>
      ) : proposal.photo ? (
        <p className="text-sm">{t('mapping.proposals.photoUploading')}</p>
      ) : null}

      {proposal.status === 'pending' ? (
        rejecting ? (
          <div className="flex flex-col gap-2">
            <Textarea
              id={`proposal-reason-${proposal.id}`}
              label={t('mapping.proposals.reasonLabel')}
              value={reason}
              maxLength={GPS_PROPOSAL_REJECT_REASON_MAX}
              onChange={(event) => setReason(event.target.value)}
              {...(reasonError ? { error: t('mapping.proposals.reasonRequired') } : {})}
            />
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void confirmReject()}>
                {t('mapping.proposals.confirmReject')}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setRejecting(false);
                  setReasonError(false);
                }}
              >
                {t('mapping.proposals.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || busyId !== null || mappingVersion === null}
              aria-label={t('mapping.proposals.acceptFor', { item })}
              onClick={() => onAccept(proposal.id)}
            >
              {t('mapping.proposals.accept')}
            </Button>
            <Button
              variant="outline"
              disabled={busyId !== null}
              aria-label={t('mapping.proposals.rejectFor', { item })}
              onClick={() => setRejecting(true)}
            >
              {t('mapping.proposals.reject')}
            </Button>
          </div>
        )
      ) : null}
    </article>
  );
}

/** Status is never colour alone: an icon and the word. */
const STATUS_ICON = { pending: '…', accepted: '✓', rejected: '✕' } as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="opacity-80">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
