import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '../../../common/app-error.js';
import type { DbHandle } from '../../../db/db.module.js';
import { triggerViolationMessage, uniqueViolation } from '../../../db/pg-errors.js';
import {
  contractorImportFiles,
  contractorLinePrices,
  contractorLines,
  contractorRegistrations,
  contractors,
  workOrderItems,
  workOrders,
} from '../../../db/schema.js';
import { Decimal } from '../../work-orders/domain/decimal.js';
import type {
  ContractorImportFile,
  ContractorLine,
  ContractorPrice,
  NewImportFile,
  NewLine,
  NewPrice,
  NewRegistration,
  Registration,
  ScopeHolding,
  WorkOrderLine,
} from '../domain/contractor.js';
import type { RegistrationRepository } from '../domain/contractor.repository.js';

type ItemRow = typeof workOrderItems.$inferSelect;
type PriceRow = typeof contractorLinePrices.$inferSelect;

const INSERT_CHUNK = 500;

const toWorkOrderLine = (row: ItemRow): WorkOrderLine => ({
  id: row.id,
  lineNo: row.lineNo,
  code: row.code,
  description: row.description,
  unit: row.unit,
  workType: row.workType ?? null,
  unitPrice: Decimal.parse(row.unitPrice),
  quantity: Decimal.parse(row.quantity),
  contractItemId: row.contractItemId,
});

const toPrice = (row: PriceRow): ContractorPrice => ({
  id: row.id,
  effectiveFrom: row.effectiveFrom,
  unitPrice: Decimal.parse(row.unitPrice),
  createdById: row.createdBy,
  createdAt: row.createdAt,
});

const numbersIn = (message: string, pattern: RegExp): string[] | null => {
  const match = pattern.exec(message);
  return match ? match.slice(1).map((n) => Decimal.parse(n).toString()) : null;
};

/**
 * Safety net: maps the trigger messages and constraints of migration 0013 to the conflict reasons
 * a client understands, when the application checks were bypassed or raced.
 */
function translate(error: unknown, workOrderItemId?: string): never {
  if (error instanceof AppError) throw error;
  const message = triggerViolationMessage(error);
  if (message !== null) {
    if (message.includes('above the work-order quantity')) {
      const found = numbersIn(
        message,
        /work order ([\d.]+), reserved ([\d.]+), requested ([\d.]+)/,
      );
      const [workOrderQuantity, reservedQuantity, requestedQuantity] = found ?? [];
      throw new AppError('CONFLICT', 'The quantity is above what is left of the work-order line', {
        reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
        workOrderItemId,
        workOrderQuantity,
        reservedQuantity,
        requestedQuantity,
        availableQuantity:
          workOrderQuantity !== undefined && reservedQuantity !== undefined
            ? Decimal.parse(workOrderQuantity).sub(Decimal.parse(reservedQuantity)).toString()
            : undefined,
      });
    }
    if (message.includes('above the contract price')) {
      const [contractPrice, otherScopesPrice, requestedPrice] =
        numbersIn(message, /contract ([\d.]+), other scopes ([\d.]+), requested ([\d.]+)/) ?? [];
      throw new AppError('CONFLICT', 'The price is above the contract price', {
        reason: 'PRICE_EXCEEDS_CONTRACT',
        workOrderItemId,
        contractPrice,
        otherScopesPrice,
        maxAllowedPrice:
          contractPrice !== undefined && otherScopesPrice !== undefined
            ? Decimal.parse(contractPrice).sub(Decimal.parse(otherScopesPrice)).toString()
            : undefined,
        requestedPrice,
      });
    }
    if (message.includes('after the latest price date')) {
      throw new AppError('CONFLICT', 'A new price must start after the latest price date', {
        reason: 'PRICE_DATE_NOT_AFTER_LATEST',
        latestEffectiveFrom: /\((\d{4}-\d{2}-\d{2})\)/.exec(message)?.[1],
      });
    }
    if (message.includes('whole and scoped')) {
      throw new AppError('CONFLICT', 'A line cannot be given both whole and by scope', {
        reason: 'WHOLE_AND_SCOPES_MIXED',
        workOrderItemId,
      });
    }
    if (message.includes('not a line of the registration')) {
      throw new AppError('CONFLICT', 'The line is not a line of the work order', {
        reason: 'LINE_NOT_IN_WORK_ORDER',
        workOrderItemId,
      });
    }
    if (message.includes('saved before ADR-028')) {
      throw new AppError('CONFLICT', 'The line was saved before contracts and cannot be assigned', {
        reason: 'LEGACY_ITEM',
        workOrderItemId,
      });
    }
  }
  const constraint = uniqueViolation(error);
  if (constraint === 'contractor_registrations_order_contractor_key') {
    throw new AppError('CONFLICT', 'The contractor is already registered on this work order', {
      reason: 'CONTRACTOR_ALREADY_REGISTERED',
    });
  }
  if (constraint === 'contractor_lines_registration_item_scope_key') {
    throw new AppError('CONFLICT', 'The contractor already has this line', {
      reason: 'LINE_REPEATED',
      workOrderItemId,
    });
  }
  if (constraint === 'contractor_line_prices_line_date_key') {
    throw new AppError('CONFLICT', 'A new price must start after the latest price date', {
      reason: 'PRICE_DATE_NOT_AFTER_LATEST',
    });
  }
  throw error;
}

