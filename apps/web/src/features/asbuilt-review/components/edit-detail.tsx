'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AsBuiltEditDetail } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { PageHeader } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDateTime } from '@/shared/lib/format';
import { useEditReview } from '../hooks/use-edit-review';
import { formatLengthDifference, formatLengthM, lengthDifference } from '../model/length';
import { APPROVE_BLOCK_KEY, FEATURE_TYPE_LABEL, KIND_LABEL } from '../model/review-model';
import { ComparisonDrawing, DrawingLegend } from './comparison-drawing';
import { EditStatusBadge } from './edit-status-badge';
import { FlagList } from './flag-list';
import { RejectDialog } from './reject-dialog';

export type EditReviewState = ReturnType<typeof useEditReview>;

const LINK_CLASS =
  'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="font-semibold sm:w-48 sm:shrink-0">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}

function Lengths({ detail }: { detail: AsBuiltEditDetail }) {
  const { t, locale } = useI18n();
  const design = detail.design?.lengthM ?? null;
  const proposed = detail.edit.lengthM;
  const difference = lengthDifference(design, proposed);
  return (
    <dl className="m-0 flex flex-col gap-2" aria-label={t('asbuiltReview.detail.lengths')}>
      <Row label={t('asbuiltReview.detail.designLength')}>
        {design !== null ? (
          <Ltr data-testid="design-length">{formatLengthM(design, locale)}</Ltr>
        ) : (
          t(detail.design ? 'asbuiltReview.detail.noLength' : 'asbuiltReview.detail.noDesign')
        )}
      </Row>
      <Row label={t('asbuiltReview.detail.proposedLength')}>
        {proposed !== null ? (
          <Ltr data-testid="proposed-length">{formatLengthM(proposed, locale)}</Ltr>
        ) : (
          t('asbuiltReview.detail.noLength')
        )}
      </Row>
      {difference ? (
        <Row label={t('asbuiltReview.detail.difference')}>
          <Ltr data-testid="length-difference">
            <span aria-hidden="true">
              {difference.direction === 'longer'
                ? '▲ '
                : difference.direction === 'shorter'
                  ? '▼ '
                  : '= '}
            </span>
            {formatLengthDifference(difference, locale)}
          </Ltr>
        </Row>
      ) : null}
    </dl>
  );
}

export function EditDetailView({
  detail,
  listPath,
  review,
}: {
  detail: AsBuiltEditDetail;
  listPath: string;
  review: EditReviewState;
}) {
  const { t, locale } = useI18n();
  const { edit } = detail;
  const blocked = review.blocked;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader className="mb-0">
        <h1 className="text-xl font-semibold">{t('asbuiltReview.detailTitle')}</h1>
        <Link href={listPath} className={LINK_CLASS}>
          {t('asbuiltReview.backToList')}
        </Link>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3">
        <EditStatusBadge status={edit.status} />
        {review.canReview ? (
          <>
            <Button
              onClick={review.approve}
              disabled={blocked !== null || review.busy}
              {...(blocked ? { 'aria-describedby': 'asbuilt-approve-why' } : {})}
            >
              {review.approving
                ? t('asbuiltReview.actions.approving')
                : t('asbuiltReview.actions.approve')}
            </Button>
            {review.canReject ? (
              <Button
                variant="outline"
                onClick={review.openReject}
                disabled={review.busy || review.dialogOpen}
              >
                {t('asbuiltReview.actions.reject')}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {blocked && (review.canReview || edit.status === 'pending') ? (
        <Notice kind="warning" live={false}>
          <span id="asbuilt-approve-why">{t(APPROVE_BLOCK_KEY[blocked])}</span>
        </Notice>
      ) : null}
      {review.actionErrorKey ? <Notice kind="error">{t(review.actionErrorKey)}</Notice> : null}
      {review.dialogOpen ? (
        <RejectDialog
          reason={review.reason}
          reasonMissing={review.reasonMissing}
          rejecting={review.rejectingNow}
          onReasonChange={review.setReason}
          onConfirm={review.confirmReject}
          onCancel={review.cancelReject}
        />
      ) : null}

      <Card>
        <dl className="m-0 flex flex-col gap-2">
          <Row label={t('asbuiltReview.detail.feature')}>
            {t(FEATURE_TYPE_LABEL[edit.featureType])}
            {detail.design?.code ? (
              <>
                {' '}
                <Ltr>{detail.design.code}</Ltr>
              </>
            ) : null}
          </Row>
          <Row label={t('asbuiltReview.detail.tool')}>{t(KIND_LABEL[edit.kind])}</Row>
          <Row label={t('asbuiltReview.detail.supervisor')}>{edit.userName}</Row>
          <Row label={t('asbuiltReview.detail.received')}>
            <Ltr>{formatDateTime(edit.receivedAt, locale)}</Ltr>
          </Row>
          <Row label={t('asbuiltReview.detail.captured')}>
            <Ltr>{formatDateTime(edit.capturedAt, locale)}</Ltr>
          </Row>
          {edit.label !== null ? (
            <Row label={t('asbuiltReview.detail.label')}>
              <bdi>{edit.label}</bdi>
            </Row>
          ) : null}
          <Row label={t('asbuiltReview.detail.note')}>
            {edit.note ? (
              <bdi className="whitespace-pre-wrap">{edit.note}</bdi>
            ) : (
              t('asbuiltReview.detail.noNote')
            )}
          </Row>
          {edit.reviewReason ? (
            <Row label={t('asbuiltReview.detail.reviewReason')}>
              <bdi className="whitespace-pre-wrap">{edit.reviewReason}</bdi>
            </Row>
          ) : null}
          {edit.reviewedAt ? (
            <Row label={t('asbuiltReview.detail.reviewedAt')}>
              <Ltr>{formatDateTime(edit.reviewedAt, locale)}</Ltr>
            </Row>
          ) : null}
          <Row label={t('asbuiltReview.detail.flags')}>
            <FlagList flags={edit.flags} explain />
          </Row>
        </dl>
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-semibold">{t('asbuiltReview.detail.lengths')}</h2>
        <Lengths detail={detail} />
      </Card>

      <Card>
        <div className="flex flex-col gap-4">
          <ComparisonDrawing
            design={detail.design?.geometry ?? null}
            current={detail.current?.geometry ?? null}
            proposed={edit.geometry}
            designCode={detail.design?.code ?? null}
            proposedLabel={edit.label}
            crsEpsg={detail.crsEpsg}
          />
          {edit.geometry === null ? <p>{t('asbuiltReview.detail.noGeometry')}</p> : null}
          <DrawingLegend />
        </div>
      </Card>
    </div>
  );
}

export function EditDetailScreen({
  projectId,
  editId,
  listPath,
}: {
  projectId: string;
  editId: string;
  listPath: string;
}) {
  const { t } = useI18n();
  const review = useEditReview(projectId, editId);
  if (!review.canRead) return <ErrorNotice code="FORBIDDEN" />;
  if (review.loadErrorCode) return <ErrorNotice code={review.loadErrorCode} />;
  if (!review.detail) return <p role="status">{t('common.loading')}</p>;
  return <EditDetailView detail={review.detail} listPath={listPath} review={review} />;
}
