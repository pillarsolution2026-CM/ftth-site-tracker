import type { WorkType } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import { Decimal, sumDecimals } from '../../work-orders/domain/decimal.js';

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
  /** Scope of work as typed (trimmed); null = the whole line. */
  scope: string | null;
  /** `scopeKeyOf(scope)`; scopes are compared only by this. */
  scopeKey: string | null;
  sourceRow: number | null;
  item: WorkOrderLine;
  /** Oldest `effectiveFrom` first. */
  prices: ContractorPrice[];
}

export interface ContractorImportFile {
  id: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  uploadedById: string | null;
  createdAt: Date;
}

export interface Registration {
  id: string;
  projectId: string;
  workOrderId: string;
  contractor: Omit<ContractorRecord, 'version' | 'createdById' | 'createdAt' | 'updatedAt'>;
  registeredOn: string;
  /** In work-order line order, then scope. */
  lines: ContractorLine[];
  /** Oldest first. */
  files: ContractorImportFile[];
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
  scope: string | null;
  scopeKey: string | null;
  quantity: Decimal;
  sourceRow: number | null;
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

export interface NewImportFile {
  id: string;
  projectId: string;
  registrationId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  uploadedById: string;
}

/**
 * What every contractor of the work order holds of one scope of one work-order line: Σ quantity
 * and the highest price ever recorded on the scope (any contractor, any date).
 */
export interface ScopeHolding {
  workOrderItemId: string;
  /** null = the whole line. */
  scopeKey: string | null;
  /** As first typed. */
  scope: string | null;
  quantity: Decimal;
  highestPrice: Decimal;
}

// ---------- rules (ADR-036); the DB triggers of migration 0013 repeat them race-safely ----------

const slot = (scopeKey: string | null): string => scopeKey ?? '';

export function holdingOf(
  holdings: readonly ScopeHolding[],
  workOrderItemId: string,
  scopeKey: string | null,
): ScopeHolding | undefined {
  return holdings.find(
    (holding) =>
      holding.workOrderItemId === workOrderItemId && slot(holding.scopeKey) === slot(scopeKey),
  );
}

/** Σ over the other scopes of the work-order line of each scope's highest price. */
export function otherScopesPrice(
  holdings: readonly ScopeHolding[],
  workOrderItemId: string,
  scopeKey: string | null,
): Decimal {
  return sumDecimals(
    holdings
      .filter(
        (holding) =>
          holding.workOrderItemId === workOrderItemId && slot(holding.scopeKey) !== slot(scopeKey),
      )
      .map((holding) => holding.highestPrice),
  );
}

/** `reserved` (the same scope held by others) + `requested` must not exceed the work-order quantity. */
export function assertQuantityFits(
  item: WorkOrderLine,
  scope: string | null,
  reserved: Decimal,
  requested: Decimal,
): void {
  if (reserved.add(requested).compare(item.quantity) <= 0) return;
  const available = item.quantity.sub(reserved);
  throw new AppError('CONFLICT', 'The quantity is above what is left of the work-order line', {
    reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
    workOrderItemId: item.id,
    code: item.code,
    scope,
    workOrderQuantity: item.quantity.toString(),
    reservedQuantity: reserved.toString(),
    requestedQuantity: requested.toString(),
    availableQuantity: (available.isNegative() ? Decimal.zero : available).toString(),
  });
}

/**
 * The scopes' prices on a line add up to at most the contract price: `others` (the other scopes'
 * highest prices) + this scope's highest price, which is the larger of what it has and `requested`.
 */
export function assertPriceWithinContract(
  item: WorkOrderLine,
  scope: string | null,
  others: Decimal,
  ownHighest: Decimal,
  requested: Decimal,
): void {
  const own = ownHighest.compare(requested) >= 0 ? ownHighest : requested;
  if (others.add(own).compare(item.unitPrice) <= 0) return;
  const room = item.unitPrice.sub(others);
  throw new AppError('CONFLICT', 'The price is above the contract price', {
    reason: 'PRICE_EXCEEDS_CONTRACT',
    workOrderItemId: item.id,
    code: item.code,
    scope,
    contractPrice: item.unitPrice.toString(),
    otherScopesPrice: others.toString(),
    maxAllowedPrice: (room.isNegative() ? Decimal.zero : room).toString(),
    requestedPrice: requested.toString(),
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
