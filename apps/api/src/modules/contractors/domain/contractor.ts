import type { WorkType } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import { Decimal } from '../../work-orders/domain/decimal.js';

/** A subcontractor in the shared list (ADR-036). */
export interface ContractorRecord {
  id: string;
  name: string;
  contactName: string;
  contactPhone: string;
  commercialRegister: string | null;
  taxCard: string | null;
  /** Optimistic concurrency token. */
  version: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContractorSummary extends ContractorRecord {
  /** Work orders the contractor is registered on. */
  workOrderCount: number;
}

export interface ContractorPatch {
  name?: string;
  contactName?: string;
  contactPhone?: string;
  commercialRegister?: string | null;
  taxCard?: string | null;
}

/** A line of the project's work order, with what the contractor rules need (ADR-028 copies the contract). */
export interface WorkOrderLine {
  id: string;
  lineNo: number;
  code: string;
  description: string;
  unit: string;
  workType: WorkType | null;
  /** The contract price. */
  unitPrice: Decimal;
  quantity: Decimal;
  /** null only for lines saved before ADR-028. */
  contractItemId: string | null;
}

export interface ContractorPrice {
  id: string;
  /** Calendar date, `YYYY-MM-DD`. */
  effectiveFrom: string;
  unitPrice: Decimal;
  createdById: string | null;
  createdAt: Date;
}

export interface ContractorLine {
  id: string;
  quantity: Decimal;
  item: WorkOrderLine;
  /** Oldest `effectiveFrom` first. */
  prices: ContractorPrice[];
}

export interface Registration {
  id: string;
  projectId: string;
  workOrderId: string;
  contractor: Omit<ContractorRecord, 'version' | 'createdById' | 'createdAt' | 'updatedAt'>;
  registeredOn: string;
  /** In work-order line order. */
  lines: ContractorLine[];
  createdById: string | null;
  createdAt: Date;
}

export interface NewPrice {
  id: string;
  effectiveFrom: string;
  unitPrice: Decimal;
  createdById: string;
}

export interface NewLine {
  id: string;
  workOrderItemId: string;
  quantity: Decimal;
  /** The first price, effective from the registration date. */
  firstPrice: NewPrice;
}

export interface NewRegistration {
  id: string;
  projectId: string;
  workOrderId: string;
  contractorId: string;
  registeredOn: string;
  createdById: string;
  lines: NewLine[];
}

// ---------- rules (ADR-036); the DB triggers of migration 0013 repeat them race-safely ----------

/** The line must be a line of this work order that comes from the contract. */
export function assertAssignable(
  lines: ReadonlyMap<string, WorkOrderLine>,
  workOrderItemId: string,
): WorkOrderLine {
  const item = lines.get(workOrderItemId);
  if (!item) {
    throw new AppError('CONFLICT', 'The line is not a line of the work order', {
      reason: 'LINE_NOT_IN_WORK_ORDER',
      workOrderItemId,
    });
  }
  if (item.contractItemId === null) {
    throw new AppError('CONFLICT', 'The line was saved before contracts and cannot be assigned', {
      reason: 'LEGACY_ITEM',
      workOrderItemId,
      code: item.code,
    });
  }
  return item;
}

/** `reserved` (every other contractor line of the item) + `requested` must not exceed the work-order quantity. */
export function assertQuantityFits(
  item: WorkOrderLine,
  reserved: Decimal,
  requested: Decimal,
): void {
  if (reserved.add(requested).compare(item.quantity) <= 0) return;
  throw new AppError('CONFLICT', 'The quantity is above what is left of the work-order line', {
    reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
    workOrderItemId: item.id,
    code: item.code,
    workOrderQuantity: item.quantity.toString(),
    reservedQuantity: reserved.toString(),
    requestedQuantity: requested.toString(),
    availableQuantity: item.quantity.sub(reserved).toString(),
  });
}

/** A contractor price is at most the contract price (the work-order line's unit price). */
export function assertPriceWithinContract(item: WorkOrderLine, price: Decimal): void {
  if (price.compare(item.unitPrice) <= 0) return;
  throw new AppError('CONFLICT', 'The price is above the contract price', {
    reason: 'PRICE_EXCEEDS_CONTRACT',
    workOrderItemId: item.id,
    code: item.code,
    contractPrice: item.unitPrice.toString(),
    requestedPrice: price.toString(),
  });
}

/** A new price starts strictly after the latest one (ISO dates compare as text). */
export function assertPriceDateAfterLatest(
  prices: readonly ContractorPrice[],
  effectiveFrom: string,
): void {
  const latest = prices.reduce<string | null>(
    (max, price) => (max === null || price.effectiveFrom > max ? price.effectiveFrom : max),
    null,
  );
  if (latest !== null && effectiveFrom <= latest) {
    throw new AppError('CONFLICT', 'A new price must start after the latest price date', {
      reason: 'PRICE_DATE_NOT_AFTER_LATEST',
      latestEffectiveFrom: latest,
      requestedEffectiveFrom: effectiveFrom,
    });
  }
}

export function assertVersion(current: number, expected: number): void {
  if (current !== expected) {
    throw new AppError('CONFLICT', 'The contractor was changed by someone else', {
      reason: 'STALE_VERSION',
      currentVersion: current,
    });
  }
}

/** Σ quantity of the other contractor lines on every work-order line, from per-line sums. */
export const reservedOf = (reserved: ReadonlyMap<string, Decimal>, itemId: string): Decimal =>
  reserved.get(itemId) ?? Decimal.zero;
