import {
  IMPORT_ROW_ISSUE_SEVERITY,
  scopeKeyOf,
  type ImportField,
  type ImportInvalidDetails,
  type ImportPreviewRow,
  type ImportRowIssue,
  type ImportRowIssueCode,
} from '@ftth/shared';
import { Decimal } from '../../../work-orders/domain/decimal.js';
import { skipEmptyQuantity } from '../../../work-orders/domain/import/contract-matching.js';
import { summarize } from '../../../work-orders/domain/import/import-summary.js';
import type { ParsedImport } from '../../../work-orders/domain/import/import-parser.js';
import type { ScopeHolding, WorkOrderLine } from '../contractor.js';

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

/** What the sheet is checked against: the work order, what contractors hold, and the append target. */
export interface ContractorSheetContext {
  lines: readonly WorkOrderLine[];
  /** Every contractor of the work order (including the append target's registration). */
  holdings: readonly ScopeHolding[];
  /** Append target only: `${workOrderItemId}|${scopeKey ?? ''}` the registration already holds. */
  ownSlots: ReadonlySet<string>;
}

export const slotOf = (workOrderItemId: string, scopeKey: string | null): string =>
  `${workOrderItemId}|${scopeKey ?? ''}`;

const sum = (values: Iterable<Decimal>): Decimal => {
  let total = Decimal.zero;
  for (const value of values) total = total.add(value);
  return total;
};

/** The work-order line a code refers to; with several of the same code, the one that equals the row. */
function pickLine(row: ImportPreviewRow, candidates: readonly WorkOrderLine[]) {
  const same = (line: WorkOrderLine) =>
    (row.description === null || row.description.trim() === line.description.trim()) &&
    (row.unit === null || row.unit.trim() === line.unit.trim());
  return candidates.find(same) ?? candidates[0];
}

/** Work-order line of an item row (same pick as the annotation). */
export function workOrderLineOfRow(
  row: ImportPreviewRow,
  lines: readonly WorkOrderLine[],
): WorkOrderLine | undefined {
  return pickLine(
    row,
    lines.filter((line) => line.code === row.code),
  );
}

interface Resolved {
  row: ImportPreviewRow;
  line: WorkOrderLine | undefined;
  scopeKey: string | null;
}

/**
 * Checks the item rows of a contractor sheet against the project's work order (ADR-036, owner
 * 2026-11-07). Rows are matched by code; description and unit must equal the work-order line.
 * Quantity is capped per (line, scope key) over every contractor and the other rows of the sheet;
 * a line is given whole or by scope, never both; the scopes' prices on a line add up to at most the
 * contract price (a scope's price is the highest ever recorded, or the sheet's if higher).
 */
