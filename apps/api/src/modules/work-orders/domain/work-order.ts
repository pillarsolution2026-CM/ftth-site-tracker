import type { DuplicateCode, WorkType } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { IdGenerator } from '../../../common/clock.js';
import type { Decimal } from './decimal.js';
import { sumDecimals } from './decimal.js';

export type WorkOrderSource = 'manual' | 'import';

export interface WorkOrderItem {
  id: string;
  lineNo: number;
  code: string;
  description: string;
  unit: string;
  quantity: Decimal;
  unitPrice: Decimal;
  /** null only for items saved before ADR-016; an edit must set it. */
  workType: WorkType | null;
  /** Contract and contract item the line comes from (ADR-028); null only for lines saved before it. */
  contractId: string | null;
  contractItemId: string | null;
  source: WorkOrderSource;
  /** Excel row number when imported. */
  sourceRow: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** quantity × unitPrice, exact (never rounded in Phase 1a, ADR-011). */
export const itemAmount = (item: Pick<WorkOrderItem, 'quantity' | 'unitPrice'>): Decimal =>
  item.quantity.mul(item.unitPrice);

export interface WorkOrderHeader {
  id: string;
  projectId: string;
  number: string;
  title: string | null;
  issuedOn: string | null;
  notes: string | null;
  /** Copied from the project at creation; immutable. */
  currency: string;
  source: WorkOrderSource;
  /** Optimistic concurrency token, bumped on every header or item change. */
  version: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemValues {
  code: string;
  description: string;
  unit: string;
  quantity: Decimal;
  unitPrice: Decimal;
  workType: WorkType;
}

export interface NewItem extends ItemValues {
  contractId: string;
  contractItemId: string;
  sourceRow?: number | null;
}

export interface HeaderPatch {
  number?: string;
  title?: string | null;
  issuedOn?: string | null;
  notes?: string | null;
}

export interface NewWorkOrder {
  projectId: string;
  number: string;
  title?: string | null;
  issuedOn?: string | null;
  notes?: string | null;
  currency: string;
  source: WorkOrderSource;
  items: readonly NewItem[];
  createdById: string | null;
}

function repeatedConflict(contractItemIds: readonly string[]): AppError {
  return new AppError('CONFLICT', 'A contract item may appear only once in a work order', {
    reason: 'CONTRACT_ITEM_REPEATED',
    contractItemIds,
  });
}

/** A work order (أمر التكليف): header plus numbered items. Total = Σ quantity × unit price. */
export class WorkOrder {
  constructor(
    readonly header: WorkOrderHeader,
    readonly items: readonly WorkOrderItem[],
  ) {}

  static create(input: NewWorkOrder, ids: IdGenerator, now: Date): WorkOrder {
    const repeated = repeatedContractItemIds(input.items);
    if (repeated.length > 0) throw repeatedConflict(repeated);

    const header: WorkOrderHeader = {
      id: ids.next(),
      projectId: input.projectId,
      number: input.number,
      title: input.title ?? null,
      issuedOn: input.issuedOn ?? null,
      notes: input.notes ?? null,
      currency: input.currency,
      source: input.source,
      version: 1,
      createdById: input.createdById,
      createdAt: now,
      updatedAt: now,
    };
    const items = input.items.map((item, index) => ({
      id: ids.next(),
      lineNo: index + 1,
      code: item.code,
      description: item.description,
      unit: item.unit,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      workType: item.workType,
      contractId: item.contractId,
      contractItemId: item.contractItemId,
      source: input.source,
      sourceRow: item.sourceRow ?? null,
      createdAt: now,
      updatedAt: now,
    }));
    return new WorkOrder(header, items);
  }

  get total(): Decimal {
    return sumDecimals(this.items.map(itemAmount));
  }

  /** Codes used by more than one line, in order of first appearance. */
  duplicateCodes(): DuplicateCode[] {
    const lines = new Map<string, number[]>();
    for (const item of this.items)
      lines.set(item.code, [...(lines.get(item.code) ?? []), item.lineNo]);
    return [...lines]
      .filter(([, lineNos]) => lineNos.length > 1)
      .map(([code, lineNos]) => ({ code, lineNos }));
  }

  findItem(itemId: string): WorkOrderItem {
    const item = this.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new AppError('NOT_FOUND', 'Work order item not found');
    return item;
  }

  /** Optimistic concurrency check for header edits. */
  assertVersion(expected: number): void {
    if (this.header.version !== expected) {
      throw new AppError('CONFLICT', 'The work order was changed by someone else', {
        reason: 'VERSION_MISMATCH',
        currentVersion: this.header.version,
      });
    }
  }

  /** Line numbers are never compacted, so the next one is max + 1. */
  nextLineNo(): number {
    return this.items.reduce((max, item) => Math.max(max, item.lineNo), 0) + 1;
  }

  buildItem(
    line: NewItem,
    options: { lineNo?: number },
    ids: IdGenerator,
    now: Date,
  ): WorkOrderItem {
    const lineNo = options.lineNo ?? this.nextLineNo();
    if (this.items.some((item) => item.lineNo === lineNo)) {
      throw new AppError('CONFLICT', `Line ${lineNo} is already used`, {
        reason: 'LINE_TAKEN',
        lineNo,
      });
    }
    if (this.items.some((item) => item.contractItemId === line.contractItemId)) {
      throw repeatedConflict([line.contractItemId]);
    }
    return {
      id: ids.next(),
      lineNo,
      code: line.code,
      description: line.description,
      unit: line.unit,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      workType: line.workType,
      contractId: line.contractId,
      contractItemId: line.contractItemId,
      source: 'manual',
      sourceRow: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Only the quantity of a line changes; every other field is the contract's (ADR-028). */
  changeQuantity(
    itemId: string,
    quantity: Decimal,
    now: Date,
  ): { before: WorkOrderItem; after: WorkOrderItem } {
    const before = this.findItem(itemId);
    if (before.contractItemId === null) {
      throw new AppError('CONFLICT', 'A line saved before contract lines cannot be edited', {
        reason: 'LEGACY_ITEM',
      });
    }
    return { before, after: { ...before, quantity, updatedAt: now } };
  }
}

/** Contract items used by more than one line. */
export function repeatedContractItemIds(
  items: readonly { contractItemId: string | null }[],
): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const item of items) {
    if (item.contractItemId === null) continue;
    if (seen.has(item.contractItemId)) repeated.add(item.contractItemId);
    seen.add(item.contractItemId);
  }
  return [...repeated];
}
