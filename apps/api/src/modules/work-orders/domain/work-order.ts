import { unacceptedDuplicateCodes, type DuplicateCode } from '@ftth/shared';
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
}

export interface NewItem extends ItemValues {
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
  acceptedDuplicateCodes: readonly string[];
  createdById: string | null;
}

function duplicateConflict(codes: readonly string[]): AppError {
  return new AppError(
    'CONFLICT',
    `Duplicate item codes must be accepted explicitly: ${codes.join(', ')}`,
    {
      reason: 'DUPLICATE_CODE',
      codes,
    },
  );
}

/** A work order (أمر التكليف): header plus numbered items. Total = Σ quantity × unit price. */
export class WorkOrder {
  constructor(
    readonly header: WorkOrderHeader,
    readonly items: readonly WorkOrderItem[],
  ) {}

  static create(input: NewWorkOrder, ids: IdGenerator, now: Date): WorkOrder {
    const rejected = unacceptedDuplicateCodes(input.items, input.acceptedDuplicateCodes);
    if (rejected.length > 0) throw duplicateConflict(rejected);

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
    values: ItemValues,
    options: { lineNo?: number; acceptDuplicateCode: boolean },
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
    this.assertCodeAllowed(values.code, null, options.acceptDuplicateCode);
    return {
      id: ids.next(),
      lineNo,
      ...values,
      source: 'manual',
      sourceRow: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  changeItem(
    itemId: string,
    patch: Partial<ItemValues>,
    acceptDuplicateCode: boolean,
    now: Date,
  ): { before: WorkOrderItem; after: WorkOrderItem } {
    const before = this.findItem(itemId);
    if (patch.code !== undefined && patch.code !== before.code) {
      this.assertCodeAllowed(patch.code, itemId, acceptDuplicateCode);
    }
    return {
      before,
      after: {
        ...before,
        code: patch.code ?? before.code,
        description: patch.description ?? before.description,
        unit: patch.unit ?? before.unit,
        quantity: patch.quantity ?? before.quantity,
        unitPrice: patch.unitPrice ?? before.unitPrice,
        updatedAt: now,
      },
    };
  }

  private assertCodeAllowed(code: string, exceptItemId: string | null, accepted: boolean): void {
    const taken = this.items.some((item) => item.code === code && item.id !== exceptItemId);
    if (taken && !accepted) throw duplicateConflict([code]);
  }
}
