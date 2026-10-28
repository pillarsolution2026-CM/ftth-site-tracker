'use client';

import Link from 'next/link';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { PageHeader } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useDiffView } from '../hooks/use-diff-view';
import { useRevisionDetail } from '../hooks/use-revision-detail';
import { useTextReview } from '../hooks/use-text-review';
import { isBuilding } from '../model/revision-status';
import { DiffSection } from './diff-section';
import { PublishDialog } from './publish-dialog';
import { RevisionStatusBadge } from './revision-status-badge';
import { RevisionSummary } from './revision-summary';
import { TextReviewView } from './text-review';

export function DesignRevisionDetailScreen({
  projectId,
  revisionId,
  listPath,
}: {
  projectId: string;
  revisionId: string;
  listPath: string;
}) {
  const { t } = useI18n();
  const state = useRevisionDetail(projectId, revisionId);
  const review = useTextReview(projectId, revisionId, state.canRead && state.built);
  const diff = useDiffView(projectId, revisionId, state.canRead && state.built);

  if (!state.canRead) return <ErrorNotice code="FORBIDDEN" />;
  if (state.loadErrorCode) return <ErrorNotice code={state.loadErrorCode} />;
  const revision = state.revision;
  if (!revision) return <p role="status">{t('common.loading')}</p>;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader className="mb-0">
        <h1 className="text-xl font-semibold">
          {t('design.detailTitle')}{' '}
          {revision.revNo !== null ? <Ltr>#{revision.revNo}</Ltr> : t('design.draftLabel')}
        </h1>
        <Link
          href={listPath}
          className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
        >
          {t('design.backToList')}
        </Link>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-3">
        <RevisionStatusBadge status={revision.status} />
        {isBuilding(revision.status) ? (
          <span aria-live="polite">{t('design.autoRefresh')}</span>
        ) : null}
        {state.canPublish ? (
          <Button
            onClick={state.startPublish}
            disabled={state.publishing || state.blocked !== null}
          >
            {state.publishing && !state.blocked
              ? t('design.actions.publishing')
              : t('design.actions.publish')}
          </Button>
        ) : null}
        {state.canDiscard ? (
          <Button
            variant="outline"
            onClick={state.askDiscard}
            disabled={state.discarding || state.confirmingDiscard}
          >
            {state.discarding ? t('design.actions.discarding') : t('design.actions.discard')}
          </Button>
        ) : null}
      </div>
      {state.actionErrorKey ? <Notice kind="error">{t(state.actionErrorKey)}</Notice> : null}
      {state.blocked ? (
        <PublishDialog
          blocked={state.blocked}
          acknowledged={state.acknowledged}
          publishing={state.publishing}
          onAcknowledgedChange={state.setAcknowledged}
          onConfirm={state.confirmPublish}
          onCancel={state.cancelPublish}
        />
      ) : null}
      {state.confirmingDiscard ? (
        <div
          role="alertdialog"
          aria-labelledby="discard-title"
          aria-describedby="discard-text"
          className="flex flex-col gap-3 rounded-md border-2 border-(--status-rejected) p-4"
        >
          <h2 id="discard-title" className="text-lg font-semibold">
            <span aria-hidden="true">⚠ </span>
            {t('design.actions.discardTitle')}
          </h2>
          <p id="discard-text">{t('design.actions.discardText')}</p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={state.discard} disabled={state.discarding}>
              {t('design.actions.discardConfirm')}
            </Button>
            <Button variant="outline" onClick={state.cancelDiscard} disabled={state.discarding}>
              {t('design.actions.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      <Card>
        <RevisionSummary revision={revision} />
      </Card>
      {state.built ? (
        <>
          <Card>
            <TextReviewView state={review} canReview={state.canReview} />
          </Card>
          <Card>
            <DiffSection state={diff} />
          </Card>
        </>
      ) : (
        <Notice kind="info">{t('design.notBuilt')}</Notice>
      )}
    </div>
  );
}
