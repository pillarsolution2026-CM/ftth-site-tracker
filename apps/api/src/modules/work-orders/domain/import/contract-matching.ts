import {
  IMPORT_ROW_ISSUE_SEVERITY,
  type ImportField,
  type ImportPreviewRow,
  type ImportRowIssue,
  type ImportRowIssueCode,
} from '@ftth/shared';
import {
  availableQuantity,
  reservedOf,
  type ApprovedContract,
  type ContractItemInfo,
  type Reservations,
} from '../contract-lines.js';
import { Decimal } from '../decimal.js';
import { summarize } from './import-summary.js';
import type { ParsedImport } from './import-parser.js';

type Params = NonNullable<ImportRowIssue['params']>;

const issue = (
  code: ImportRowIssueCode,
  field: ImportField | null,
  params?: Params,
): ImportRowIssue => ({
  code,
  severity: IMPORT_ROW_ISSUE_SEVERITY[code],
  field,
  ...(params ? { params } : {}),
});

function samePrice(row: ImportPreviewRow, item: ContractItemInfo): boolean {
  return row.unitPrice === null || Decimal.parse(row.unitPrice).equals(item.unitPrice);
}

/** Fields of the row that differ from the contract item; only fields the row has a value for. */
function mismatches(row: ImportPreviewRow, item: ContractItemInfo): ImportRowIssue[] {
  const found: ImportRowIssue[] = [];
  if (row.description !== null && row.description.trim() !== item.description.trim()) {
    found.push(issue('CONTRACT_MISMATCH', 'description', { contractValue: item.description }));
  }
  if (row.unit !== null && row.unit.trim() !== item.unit.trim()) {
    found.push(issue('CONTRACT_MISMATCH', 'unit', { contractValue: item.unit }));
  }
  if (!samePrice(row, item)) {
    found.push(
      issue('CONTRACT_MISMATCH', 'unitPrice', { contractValue: item.unitPrice.toString() }),
    );
  }
  if (row.workType !== null && row.workType !== item.workType) {
    found.push(issue('CONTRACT_MISMATCH', 'workType', { contractValue: item.workType }));
  }
  return found;
}

/**
 * An item row whose quantity cell is empty is not part of the work order: it becomes `skipped`
 * with only the EMPTY_QUANTITY_SKIPPED warning, and no other check applies (owner, 2026-10-31).
 * A quantity of 0 or unreadable text is not empty and keeps its normal checks.
 */
function skipEmptyQuantity(row: ImportPreviewRow): ImportPreviewRow {
  if (row.kind !== 'item' || row.raw.quantity !== null) return row;
  return {
    ...row,
    kind: 'skipped',
    amount: null,
    issues: [
      issue('EMPTY_QUANTITY_SKIPPED', 'quantity', row.code ? { code: row.code } : undefined),
    ],
  };
}

/** The contract item a code refers to; with several of the same code, the one that equals the row. */
function pickCandidate(
  row: ImportPreviewRow,
  candidates: readonly ContractItemInfo[],
): ContractItemInfo | undefined {
  return candidates.find((item) => mismatches(row, item).length === 0) ?? candidates[0];
}

/**
 * Checks the item rows of a work-order sheet against the project's approved contract (ADR-028).
 * Matching is by code to a priced item; headings never match and are left untouched. Any
 * difference is an error: NOT_IN_CONTRACT, CONTRACT_MISMATCH (one per field), CODE_REPEATED,
 * QUANTITY_EXCEEDS_CONTRACT. DUPLICATE_CODE is replaced by CODE_REPEATED. `reservations` must not
 * include the sheet itself (the work order does not exist yet).
 */
export function annotateAgainstContract(
  sheetRows: readonly ImportPreviewRow[],
  contract: ApprovedContract,
  reservations: Reservations,
): ImportPreviewRow[] {
  const rows = sheetRows.map(skipEmptyQuantity);
  const byCode = new Map<string, ContractItemInfo[]>();
  for (const item of contract.items)
    byCode.set(item.code, [...(byCode.get(item.code) ?? []), item]);

  const rowsOfCode = new Map<string, number[]>();
  for (const row of rows) {
    if (row.kind === 'item' && row.code !== null) {
      rowsOfCode.set(row.code, [...(rowsOfCode.get(row.code) ?? []), row.rowNumber]);
    }
  }

  return rows.map((row) => {
    const issues = row.issues.filter((found) => found.code !== 'DUPLICATE_CODE');
    if (row.kind !== 'item' || row.code === null) return { ...row, issues };

    const added: ImportRowIssue[] = [];
    const sameCode = rowsOfCode.get(row.code) ?? [];
    if (sameCode.length > 1) {
      added.push(
        issue('CODE_REPEATED', 'code', {
          code: row.code,
          otherRows: sameCode.filter((n) => n !== row.rowNumber).join(','),
        }),
      );
    }

    const item = pickCandidate(row, byCode.get(row.code) ?? []);
    if (!item) {
      added.push(issue('NOT_IN_CONTRACT', 'code', { code: row.code }));
    } else {
      added.push(...mismatches(row, item));
      if (row.quantity !== null) {
        const reserved = reservedOf(reservations, item.id);
        if (reserved.add(Decimal.parse(row.quantity)).compare(item.quantity) > 0) {
          const available = availableQuantity(item, reserved);
          added.push(
            issue('QUANTITY_EXCEEDS_CONTRACT', 'quantity', {
              availableQuantity: (available.isNegative() ? Decimal.zero : available).toString(),
              contractQuantity: item.quantity.toString(),
              reservedQuantity: reserved.toString(),
            }),
          );
        }
      }
    }
    return { ...row, issues: [...issues, ...added] };
  });
}

/** The parsed sheet with contract issues added and the summary recomputed. */
export function checkImportAgainstContract(
  parsed: ParsedImport,
  contract: ApprovedContract,
  reservations: Reservations,
): ParsedImport {
  const rows = annotateAgainstContract(parsed.rows, contract, reservations);
  return { ...parsed, rows, summary: summarize(rows) };
}

/** Contract item of an item row that passed the checks (same pick as the annotation). */
export function contractItemOfRow(
  row: ImportPreviewRow,
  contract: ApprovedContract,
): ContractItemInfo | undefined {
  const candidates = contract.items.filter((item) => item.code === row.code);
  return pickCandidate(row, candidates);
}