export class DrizzleRegistrationRepository implements RegistrationRepository {
  constructor(private readonly db: DbHandle) {}

  async workOrderOf(projectId: string, options?: { lock?: boolean }): Promise<string | null> {
    const query = this.db
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(eq(workOrders.projectId, projectId));
    const [row] = await (options?.lock ? query.for('update') : query);
    return row?.id ?? null;
  }

  async workOrderLines(workOrderId: string): Promise<WorkOrderLine[]> {
    const rows = await this.db
      .select()
      .from(workOrderItems)
      .where(eq(workOrderItems.workOrderId, workOrderId))
      .orderBy(asc(workOrderItems.lineNo));
    return rows.map(toWorkOrderLine);
  }

  async holdings(workOrderId: string): Promise<ScopeHolding[]> {
    const own = eq(workOrderItems.workOrderId, workOrderId);
    const quantities = await this.db
      .select({
        itemId: contractorLines.workOrderItemId,
        scopeKey: contractorLines.scopeKey,
        scope: sql<
          string | null
        >`(array_agg(${contractorLines.scope} order by ${contractorLines.createdAt}, ${contractorLines.id}))[1]`,
        quantity: sql<string>`sum(${contractorLines.quantity})::text`,
        firstAt: sql<Date>`min(${contractorLines.createdAt})`,
        firstRow: sql<number>`coalesce(min(${contractorLines.sourceRow}), 0)::int`,
      })
      .from(contractorLines)
      .innerJoin(workOrderItems, eq(workOrderItems.id, contractorLines.workOrderItemId))
      .where(own)
      .groupBy(contractorLines.workOrderItemId, contractorLines.scopeKey);
    const highs = await this.db
      .select({
        itemId: contractorLines.workOrderItemId,
        scopeKey: contractorLines.scopeKey,
        highest: sql<string>`max(${contractorLinePrices.unitPrice})::text`,
      })
      .from(contractorLinePrices)
      .innerJoin(contractorLines, eq(contractorLines.id, contractorLinePrices.contractorLineId))
      .innerJoin(workOrderItems, eq(workOrderItems.id, contractorLines.workOrderItemId))
      .where(own)
      .groupBy(contractorLines.workOrderItemId, contractorLines.scopeKey);
    const highOf = new Map(
      highs.map((row) => [`${row.itemId}|${row.scopeKey ?? ''}`, row.highest]),
    );
    return quantities
      .map((row) => ({
        workOrderItemId: row.itemId,
        scopeKey: row.scopeKey,
        scope: row.scope,
        quantity: Decimal.parse(row.quantity),
        highestPrice: Decimal.parse(highOf.get(`${row.itemId}|${row.scopeKey ?? ''}`) ?? '0'),
        firstAt: new Date(row.firstAt).getTime(),
        firstRow: row.firstRow,
      }))
      .sort(
        (a, b) =>
          a.firstAt - b.firstAt ||
          a.firstRow - b.firstRow ||
          (a.scopeKey ?? '').localeCompare(b.scopeKey ?? ''),
      )
      .map((holding): ScopeHolding => ({
        workOrderItemId: holding.workOrderItemId,
        scopeKey: holding.scopeKey,
        scope: holding.scope,
        quantity: holding.quantity,
        highestPrice: holding.highestPrice,
      }));
  }

