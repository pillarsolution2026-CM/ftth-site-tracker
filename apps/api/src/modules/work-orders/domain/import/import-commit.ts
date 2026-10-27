import type {
  ImportInvalidDetails,
  ImportPreviewRow,
  WorkOrderImportCommitPayload,
} from '@ftth/shared';
import { Decimal } from '../decimal.js';
import type { NewItem } from '../work-order.js';
import { annotateDuplicateCodes, duplicateGroups, hasError } from './import-summary.js';
import type { ParsedImport } from './import-parser.js';

export type CommitSelection =
  | { ok: true; items: NewItem[]; excludedCount: number }
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
): CommitSelection {
  if (parsed.fileIssues.length > 0)
    return invalid('FILE_ISSUES', { fileIssues: parsed.fileIssues });

  const excluded = new Set(payload.excludedRowNumbers);
  // Duplicates are judged among the rows that stay, not among all rows of the sheet.
  const included = annotateDuplicateCodes(
    parsed.rows.filter((row) => !excluded.has(row.rowNumber)),
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
    items: included.map(toNewItem),
    excludedCount: parsed.rows.length - included.length,
  };
}

/** Rows without errors have every field set; the fallbacks only satisfy the type checker. */
function toNewItem(row: ImportPreviewRow): NewItem {
  return {
    code: row.code ?? '',
    description: row.description ?? '',
    unit: row.unit ?? '',
    quantity: Decimal.parse(row.quantity ?? '0'),
    unitPrice: Decimal.parse(row.unitPrice ?? '0'),
    sourceRow: row.rowNumber,
  };
}
