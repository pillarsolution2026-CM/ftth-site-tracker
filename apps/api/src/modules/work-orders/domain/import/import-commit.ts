import type {
  ImportInvalidDetails,
  ImportPreviewRow,
  WorkOrderImportCommitPayload,
} from '@ftth/shared';
import { Decimal } from '../decimal.js';
import type { NewItem } from '../work-order.js';
import { annotateDuplicateCodes, duplicateGroups, hasError } from './import-summary.js';
import type { ParsedImport } from './import-parser.js';

/** A row chosen for the commit: a priced item or (contract import only) a section heading. */
export type CommitLine =
  | ({ kind: 'item' } & NewItem)
  | { kind: 'heading'; code: string; description: string | null; sourceRow: number };

export type CommitSelection =
  | { ok: true; lines: CommitLine[]; excludedCount: number; headingCount: number }
  | { ok: false; details: ImportInvalidDetails };

const invalid = (
  reason: ImportInvalidDetails['reason'],
  extra: Partial<Omit<ImportInvalidDetails, 'reason'>> = {},
): CommitSelection => ({
  ok: false,
  details: { reason, fileIssues: [], rows: [], duplicateCodes: [], ...extra },
});

/**
 * Decides which rows of a freshly parsed sheet become items, or why the commit is refused.
 * Order of checks: file issues, row errors, duplicates among the included rows, nothing included.
 */
export function selectRowsForCommit(
  parsed: ParsedImport,
  payload: Pick<WorkOrderImportCommitPayload, 'excludedRowNumbers' | 'acceptedDuplicateCodes'>,
  /** `skip` (work orders): heading rows are never stored. `keep` (contracts): stored as headings. */
  headings: 'skip' | 'keep' = 'skip',
): CommitSelection {
  if (parsed.fileIssues.length > 0)
    return invalid('FILE_ISSUES', { fileIssues: parsed.fileIssues });

  const excluded = new Set(payload.excludedRowNumbers);
  // Duplicates are judged among the rows that stay, not among all rows of the sheet.
  const included = annotateDuplicateCodes(
    parsed.rows.filter(
      (row) => !excluded.has(row.rowNumber) && (headings === 'keep' || row.kind === 'item'),
    ),
  );

  const withErrors = included.filter(hasError);
  if (withErrors.length > 0) {
    return invalid('ROW_ERRORS', {
      rows: withErrors.map((row) => ({
        rowNumber: row.rowNumber,
        issues: row.issues.filter((found) => found.severity === 'error'),
      })),
    });
  }

  const unresolved = duplicateGroups(included)
    .map((group) => group.code)
    .filter((code) => !payload.acceptedDuplicateCodes.includes(code));
  if (unresolved.length > 0)
    return invalid('UNRESOLVED_DUPLICATES', { duplicateCodes: unresolved });

  if (included.length === 0) return invalid('NO_ROWS_INCLUDED');
  return {
    ok: true,
    lines: included.map(toLine),
    excludedCount: parsed.rows.filter((row) => excluded.has(row.rowNumber)).length,
    headingCount: included.filter((row) => row.kind === 'heading').length,
  };
}

function toLine(row: ImportPreviewRow): CommitLine {
  if (row.kind === 'heading') {
    return {
      kind: 'heading',
      code: row.code ?? '',
      description: row.description,
      sourceRow: row.rowNumber,
    };
  }
  return { kind: 'item', ...toNewItem(row) };
}

/** Rows without errors have every field set; the fallbacks only satisfy the type checker. */
function toNewItem(row: ImportPreviewRow): NewItem {
  return {
    code: row.code ?? '',
    description: row.description ?? '',
    unit: row.unit ?? '',
    quantity: Decimal.parse(row.quantity ?? '0'),
    unitPrice: Decimal.parse(row.unitPrice ?? '0'),
    // Never defaulted: a work type is a business value (ADR-016). Rows without errors have one.
    workType:
      row.workType ??
      (() => {
        throw new Error(`Row ${row.rowNumber} has no work type`);
      })(),
    sourceRow: row.rowNumber,
  };
}
