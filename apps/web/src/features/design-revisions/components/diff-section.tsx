'use client';

import { DIFF_CHANGES } from '@ftth/shared';
import { Checkbox, Select } from '@/shared/ui/form-controls';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Pagination } from '@/shared/ui/pagination';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { useDiffView } from '../hooks/use-diff-view';
import type { DiffFilter } from '../model/diff-view';

export type DiffViewState = ReturnType<typeof useDiffView>;

export function DiffSection({ state }: { state: DiffViewState }) {
  const { t } = useI18n();
  const setFilter = (patch: Partial<DiffFilter>) => state.setFilter({ ...state.filter, ...patch });
  return (
    <section aria-labelledby="diff-title" className="flex flex-col gap-3">
      <h2 id="diff-title" className="text-lg font-semibold">
        {t('design.diff.title')}
      </h2>
      <div className="flex flex-wrap items-end gap-4">
        <Select
          id="diff-change"
          label={t('design.diff.changeFilter')}
          value={state.filter.change}
          onChange={(event) => setFilter({ change: event.target.value as DiffFilter['change'] })}
        >
          <option value="all">{t('design.diff.all')}</option>
          {DIFF_CHANGES.map((change) => (
            <option key={change} value={change}>
              {t(`design.change.${change}`)}
            </option>
          ))}
        </Select>
        <Checkbox
          id="diff-changed-only"
          label={t('design.diff.changedOnly')}
          checked={state.filter.change === 'all' ? state.filter.changedOnly : false}
          disabled={state.filter.change !== 'all'}
          onChange={(event) => setFilter({ changedOnly: event.target.checked })}
        />
      </div>
      {state.errorCode ? <ErrorNotice code={state.errorCode} /> : null}
      {!state.errorCode && state.items === null ? <p role="status">{t('common.loading')}</p> : null}
      {state.items && state.items.length === 0 ? <p>{t('design.diff.none')}</p> : null}
      {state.items && state.items.length > 0 ? (
        <>
          <Table aria-label={t('design.diff.title')}>
            <thead>
              <tr>
                <Th>{t('design.diff.change')}</Th>
                <Th>{t('design.diff.type')}</Th>
                <Th>{t('design.diff.code')}</Th>
                <Th>{t('design.diff.previousCode')}</Th>
                <Th>{t('design.diff.distance')}</Th>
                <Th>{t('design.diff.lengthDelta')}</Th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((item) => (
                <tr key={item.id}>
                  <Td>
                    <span className="inline-flex items-center gap-1">
                      <span aria-hidden="true">{item.change === 'conflict' ? '▲' : '•'}</span>
                      {t(`design.change.${item.change}`)}
                    </span>
                  </Td>
                  <Td>{t(`featureType.${item.featureType}`)}</Td>
                  <Td>
                    <Ltr>{item.code ?? '—'}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{item.previousCode ?? '—'}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{item.distanceM ?? '—'}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{item.lengthDeltaM ?? '—'}</Ltr>
                  </Td>
                </tr>
              ))}
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
    </section>
  );
}
