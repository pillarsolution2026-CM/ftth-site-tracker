'use client';

import {
  IMPORT_FIELDS,
  REQUIRED_IMPORT_FIELDS,
  type ImportField,
  type WorkOrderImportPreviewResponse,
} from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Notice } from '@/shared/ui/notice';
import { Select } from '@/shared/ui/form-controls';
import { useI18n } from '@/shared/i18n/locale-provider';
import { mappingProblems, type WizardState } from '../model/import-wizard';
import { fileIssueText } from '../model/issue-messages';

interface MappingEditorProps {
  preview: WorkOrderImportPreviewResponse;
  draft: NonNullable<WizardState['draft']>;
  draftApplied: boolean;
  reading: boolean;
  onSheet: (sheetName: string) => void;
  onHeaderRow: (row: number | null) => void;
  onMapping: (field: ImportField, column: number | null) => void;
  onReread: () => void;
}

const NONE = '';

/** Detected sheet / header row / column mapping, editable; "re-read" applies the changes. */
export function MappingEditor({
  preview,
  draft,
  draftApplied,
  reading,
  onSheet,
  onHeaderRow,
  onMapping,
  onReread,
}: MappingEditorProps) {
  const { t } = useI18n();
  const problems = mappingProblems(draft.mapping);
  return (
    <section aria-labelledby="mapping-title" className="flex flex-col gap-4">
      <h2 id="mapping-title" className="text-lg font-semibold">
        {t('import.mapping.title')}
      </h2>
      {preview.fileIssues.length > 0 ? (
        <Notice kind="error">
          <ul className="list-disc ps-5">
            {preview.fileIssues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>{fileIssueText(issue, t)}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          id="import-sheet"
          label={t('import.mapping.sheet')}
          value={draft.sheetName}
          onChange={(event) => onSheet(event.target.value)}
        >
          {preview.sheets.map((sheet) => (
            <option key={sheet.name} value={sheet.name}>
              {sheet.name}
            </option>
          ))}
        </Select>
        <Input
          id="import-header-row"
          type="number"
          min={1}
          dir="ltr"
          label={t('import.mapping.headerRow')}
          value={draft.headerRow === null ? '' : String(draft.headerRow)}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            onHeaderRow(Number.isInteger(parsed) && parsed >= 1 ? parsed : null);
          }}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {IMPORT_FIELDS.map((field) => {
          const required = REQUIRED_IMPORT_FIELDS.includes(field);
          const value = draft.mapping[field];
          const missing = required && value === null;
          const duplicated = value !== null && problems.duplicated.includes(value);
          return (
            <Select
              key={field}
              id={`map-${field}`}
              label={`${t(`import.fields.${field}`)}${required ? ' *' : ''}`}
              value={value === null ? NONE : String(value)}
              onChange={(event) =>
                onMapping(field, event.target.value === NONE ? null : Number(event.target.value))
              }
              error={
                missing
                  ? t('import.mapping.required')
                  : duplicated
                    ? t('import.mapping.usedTwice')
                    : undefined
              }
            >
              <option value={NONE}>{t('import.mapping.notMapped')}</option>
              {preview.columns.map((column) => (
                <option key={column.index} value={column.index}>
                  {column.letter} — {column.header || t('import.mapping.noHeader')}
                </option>
              ))}
            </Select>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={onReread} disabled={reading || draftApplied}>
          {reading ? t('common.loading') : t('import.mapping.reread')}
        </Button>
        {!draftApplied ? <span aria-live="polite">{t('import.mapping.unapplied')}</span> : null}
      </div>
      <p className="text-sm opacity-80">{t('import.mapping.requiredHint')}</p>
    </section>
  );
}
