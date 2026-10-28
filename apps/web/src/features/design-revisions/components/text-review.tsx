'use client';

import { ltr } from '@ftth/i18n';
import { TEXT_LINK_KINDS, TEXT_LINK_STATUSES, type FeatureType, type TextLink } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Select } from '@/shared/ui/form-controls';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Pagination } from '@/shared/ui/pagination';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { useTextReview } from '../hooks/use-text-review';
import { linkActions, linkTextOf, type ReviewFilter } from '../model/review-list';

export type TextReviewState = ReturnType<typeof useTextReview>;

function TextCell({ link }: { link: TextLink }) {
  const { t } = useI18n();
  const view = linkTextOf(link);
  if (!view.unreadable) return <Ltr className="break-all">{view.text}</Ltr>;
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1 font-medium">
        <span aria-hidden="true">?</span>
        {t('design.review.unreadable')}
      </span>
      <span className="text-xs opacity-80">
        {t('design.review.rawText')}: <Ltr className="font-mono break-all">{view.text}</Ltr>
      </span>
    </div>
  );
}

function ReassignPanel({ state }: { state: TextReviewState }) {
  const { t } = useI18n();
  const { reassign } = state;
  if (!reassign.link) return null;
  const title = t('design.review.reassignTitle', { text: ltr(linkTextOf(reassign.link).text) });
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 rounded-md border-2 border-(--color-brand) p-3"
    >
      <h3 className="font-semibold">{title}</h3>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          reassign.applySearch();
        }}
      >
        <Select
          id="reassign-type"
          label={t('design.review.featureTypeLabel')}
          value={reassign.featureType ?? ''}
          onChange={(event) => reassign.setFeatureType(event.target.value as FeatureType)}
        >
          {reassign.allowedTypes.map((type) => (
            <option key={type} value={type}>
              {t(`featureType.${type}`)}
            </option>
          ))}
        </Select>
        <Input
          id="reassign-search"
          type="search"
          dir="ltr"
          label={t('design.review.searchLabel')}
          value={reassign.searchDraft}
          onChange={(event) => reassign.setSearchDraft(event.target.value)}
        />
        <Button type="submit" variant="outline">
          {t('design.review.search')}
        </Button>
        <Button variant="outline" onClick={reassign.close}>
          {t('design.review.closeReassign')}
        </Button>
      </form>
      {reassign.errorCode ? <ErrorNotice code={reassign.errorCode} /> : null}
      {reassign.results === null ? (
        <p role="status">{t('common.loading')}</p>
      ) : reassign.results.length === 0 ? (
        <p>{t('design.review.noFeatures')}</p>
      ) : (
        <Table aria-label={t('design.review.feature')}>
          <thead>
            <tr>
              <Th>{t('design.diff.type')}</Th>
              <Th>{t('design.review.featureCode')}</Th>
              <Th>{t('design.review.featureLayer')}</Th>
              <Th>{t('design.review.featureHandle')}</Th>
              <Th>{t('design.review.featureLength')}</Th>
              <Th>
                <span className="sr-only">{t('common.actions')}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {reassign.results.map((feature) => (
              <tr key={feature.id}>
                <Td>{t(`featureType.${feature.featureType}`)}</Td>
                <Td>
                  <Ltr>{feature.code ?? '—'}</Ltr>
                </Td>
                <Td>
                  <Ltr className="break-all">{feature.layer}</Ltr>
                </Td>
                <Td>
                  <Ltr>{feature.sourceHandle}</Ltr>
                </Td>
                <Td>
                  <Ltr>{feature.lengthM ?? '—'}</Ltr>
                </Td>
                <Td>
                  <Button variant="outline" onClick={() => reassign.pick(feature.id)}>
                    {t('design.review.useFeature')}
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

/** Text review list with filters and the confirm / reject / reassign actions. */
export function TextReviewView({
  state,
  canReview,
}: {
  state: TextReviewState;
  canReview: boolean;
}) {
  const { t } = useI18n();
  const setFilter = (patch: Partial<ReviewFilter>) =>
    state.setFilter({ ...state.filter, ...patch });
  return (
    <section aria-labelledby="review-title" className="flex flex-col gap-3">
      <h2 id="review-title" className="text-lg font-semibold">
        {t('design.review.title')}
      </h2>
      <div className="flex flex-wrap items-end gap-4">
        <Select
          id="review-status"
          label={t('design.review.statusFilter')}
          value={state.filter.status}
          onChange={(event) => setFilter({ status: event.target.value as ReviewFilter['status'] })}
        >
          <option value="all">{t('design.review.all')}</option>
          {TEXT_LINK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`design.linkStatus.${status}`)}
            </option>
          ))}
        </Select>
        <Select
          id="review-kind"
          label={t('design.review.kindFilter')}
          value={state.filter.kind}
          onChange={(event) => setFilter({ kind: event.target.value as ReviewFilter['kind'] })}
        >
          <option value="all">{t('design.review.all')}</option>
          {TEXT_LINK_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`design.review.kinds.${kind}`)}
            </option>
          ))}
        </Select>
      </div>
      {state.errorKey ? <Notice kind="error">{t(state.errorKey)}</Notice> : null}
      {state.loadErrorCode ? <ErrorNotice code={state.loadErrorCode} /> : null}
      {!state.loadErrorCode && state.links === null ? (
        <p role="status">{t('common.loading')}</p>
      ) : null}
      {state.links && state.links.length === 0 ? <p>{t('design.review.none')}</p> : null}
      {state.links && state.links.length > 0 ? (
        <>
          <Table aria-label={t('design.review.title')}>
            <thead>
              <tr>
                <Th>{t('design.review.text')}</Th>
                <Th>{t('design.review.kind')}</Th>
                <Th>{t('design.review.layer')}</Th>
                <Th>{t('design.review.feature')}</Th>
                <Th>{t('design.review.distance')}</Th>
                <Th>{t('design.review.confidence')}</Th>
                <Th>{t('design.review.status')}</Th>
                {canReview ? <Th>{t('common.actions')}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {state.links.map((link) => {
                const actions = linkActions(link, canReview);
                const busy = state.pendingLinkId === link.id;
                const name = linkTextOf(link).text;
                return (
                  <tr key={link.id}>
                    <Td>
                      <TextCell link={link} />
                    </Td>
                    <Td>{t(`design.review.kinds.${link.kind}`)}</Td>
                    <Td>
                      <Ltr className="break-all">{link.layer}</Ltr>
                    </Td>
                    <Td>
                      {link.featureType ? (
                        <span>
                          {t(`featureType.${link.featureType}`)}{' '}
                          <Ltr>{link.featureCode ?? '—'}</Ltr>
                        </span>
                      ) : (
                        t('design.review.noFeature')
                      )}
                    </Td>
                    <Td>
                      <Ltr>{link.distanceM ?? '—'}</Ltr>
                    </Td>
                    <Td>
                      <Ltr>{link.confidence}</Ltr>
                    </Td>
                    <Td>{t(`design.linkStatus.${link.status}`)}</Td>
                    {canReview ? (
                      <Td>
                        <div className="flex flex-wrap gap-2">
                          {actions.confirm ? (
                            <Button
                              variant="outline"
                              disabled={busy}
                              aria-label={`${t('design.review.confirm')}: ${name}`}
                              onClick={() => state.confirm(link)}
                            >
                              {t('design.review.confirm')}
                            </Button>
                          ) : null}
                          {actions.reject ? (
                            <Button
                              variant="outline"
                              disabled={busy}
                              aria-label={`${t('design.review.reject')}: ${name}`}
                              onClick={() => state.reject(link)}
                            >
                              {t('design.review.reject')}
                            </Button>
                          ) : null}
                          {actions.reassign ? (
                            <Button
                              variant="outline"
                              disabled={busy}
                              aria-label={`${t('design.review.reassign')}: ${name}`}
                              onClick={() => state.reassign.open(link)}
                            >
                              {t('design.review.reassign')}
                            </Button>
                          ) : null}
                        </div>
                      </Td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Pagination
            page={state.page}
            pageSize={state.pageSize}
            total={state.total}
            onPageChange={state.setPage}
          />
        </>
      ) : null}
      <ReassignPanel state={state} />
    </section>
  );
}
