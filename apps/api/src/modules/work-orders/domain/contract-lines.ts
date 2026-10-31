import type { WorkType } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import { Decimal } from './decimal.js';
import type { NewItem } from './work-order.js';

/** A priced item of the project's approved contract (ADR-028). Headings are never included. */
export interface ContractItemInfo {
  id: string;
  lineNo: number;
  code: string;
  description: string;
  unit: string;
  unitPrice: Decimal;
  workType: WorkType;
  /** Quantity of the contract. */
  quantity: Decimal;
}

/** The approved contract of a project with its priced items in line order. */
export interface ApprovedContract {
  id: string;
  number: string;
  items: readonly ContractItemInfo[];
}

/** Σ quantity of every work-order line of each contract item (all projects), by contract item id. */
export type Reservations = ReadonlyMap<string, Decimal>;

export const reservedOf = (reservations: Reservations, contractItemId: string): Decimal =>
  reservations.get(contractItemId) ?? Decimal.zero;

/** contract − reserved. May be negative only for data written before the rule existed. */
export function availableQuantity(item: ContractItemInfo, reserved: Decimal): Decimal {
  return item.quantity.sub(reserved);
}

export function findContractItem(
  contract: ApprovedContract,
  contractItemId: string,
): ContractItemInfo {
  const item = contract.items.find((candidate) => candidate.id === contractItemId);
  if (!item) {
    throw new AppError('CONFLICT', 'The item is not a priced item of the project contract', {
      reason: 'NOT_IN_CONTRACT',
      contractItemId,
    });
  }
  return item;
}

/**
 * Reservation rule: `reserved` (every other line of the item) + `requested` ≤ contract quantity.
 * Owner, 2026-10-31: a quantity above the contract is fully blocked.
 */
export function assertWithinContract(
  item: ContractItemInfo,
  reserved: Decimal,
  requested: Decimal,
): void {
  if (reserved.add(requested).compare(item.quantity) <= 0) return;
  const available = availableQuantity(item, reserved);
  throw new AppError('CONFLICT', `Quantity of ${item.code} exceeds the contract quantity`, {
    reason: 'QUANTITY_EXCEEDS_CONTRACT',
    contractItemId: item.id,
    code: item.code,
    contractQuantity: item.quantity.toString(),
    reservedQuantity: reserved.toString(),
    requestedQuantity: requested.toString(),
    availableQuantity: (available.isNegative() ? Decimal.zero : available).toString(),
  });
}

/** A new line: every field but the quantity is copied from the contract item (ADR-028). */
export function lineFromContract(
  contract: ApprovedContract,
  contractItemId: string,
  quantity: Decimal,
  sourceRow: number | null = null,
): NewItem {
  const item = findContractItem(contract, contractItemId);
  return {
    contractId: contract.id,
    contractItemId: item.id,
    code: item.code,
    description: item.description,
    unit: item.unit,
    unitPrice: item.unitPrice,
    workType: item.workType,
    quantity,
    sourceRow,
  };
}

/** Reservation check for the new lines of one work order (each contract item at most once). */
export function assertLinesFit(
  contract: ApprovedContract,
  reservations: Reservations,
  lines: readonly NewItem[],
): void {
  for (const line of lines) {
    const item = findContractItem(contract, line.contractItemId);
    assertWithinContract(item, reservedOf(reservations, item.id), line.quantity);
  }
}