  list(projectId: string): Promise<Registration[]> {
    return this.load(projectId);
  }

  async find(projectId: string, registrationId: string): Promise<Registration | null> {
    return (await this.load(projectId, registrationId))[0] ?? null;
  }

  async isRegistered(workOrderId: string, contractorId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: contractorRegistrations.id })
      .from(contractorRegistrations)
      .where(
        and(
          eq(contractorRegistrations.workOrderId, workOrderId),
          eq(contractorRegistrations.contractorId, contractorId),
        ),
      );
    return row !== undefined;
  }

  async insert(registration: NewRegistration): Promise<void> {
    try {
      await this.db.insert(contractorRegistrations).values({
        id: registration.id,
        projectId: registration.projectId,
        workOrderId: registration.workOrderId,
        contractorId: registration.contractorId,
        registeredOn: registration.registeredOn,
        createdBy: registration.createdById,
      });
      for (let start = 0; start < registration.lines.length; start += INSERT_CHUNK) {
        for (const line of registration.lines.slice(start, start + INSERT_CHUNK)) {
          await this.insertLineRows(registration.projectId, registration.id, line);
        }
      }
    } catch (error) {
      translate(error);
    }
  }

  async delete(projectId: string, registrationId: string): Promise<void> {
    const deleted = await this.db
      .delete(contractorRegistrations)
      .where(
        and(
          eq(contractorRegistrations.projectId, projectId),
          eq(contractorRegistrations.id, registrationId),
        ),
      )
      .returning({ id: contractorRegistrations.id });
    if (deleted.length === 0) throw new AppError('NOT_FOUND', 'Contractor registration not found');
  }

  async insertFile(file: NewImportFile): Promise<void> {
    await this.db.insert(contractorImportFiles).values({
      id: file.id,
      projectId: file.projectId,
      registrationId: file.registrationId,
      fileName: file.fileName,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      storageKey: file.storageKey,
      uploadedBy: file.uploadedById,
    });
  }

  async insertLine(projectId: string, registrationId: string, line: NewLine): Promise<void> {
    try {
      await this.insertLineRows(projectId, registrationId, line);
    } catch (error) {
      translate(error, line.workOrderItemId);
    }
  }

  async updateLineQuantity(projectId: string, lineId: string, quantity: Decimal): Promise<void> {
    let updated: { id: string }[];
    try {
      updated = await this.db
        .update(contractorLines)
        .set({ quantity: quantity.toString() })
        .where(and(eq(contractorLines.projectId, projectId), eq(contractorLines.id, lineId)))
        .returning({ id: contractorLines.id });
    } catch (error) {
      translate(error);
    }
    if (updated.length === 0) throw new AppError('NOT_FOUND', 'Contractor line not found');
  }

  async deleteLine(projectId: string, lineId: string): Promise<void> {
    const deleted = await this.db
      .delete(contractorLines)
      .where(and(eq(contractorLines.projectId, projectId), eq(contractorLines.id, lineId)))
      .returning({ id: contractorLines.id });
    if (deleted.length === 0) throw new AppError('NOT_FOUND', 'Contractor line not found');
  }

  async insertPrice(projectId: string, lineId: string, price: NewPrice): Promise<void> {
    const [line] = await this.db
      .select({ id: contractorLines.id })
      .from(contractorLines)
      .where(and(eq(contractorLines.projectId, projectId), eq(contractorLines.id, lineId)));
    if (!line) throw new AppError('NOT_FOUND', 'Contractor line not found');
    try {
      await this.db.insert(contractorLinePrices).values({
        id: price.id,
        contractorLineId: lineId,
        effectiveFrom: price.effectiveFrom,
        unitPrice: price.unitPrice.toString(),
        createdBy: price.createdById,
      });
    } catch (error) {
      translate(error);
    }
  }

  private async insertLineRows(
    projectId: string,
    registrationId: string,
    line: NewLine,
  ): Promise<void> {
    await this.db.insert(contractorLines).values({
      id: line.id,
      projectId,
      registrationId,
      workOrderItemId: line.workOrderItemId,
      scope: line.scope,
      scopeKey: line.scopeKey,
      quantity: line.quantity.toString(),
      sourceRow: line.sourceRow,
    });
    await this.db.insert(contractorLinePrices).values({
      id: line.firstPrice.id,
      contractorLineId: line.id,
      effectiveFrom: line.firstPrice.effectiveFrom,
      unitPrice: line.firstPrice.unitPrice.toString(),
      createdBy: line.firstPrice.createdById,
    });
  }

  /** Registrations (one, or all of the project) with lines in work-order order and prices oldest first. */
  private async load(projectId: string, registrationId?: string): Promise<Registration[]> {
    const scope = registrationId
      ? and(
          eq(contractorRegistrations.projectId, projectId),
          eq(contractorRegistrations.id, registrationId),
        )
      : eq(contractorRegistrations.projectId, projectId);
    const registrations = await this.db
      .select({ registration: contractorRegistrations, contractor: contractors })
      .from(contractorRegistrations)
      .innerJoin(contractors, eq(contractors.id, contractorRegistrations.contractorId))
      .where(scope)
      .orderBy(
        asc(contractorRegistrations.registeredOn),
        asc(contractorRegistrations.createdAt),
        asc(contractorRegistrations.id),
      );
    if (registrations.length === 0) return [];
    const registrationIds = registrations.map((row) => row.registration.id);

    const lines = await this.db
      .select({ line: contractorLines, item: workOrderItems })
      .from(contractorLines)
      .innerJoin(workOrderItems, eq(workOrderItems.id, contractorLines.workOrderItemId))
      .where(inArray(contractorLines.registrationId, registrationIds))
      .orderBy(
        asc(workOrderItems.lineNo),
        asc(contractorLines.sourceRow),
        asc(contractorLines.createdAt),
        asc(contractorLines.id),
      );
    const files = await this.db
      .select()
      .from(contractorImportFiles)
      .where(inArray(contractorImportFiles.registrationId, registrationIds))
      .orderBy(asc(contractorImportFiles.createdAt), asc(contractorImportFiles.id));
    const prices =
      lines.length === 0
        ? []
        : await this.db
            .select()
            .from(contractorLinePrices)
            .where(
              inArray(
                contractorLinePrices.contractorLineId,
                lines.map((row) => row.line.id),
              ),
            )
            .orderBy(asc(contractorLinePrices.effectiveFrom));

    const pricesByLine = new Map<string, ContractorPrice[]>();
    for (const row of prices) {
      const list = pricesByLine.get(row.contractorLineId) ?? [];
      list.push(toPrice(row));
      pricesByLine.set(row.contractorLineId, list);
    }
    const linesByRegistration = new Map<string, ContractorLine[]>();
    for (const row of lines) {
      const list = linesByRegistration.get(row.line.registrationId) ?? [];
      list.push({
        id: row.line.id,
        quantity: Decimal.parse(row.line.quantity),
        scope: row.line.scope,
        scopeKey: row.line.scopeKey,
        sourceRow: row.line.sourceRow,
        item: toWorkOrderLine(row.item),
        prices: pricesByLine.get(row.line.id) ?? [],
      });
      linesByRegistration.set(row.line.registrationId, list);
    }

    return registrations.map(({ registration, contractor }) => ({
      id: registration.id,
      projectId: registration.projectId,
      workOrderId: registration.workOrderId,
      contractor: {
        id: contractor.id,
        name: contractor.name,
        contactName: contractor.contactName,
        contactPhone: contractor.contactPhone,
        commercialRegister: contractor.commercialRegister,
        taxCard: contractor.taxCard,
      },
      registeredOn: registration.registeredOn,
      lines: linesByRegistration.get(registration.id) ?? [],
      files: files
        .filter((file) => file.registrationId === registration.id)
        .map((file): ContractorImportFile => ({
          id: file.id,
          fileName: file.fileName,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          storageKey: file.storageKey,
          uploadedById: file.uploadedBy,
          createdAt: file.createdAt,
        })),
      createdById: registration.createdBy,
      createdAt: registration.createdAt,
    }));
  }
}
