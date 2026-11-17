import type {
  ImportInvalidDetails,
  ImportPreviewRow,
  WorkOrderImportCommitPayload,
} from '@ftth/shared';
import { Decimal } from '../decimal.js';
import type { ItemValues } from '../work-order.js';
import { annotateDuplicateCodes, duplicateGroups, hasError } from './import-summary.js';
import type { ParsedImport } from './import-parser.js';

/** An item row as parsed from the sheet (not yet linked to a contract item). */
export interface ParsedItem extends ItemValues {
  sourceRow?: number | null;
}

/** A row chosen for the commit: a priced item or (contract import only) a section heading. */
export type CommitLine =
  | ({ kind: 'item' } & ParsedItem)
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
  /**
   * `file`: every value of an item comes from the row (contract and contractor imports).
   * `contract` (work orders, ADR-044): only the code and the quantity come from the row; the other
   * values are placeholders the caller replaces with the contract item's.
   */
  itemValues: 'file' | 'contract' = 'file',
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
    lines: included.map((row) => toLine(row, itemValues)),
    excludedCount: parsed.rows.filter((row) => excluded.has(row.rowNumber)).length,
    headingCount: included.filter((row) => row.kind === 'heading').length,
  };
}

function toLine(row: ImportPreviewRow, itemValues: 'file' | 'contract'): CommitLine {
  if (row.kind === 'heading') {
    return {
      kind: 'heading',
      code: row.code ?? '',
      description: row.description,
      sourceRow: row.rowNumber,
    };
  }
  return { kind: 'item', ...toNewItem(row, itemValues) };
}

/** Rows without errors have every field set; the fallbacks only satisfy the type checker. */
function toNewItem(row: ImportPreviewRow, itemValues: 'file' | 'contract'): ParsedItem {
  return {
    code: row.code ?? '',
    description: row.description ?? '',
    unit: row.unit ?? '',
    quantity: Decimal.parse(row.quantity ?? '0'),
    unitPrice: Decimal.parse(row.unitPrice ?? '0'),
    // Never defaulted: a work type is a business value (ADR-016). Rows without errors have one.
    workType:
      row.workType ??
      (itemValues === 'contract'
        ? 'civil' // placeholder, never stored: the line takes the contract item's work type
        : (() => {
            throw new Error(`Row ${row.rowNumber} has no work type`);
          })()),
    sourceRow: row.rowNumber,
  };
}