export function annotateContractorSheet(
  sheetRows: readonly ImportPreviewRow[],
  context: ContractorSheetContext,
): ImportPreviewRow[] {
  const rows = sheetRows.map(skipEmptyQuantity);
  const resolved: Resolved[] = rows.map((row) => {
    const isItem = row.kind === 'item' && row.code !== null;
    return {
      row,
      line: isItem ? workOrderLineOfRow(row, context.lines) : undefined,
      scopeKey: scopeKeyOf(row.scope),
    };
  });
  const items = resolved.filter((r) => r.row.kind === 'item' && r.row.code !== null);

  // Rows grouped by (line, scope) - or (code, scope) when the code is unknown.
  const groupKey = (r: Resolved): string =>
    `${r.line?.id ?? `code:${r.row.code ?? ''}`}|${r.scopeKey ?? ''}`;
  const groups = new Map<string, Resolved[]>();
  for (const r of items) groups.set(groupKey(r), [...(groups.get(groupKey(r)) ?? []), r]);

  // Per work-order line: the sheet's scope keys, and the highest sheet price of each.
  const sheetKeysByLine = new Map<string, Set<string | null>>();
  const sheetHighByLineScope = new Map<string, Decimal>();
  for (const r of items) {
    if (!r.line) continue;
    const keys = sheetKeysByLine.get(r.line.id) ?? new Set<string | null>();
    keys.add(r.scopeKey);
    sheetKeysByLine.set(r.line.id, keys);
    if (r.row.unitPrice !== null) {
      const slot = slotOf(r.line.id, r.scopeKey);
      const price = Decimal.parse(r.row.unitPrice);
      const current = sheetHighByLineScope.get(slot);
      if (!current || price.compare(current) > 0) sheetHighByLineScope.set(slot, price);
    }
  }
  const holdingsOfLine = (lineId: string) =>
    context.holdings.filter((holding) => holding.workOrderItemId === lineId);

  return resolved.map((r) => {
    const { row } = r;
    const issues = row.issues.filter((found) => found.code !== 'DUPLICATE_CODE');
    if (row.kind !== 'item' || row.code === null) return { ...row, issues };

    const added: ImportRowIssue[] = [];
    const scopeText = row.scope ?? '';
    const sameGroup = groups.get(groupKey(r)) ?? [];
    if (sameGroup.length > 1) {
      added.push(
        issue('CODE_SCOPE_REPEATED', 'code', {
          code: row.code,
          scope: scopeText,
          otherRows: sameGroup
            .filter((other) => other.row.rowNumber !== row.rowNumber)
            .map((other) => other.row.rowNumber)
            .join(','),
        }),
      );
    }

    const line = r.line;
    if (!line) {
      added.push(issue('NOT_IN_WORK_ORDER', 'code', { code: row.code }));
      return { ...row, issues: [...issues, ...added] };
    }
    if (row.description !== null && row.description.trim() !== line.description.trim()) {
      added.push(issue('WORK_ORDER_MISMATCH', 'description', { workOrderValue: line.description }));
    }
    if (row.unit !== null && row.unit.trim() !== line.unit.trim()) {
      added.push(issue('WORK_ORDER_MISMATCH', 'unit', { workOrderValue: line.unit }));
    }
    if (line.contractItemId === null) {
      added.push(issue('LEGACY_WORK_ORDER_LINE', 'code', { code: row.code }));
    }

    // Whole and scoped never mix: inside the sheet, or against what contractors already hold.
    const sheetKeys = sheetKeysByLine.get(line.id) ?? new Set<string | null>();
    const sheetMixed = [...sheetKeys].some((key) => key === null) && sheetKeys.size > 1;
    const heldKeys = holdingsOfLine(line.id).map((holding) => holding.scopeKey);
    const heldWhole = heldKeys.some((key) => key === null);
    const heldScoped = heldKeys.some((key) => key !== null);
    const clashesWithHeld = r.scopeKey === null ? heldScoped : heldWhole;
    if (sheetMixed || clashesWithHeld) {
      added.push(issue('WHOLE_AND_SCOPES_MIXED', 'scope', { code: row.code }));
    }

    if (context.ownSlots.has(slotOf(line.id, r.scopeKey))) {
      added.push(issue('LINE_ALREADY_ASSIGNED', 'code', { code: row.code, scope: scopeText }));
    }

    if (row.quantity !== null) {
      const held = holdingsOfLine(line.id).find(
        (holding) => (holding.scopeKey ?? '') === (r.scopeKey ?? ''),
      );
      const otherRows = sum(
        sameGroup
          .filter((other) => other.row.rowNumber !== row.rowNumber && other.row.quantity !== null)
          .map((other) => Decimal.parse(other.row.quantity ?? '0')),
      );
      const reserved = (held?.quantity ?? Decimal.zero).add(otherRows);
      const requested = Decimal.parse(row.quantity);
      if (reserved.add(requested).compare(line.quantity) > 0) {
        const available = line.quantity.sub(reserved);
        added.push(
          issue('QUANTITY_EXCEEDS_WORK_ORDER', 'quantity', {
            scope: scopeText,
            workOrderQuantity: line.quantity.toString(),
            reservedQuantity: reserved.toString(),
            availableQuantity: (available.isNegative() ? Decimal.zero : available).toString(),
          }),
        );
      }
    }

    if (row.unitPrice !== null) {
      // Each scope counts at its highest price: what contractors recorded, or the sheet's if higher.
      const highOf = (key: string | null): Decimal => {
        const held =
          holdingsOfLine(line.id).find((h) => (h.scopeKey ?? '') === (key ?? ''))?.highestPrice ??
          Decimal.zero;
        const sheet = sheetHighByLineScope.get(slotOf(line.id, key)) ?? Decimal.zero;
        return held.compare(sheet) >= 0 ? held : sheet;
      };
      const allKeys = new Set<string>([
        ...heldKeys.map((key) => key ?? ''),
        ...[...sheetKeys].map((key) => key ?? ''),
      ]);
      const others = sum(
        [...allKeys].filter((key) => key !== (r.scopeKey ?? '')).map((key) => highOf(key || null)),
      );
      const price = Decimal.parse(row.unitPrice);
      const held =
        holdingsOfLine(line.id).find((h) => (h.scopeKey ?? '') === (r.scopeKey ?? ''))
          ?.highestPrice ?? Decimal.zero;
      // Only this row's own price counts for the row itself; the sheet's other rows of the same
      // scope are CODE_SCOPE_REPEATED already.
      const own = held.compare(price) >= 0 ? held : price;
      if (others.add(own).compare(line.unitPrice) > 0) {
        const room = line.unitPrice.sub(others);
        added.push(
          issue('PRICE_EXCEEDS_CONTRACT', 'unitPrice', {
            scope: scopeText,
            contractPrice: line.unitPrice.toString(),
            otherScopesPrice: others.toString(),
            maxAllowedPrice: (room.isNegative() ? Decimal.zero : room).toString(),
          }),
        );
      }
    }
    return { ...row, issues: [...issues, ...added] };
  });
}

/** The parsed sheet with work-order issues added and the summary recomputed. */
export function checkContractorSheet(
  parsed: ParsedImport,
  context: ContractorSheetContext,
): ParsedImport {
  const rows = annotateContractorSheet(parsed.rows, context);
  return { ...parsed, rows, summary: summarize(rows) };
}

export type ContractorSelection =
  { ok: true; rows: ImportPreviewRow[] } | { ok: false; details: ImportInvalidDetails };

/** Item rows chosen for the commit, or why the commit is refused (file issues, row errors, nothing included). */
export function selectContractorRows(parsed: ParsedImport): ContractorSelection {
  const refuse = (
    reason: ImportInvalidDetails['reason'],
    extra: Partial<Omit<ImportInvalidDetails, 'reason'>> = {},
  ): ContractorSelection => ({
    ok: false,
    details: { reason, fileIssues: [], rows: [], duplicateCodes: [], ...extra },
  });
  if (parsed.fileIssues.length > 0) {
    return refuse('FILE_ISSUES', { fileIssues: parsed.fileIssues });
  }
  const included = parsed.rows.filter((row) => row.kind === 'item');
  const withErrors = included.filter((row) =>
    row.issues.some((found) => found.severity === 'error'),
  );
  if (withErrors.length > 0) {
    return refuse('ROW_ERRORS', {
      rows: withErrors.map((row) => ({
        rowNumber: row.rowNumber,
        issues: row.issues.filter((found) => found.severity === 'error'),
      })),
    });
  }
  if (included.length === 0) return refuse('NO_ROWS_INCLUDED');
  return { ok: true, rows: included };
}
