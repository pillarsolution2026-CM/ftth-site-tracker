import {
  MAX_CONTRACT_ITEMS,
  type ContractItemKind,
  type ContractSource,
  type ContractStatus,
  type DuplicateCode,
  type WorkType,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { IdGenerator } from '../../../common/clock.js';
import { sumDecimals, type Decimal } from '../../work-orders/domain/decimal.js';

/** One BOQ line: a priced `item` or a section `heading` (all priced fields are null then). */
export interface ContractLine {
  id: string;
  lineNo: number;
  kind: ContractItemKind;
  code: string;
  /** Null only for a heading without a title. */
  description: string | null;
  unit: string | null;
  quantity: Decimal | null;
  unitPrice: Decimal | null;
  workType: WorkType | null;
  source: ContractSource;
  sourceRow: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** quantity × unitPrice, exact; null for headings. */
export const lineAmount = (line: Pick<ContractLine, 'quantity' | 'unitPrice'>): Decimal | null =>
  line.quantity && line.unitPrice ? line.quantity.mul(line.unitPrice) : null;

export interface ContractHeader {
  id: string;
  number: string;
  name: string;
  client: string;
  /** Fixed at creation. */
  currency: string;
  startsOn: string | null;
  durationDays: number | null;
  notes: string | null;
  status: ContractStatus;
  approvedAt: Date | null;
  approvedById: string | null;
  /** Optimistic concurrency token, bumped on every header or BOQ change. */
  version: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type LineValues =
  | {
      kind: 'item';
      code: string;
      description: string;
      unit: string;
      quantity: Decimal;
      unitPrice: Decimal;
      workType: WorkType;
    }
  | { kind: 'heading'; code: string; description: string | null };

/** A line chosen by the import: values plus the sheet row it came from. */
export type ImportedLine = LineValues & { sourceRow: number };

export interface HeaderPatch {
  number?: string;
  name?: string;
  client?: string;
  startsOn?: string | null;
  durationDays?: number | null;
  notes?: string | null;
}

export interface NewContract {
  number: string;
  name: string;
  client: string;
  currency: string;
  startsOn?: string | null;
  durationDays?: number | null;
  notes?: string | null;
  createdById: string | null;
}

const conflict = (message: string, reason: string, extra: Record<string, unknown> = {}) =>
  new AppError('CONFLICT', message, { reason, ...extra });

/**
 * A contract (العقد): header plus the BOQ lines. Draft until approved; approval is final and
 * locks the lines (ADR-027). Totals count priced items only.
 */
export class Contract {
  constructor(
    readonly header: ContractHeader,
    readonly lines: readonly ContractLine[],
  ) {}

  static create(input: NewContract, ids: IdGenerator, now: Date): Contract {
    return new Contract(
      {
        id: ids.next(),
        number: input.number,
        name: input.name,
        client: input.client,
        currency: input.currency,
        startsOn: input.startsOn ?? null,
        durationDays: input.durationDays ?? null,
        notes: input.notes ?? null,
        status: 'draft',
        approvedAt: null,
        approvedById: null,
        version: 1,
        createdById: input.createdById,
        createdAt: now,
        updatedAt: now,
      },
      [],
    );
  }

  get isApproved(): boolean {
    return this.header.status === 'approved';
  }

  /** Priced lines only. */
  get items(): ContractLine[] {
    return this.lines.filter((line) => line.kind === 'item');
  }

  get total(): Decimal {
    return sumDecimals(this.items.flatMap((line) => lineAmount(line) ?? []));
  }

  /** Codes used by more than one line (headings included), in order of first appearance. */
  duplicateCodes(): DuplicateCode[] {
    const byCode = new Map<string, number[]>();
    for (const line of this.lines) {
      byCode.set(line.code, [...(byCode.get(line.code) ?? []), line.lineNo]);
    }
    return [...byCode]
      .filter(([, lineNos]) => lineNos.length > 1)
      .map(([code, lineNos]) => ({ code, lineNos }));
  }

  findLine(lineId: string): ContractLine {
    const line = this.lines.find((candidate) => candidate.id === lineId);
    if (!line) throw new AppError('NOT_FOUND', 'Contract item not found');
    return line;
  }

  assertVersion(expected: number): void {
    if (this.header.version !== expected) {
      throw conflict('The contract was changed by someone else', 'STALE_VERSION', {
        currentVersion: this.header.version,
      });
    }
  }

  /** The BOQ of an approved contract is locked. */
  assertDraft(): void {
    if (this.isApproved) {
      throw conflict('The contract is approved; its BOQ is locked', 'CONTRACT_APPROVED');
    }
  }

  /** Line numbers are never compacted, so the next one is max + 1. */
  nextLineNo(): number {
    return this.lines.reduce((max, line) => Math.max(max, line.lineNo), 0) + 1;
  }

  buildLine(
    values: LineValues,
    options: { lineNo?: number; acceptDuplicateCode: boolean },
    ids: IdGenerator,
    now: Date,
  ): ContractLine {
    this.assertDraft();
    if (this.lines.length >= MAX_CONTRACT_ITEMS) {
      throw new AppError(
        'VALIDATION_FAILED',
        `A contract holds at most ${MAX_CONTRACT_ITEMS} lines`,
      );
    }
    const lineNo = options.lineNo ?? this.nextLineNo();
    if (this.lines.some((line) => line.lineNo === lineNo)) {
      throw conflict(`Line ${lineNo} is already used`, 'LINE_TAKEN', { lineNo });
    }
    this.assertCodeAllowed(values.code, null, options.acceptDuplicateCode);
    return toLine(values, { id: ids.next(), lineNo, source: 'manual', sourceRow: null, now });
  }

  /** Replaces the line's content (the kind may change); id, number and origin stay. */
  changeLine(
    lineId: string,
    values: LineValues,
    acceptDuplicateCode: boolean,
    now: Date,
  ): { before: ContractLine; after: ContractLine } {
    this.assertDraft();
    const before = this.findLine(lineId);
    if (values.code !== before.code) {
      this.assertCodeAllowed(values.code, lineId, acceptDuplicateCode);
    }
    const after = toLine(values, {
      id: before.id,
      lineNo: before.lineNo,
      source: before.source,
      sourceRow: before.sourceRow,
      now,
    });
    return { before, after: { ...after, createdAt: before.createdAt } };
  }

  /**
   * New lines for an import, which replaces every line. Duplicate decisions were taken by the
   * import selection, so none are checked here.
   */
  buildImportedLines(
    imported: readonly ImportedLine[],
    ids: IdGenerator,
    now: Date,
  ): ContractLine[] {
    this.assertDraft();
    return imported.map((values, index) =>
      toLine(values, {
        id: ids.next(),
        lineNo: index + 1,
        source: 'import',
        sourceRow: values.sourceRow,
        now,
      }),
    );
  }

  /** Approval is final and needs at least one priced item. */
  assertApprovable(): void {
    this.assertDraft();
    if (this.items.length === 0) {
      throw conflict('A contract needs at least one priced item to be approved', 'NO_PRICED_ITEMS');
    }
  }

  private assertCodeAllowed(code: string, exceptLineId: string | null, accepted: boolean): void {
    const taken = this.lines.some((line) => line.code === code && line.id !== exceptLineId);
    if (taken && !accepted) {
      throw conflict(
        `Duplicate item codes must be accepted explicitly: ${code}`,
        'DUPLICATE_CODE',
        { codes: [code] },
      );
    }
  }
}

function toLine(
  values: LineValues,
  meta: { id: string; lineNo: number; source: ContractSource; sourceRow: number | null; now: Date },
): ContractLine {
  const common = {
    id: meta.id,
    lineNo: meta.lineNo,
    code: values.code,
    source: meta.source,
    sourceRow: meta.sourceRow,
    createdAt: meta.now,
    updatedAt: meta.now,
  };
  if (values.kind === 'heading') {
    const description = values.description?.trim() ? values.description.trim() : null;
    return {
      ...common,
      kind: 'heading',
      description,
      unit: null,
      quantity: null,
      unitPrice: null,
      workType: null,
    };
  }
  return {
    ...common,
    kind: 'item',
    description: values.description,
    unit: values.unit,
    quantity: values.quantity,
    unitPrice: values.unitPrice,
    workType: values.workType,
  };
}
