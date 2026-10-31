import {
  Decimal4StringSchema,
  type ContractItemAvailability,
  type WorkOrderLineInput,
} from '@ftth/shared';
import { compareDecimals, normalizeDecimalInput, sumDecimals } from '@/shared/lib/decimal';

/** A contract item the user ticked, with the quantity typed so far (as typed). */
export interface LineSelection {
  contractItemId: string;
  quantity: string;
}

/**
 * - `invalidQuantity`: empty or not a decimal with at most 4 places (blocks the submit).
 * - `repeated`: the item is selected more than once (blocks the submit).
 * - `exceeds`: quantity above what is available. A warning only: the server decides (409
 *   QUANTITY_EXCEEDS_CONTRACT), because other users may have reserved quantity meanwhile.
 */
export type LineIssue = 'invalidQuantity' | 'repeated' | 'exceeds';

export interface LineCheck {
  contractItemId: string;
  /** The quantity as typed. */
  raw: string;
  /** Normalised quantity (Arabic digits converted); '' when empty. */
  quantity: string;
  issues: LineIssue[];
  /** What is available for this item at the moment (the server's number), if the item is known. */
  available: string | null;
}

/** Items whose code or description contains the query (case-insensitive, trimmed). */
export function filterItems(
  items: readonly ContractItemAvailability[],
  query: string,
): ContractItemAvailability[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...items];
  return items.filter(
    (item) =>
      item.code.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle),
  );
}

export function checkSelection(
  items: readonly ContractItemAvailability[],
  selection: readonly LineSelection[],
  /** Quantity already counted in `available` for each line (editing a line frees its own quantity). */
  alreadyReserved: Readonly<Record<string, string>> = {},
): LineCheck[] {
  const counts = new Map<string, number>();
  for (const line of selection) {
    counts.set(line.contractItemId, (counts.get(line.contractItemId) ?? 0) + 1);
  }
  return selection.map((line) => {
    const item = items.find((candidate) => candidate.contractItemId === line.contractItemId);
    const quantity = normalizeDecimalInput(line.quantity);
    const issues: LineIssue[] = [];
    const valid = quantity !== '' && Decimal4StringSchema.safeParse(quantity).success;
    if (!valid) issues.push('invalidQuantity');
    if ((counts.get(line.contractItemId) ?? 0) > 1) issues.push('repeated');
    let available: string | null = null;
    if (item) {
      available = item.availableQuantity;
      const own = alreadyReserved[line.contractItemId];
      const ceiling = own ? sumDecimals([item.availableQuantity, own]) : item.availableQuantity;
      if (valid && compareDecimals(quantity, ceiling) > 0) issues.push('exceeds');
    }
    return { contractItemId: line.contractItemId, raw: line.quantity, quantity, issues, available };
  });
}

/** True when nothing blocks the submit (warnings do not block). */
export function canSubmit(checks: readonly LineCheck[]): boolean {
  return (
    checks.length > 0 &&
    checks.every(
      (check) => !check.issues.includes('invalidQuantity') && !check.issues.includes('repeated'),
    )
  );
}

/** The `{contractItemId, quantity}` lines for the API, or null while something blocks the submit. */
export function linePayload(checks: readonly LineCheck[]): WorkOrderLineInput[] | null {
  if (!canSubmit(checks) && checks.length > 0) return null;
  return checks.map((check) => ({
    contractItemId: check.contractItemId,
    quantity: check.quantity,
  }));
}
