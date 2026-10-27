import {
  IMPORT_ROW_ISSUE_SEVERITY,
  type ImportPreviewRow,
  type WorkOrderImportPreviewResponse,
} from '@ftth/shared';
import { Decimal, sumDecimals } from '../decimal.js';

export const hasError = (row: ImportPreviewRow): boolean =>
  row.issues.some((found) => found.severity === 'error');

/** Rows grouped by repeated item code, in order of first appearance. Codes are compared exactly. */
export function duplicateGroups(
  rows: readonly ImportPreviewRow[],
): Array<{ code: string; rowNumbers: number[] }> {
  const byCode = new Map<string, number[]>();
  for (const row of rows) {
    if (row.code !== null) byCode.set(row.code, [...(byCode.get(row.code) ?? []), row.rowNumber]);
  }
  return [...byCode]
    .filter(([, rowNumbers]) => rowNumbers.length > 1)
    .map(([code, rowNumbers]) => ({ code, rowNumbers }));
}

/** Adds DUPLICATE_CODE to every row of a repeated code (replacing earlier annotations). */
export function annotateDuplicateCodes(rows: readonly ImportPreviewRow[]): ImportPreviewRow[] {
  const groups = new Map(duplicateGroups(rows).map((group) => [group.code, group.rowNumbers]));
  return rows.map((row) => {
    const issues = row.issues.filter((found) => found.code !== 'DUPLICATE_CODE');
    const group = row.code === null ? undefined : groups.get(row.code);
    if (!group) return { ...row, issues };
    const otherRows = group.filter((n) => n !== row.rowNumber).join(',');
    return {
      ...row,
      issues: [
        ...issues,
        {
          code: 'DUPLICATE_CODE',
          severity: IMPORT_ROW_ISSUE_SEVERITY.DUPLICATE_CODE,
          field: 'code',
          params: { code: row.code ?? '', otherRows },
        },
      ],
    };
  });
}

export function summarize(
  rows: readonly ImportPreviewRow[],
): WorkOrderImportPreviewResponse['summary'] {
  const valid = rows.filter((row) => !hasError(row));
  return {
    rowCount: rows.length,
    errorRowCount: rows.length - valid.length,
    warningRowCount: rows.filter((row) => row.issues.some((found) => found.severity === 'warning'))
      .length,
    duplicateCodes: duplicateGroups(rows),
    total: sumDecimals(valid.map((row) => Decimal.parse(row.amount ?? '0'))).toString(),
  };
}
