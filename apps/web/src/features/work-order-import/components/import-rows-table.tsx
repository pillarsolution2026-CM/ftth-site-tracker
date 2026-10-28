'use client';

import type { ImportPreviewRow, ImportRowIssue } from '@ftth/shared';
import { Checkbox, Select } from '@/shared/ui/form-controls';
import { Ltr } from '@/shared/ui/ltr';
import { Pagination } from '@/shared/ui/pagination';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useRowsView } from '../hooks/use-rows-view';
import { hasErrors } from '../model/import-wizard';
import { rowIssueText } from '../model/issue-messages';
import { ROW_FILTERS, ROWS_PER_PAGE, type RowFilter } from '../model/rows-filter';

interface ImportRowsTableProps {
  rows: ImportPreviewRow[];
  excluded: ReadonlySet<number>;
  excludeErrorRows: boolean;
  onToggleRow: (rowNumber: number) => void;
  onExcludeErrorRows: (value: boolean) => void;
}

function IssueList({ issues }: { issues: ImportRowIssue[] }) {
  const { t } = useI18n();
  return (
    <ul className="m-0 list-none p-0">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className="flex items-start gap-1">
          <span aria-hidden="true">{issue.severity === 'error' ? '⚠' : '▲'}</span>
          <span>
            <span className="font-semibold">
              {issue.severity === 'error'
                ? t('import.severity.error')
                : t('import.severity.warning')}
              {': '}
            </span>
            {rowIssueText(issue, t)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ImportRowsTable({
  rows,
  excluded,
  excludeErrorRows,
  onToggleRow,
  onExcludeErrorRows,
}: ImportRowsTableProps) {
  const { t } = useI18n();
  const view = useRowsView(rows, excluded);
  return (
    <section aria-labelledby="rows-title" className="flex flex-col gap-3">
      <h2 id="rows-title" className="text-lg font-semibold">
        {t('import.rows.title')}
      </h2>
      <div className="flex flex-wrap items-end gap-4">
        <Select
          id="rows-filter"
          label={t('import.rows.filter')}
          value={view.filter}
          onChange={(event) => view.setFilter(event.target.value as RowFilter)}
        >
          {ROW_FILTERS.map((filter) => (
            <option key={filter} value={filter}>
              {t(`import.rows.filters.${filter}`)}
            </option>
          ))}
        </Select>
        <Checkbox
          id="exclude-error-rows"
          label={t('import.rows.excludeErrors')}
          checked={excludeErrorRows}
          onChange={(event) => onExcludeErrorRows(event.target.checked)}
        />
      </div>
      {view.visible.length === 0 ? (
        <p>{t('import.rows.none')}</p>
      ) : (
        <Table aria-label={t('import.rows.title')}>
          <thead>
            <tr>
              <Th>{t('import.rows.include')}</Th>
              <Th>{t('import.rows.rowNumber')}</Th>
              <Th>{t('items.code')}</Th>
              <Th>{t('items.workType')}</Th>
              <Th>{t('items.description')}</Th>
              <Th>{t('items.unit')}</Th>
              <Th>{t('items.quantity')}</Th>
              <Th>{t('items.unitPrice')}</Th>
              <Th>{t('items.amount')}</Th>
              <Th>{t('import.rows.issues')}</Th>
            </tr>
          </thead>
          <tbody>
            {view.visible.map((row) => {
              const isExcluded = excluded.has(row.rowNumber);
              return (
                <tr key={row.rowNumber} className={isExcluded ? 'opacity-60' : ''}>
                  <Td>
                    <Checkbox
                      id={`row-${row.rowNumber}`}
                      label={t('import.rows.includeRow', { row: row.rowNumber })}
                      checked={!isExcluded}
                      onChange={() => onToggleRow(row.rowNumber)}
                      className="[&>span]:sr-only"
                    />
                    {isExcluded ? (
                      <span className="text-xs">{t('import.rows.excludedBadge')}</span>
                    ) : null}
                  </Td>
                  <Td>
                    <Ltr>{row.rowNumber}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{row.raw.code ?? '—'}</Ltr>
                  </Td>
                  <Td>
                    {row.workType
                      ? t(`items.workTypes.${row.workType}`)
                      : (row.raw.workType ?? '—')}
                  </Td>
                  <Td>{row.raw.description ?? '—'}</Td>
                  {/* Units can be up to 64 characters: wrap inside a bounded column (ADR-016). */}
                  <Td className="max-w-48 min-w-24 wrap-break-word">{row.raw.unit ?? '—'}</Td>
                  <Td>
                    <Ltr>{row.raw.quantity ?? '—'}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{row.raw.unitPrice ?? '—'}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{row.amount ?? '—'}</Ltr>
                  </Td>
                  <Td className={hasErrors(row) ? 'min-w-64' : 'min-w-48'}>
                    {row.issues.length === 0 ? (
                      <span>
                        <span aria-hidden="true">✓ </span>
                        {t('import.rows.ok')}
                      </span>
                    ) : (
                      <IssueList issues={row.issues} />
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {view.filteredCount > ROWS_PER_PAGE ? (
        <Pagination
          page={view.page}
          pageSize={ROWS_PER_PAGE}
          total={view.filteredCount}
          onPageChange={view.setPage}
        />
      ) : null}
    </section>
  );
}
