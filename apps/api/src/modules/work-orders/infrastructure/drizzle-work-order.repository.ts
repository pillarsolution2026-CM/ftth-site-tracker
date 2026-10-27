import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import { AppError } from '../../../common/app-error.js';
import type { DbHandle } from '../../../db/db.module.js';
import { uniqueViolation } from '../../../db/pg-errors.js';
import { workOrderAttachments, workOrderItems, workOrders } from '../../../db/schema.js';
import { Decimal } from '../domain/decimal.js';
import {
  WorkOrder,
  type HeaderPatch,
  type WorkOrderHeader,
  type WorkOrderItem,
} from '../domain/work-order.js';
import type { WorkOrderRepository, WorkOrderSummary } from '../domain/work-order.repository.js';

type OrderRow = typeof workOrders.$inferSelect;
type ItemRow = typeof workOrderItems.$inferSelect;

const INSERT_CHUNK = 500;

const toHeader = (row: OrderRow): WorkOrderHeader => ({
  id: row.id,
  projectId: row.projectId,
  number: row.number,
  title: row.title,
  issuedOn: row.issuedOn,
  notes: row.notes,
  currency: row.currency,
  source: row.source,
  version: row.version,
  createdById: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toItem = (row: ItemRow): WorkOrderItem => ({
  id: row.id,
  lineNo: row.lineNo,
  code: row.code,
  description: row.description,
  unit: row.unit,
  quantity: Decimal.parse(row.quantity),
  unitPrice: Decimal.parse(row.unitPrice),
  source: row.source,
  sourceRow: row.sourceRow,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const itemValues = (projectId: string, workOrderId: string, item: WorkOrderItem) => ({
  id: item.id,
  projectId,
  workOrderId,
  lineNo: item.lineNo,
  code: item.code,
  description: item.description,
  unit: item.unit,
  quantity: item.quantity.toString(),
  unitPrice: item.unitPrice.toString(),
  source: item.source,
  sourceRow: item.sourceRow,
});

/** Maps the two unique constraints that matter to client-visible conflicts. */
function translateConflict(error: unknown): never {
  const constraint = uniqueViolation(error);
  if (constraint === 'work_orders_project_number_key') {
    throw new AppError('CONFLICT', 'Work order number is already used in this project', {
      reason: 'NUMBER_TAKEN',
    });
  }
  if (constraint === 'work_order_items_line_no_key') {
    throw new AppError('CONFLICT', 'Line number is already used', { reason: 'LINE_TAKEN' });
  }
  throw error;
}

export class DrizzleWorkOrderRepository implements WorkOrderRepository {
  constructor(private readonly db: DbHandle) {}

  async listSummaries(projectId: string): Promise<WorkOrderSummary[]> {
    const rows = await this.db
      .select({
        order: getTableColumns(workOrders),
        itemCount: sql<number>`count(${workOrderItems.id})::int`,
        total: sql<string>`coalesce(sum(${workOrderItems.amount}), 0)::text`,
        attachmentCount: sql<number>`(
          select count(*)::int from ${workOrderAttachments}
          where ${workOrderAttachments.workOrderId} = ${workOrders.id})`,
      })
      .from(workOrders)
      .leftJoin(workOrderItems, eq(workOrderItems.workOrderId, workOrders.id))
      .where(eq(workOrders.projectId, projectId))
      .groupBy(workOrders.id)
      .orderBy(asc(workOrders.number));
    return rows.map((row) => ({
      header: toHeader(row.order),
      itemCount: row.itemCount,
      total: Decimal.parse(row.total),
      attachmentCount: row.attachmentCount,
    }));
  }

  async exists(projectId: string, workOrderId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(and(eq(workOrders.projectId, projectId), eq(workOrders.id, workOrderId)));
    return row !== undefined;
  }

  async findById(
    projectId: string,
    workOrderId: string,
    options?: { lock?: boolean },
  ): Promise<WorkOrder | null> {
    const query = this.db
      .select()
      .from(workOrders)
      .where(and(eq(workOrders.projectId, projectId), eq(workOrders.id, workOrderId)));
    const [row] = await (options?.lock ? query.for('update') : query);
    if (!row) return null;
    const items = await this.db
      .select()
      .from(workOrderItems)
      .where(
        and(eq(workOrderItems.projectId, projectId), eq(workOrderItems.workOrderId, workOrderId)),
      )
      .orderBy(asc(workOrderItems.lineNo));
    return new WorkOrder(toHeader(row), items.map(toItem));
  }

  async insert(order: WorkOrder): Promise<void> {
    const { header } = order;
    try {
      await this.db.insert(workOrders).values({
        id: header.id,
        projectId: header.projectId,
        number: header.number,
        title: header.title,
        issuedOn: header.issuedOn,
        notes: header.notes,
        currency: header.currency,
        source: header.source,
        version: header.version,
        createdBy: header.createdById,
      });
      for (let start = 0; start < order.items.length; start += INSERT_CHUNK) {
        const chunk = order.items.slice(start, start + INSERT_CHUNK);
        await this.db
          .insert(workOrderItems)
          .values(chunk.map((item) => itemValues(header.projectId, header.id, item)));
      }
    } catch (error) {
      translateConflict(error);
    }
  }

  async updateHeader(
    projectId: string,
    workOrderId: string,
    patch: HeaderPatch,
  ): Promise<WorkOrderHeader> {
    try {
      const [row] = await this.db
        .update(workOrders)
        .set({ ...patch, version: sql`${workOrders.version} + 1` })
        .where(and(eq(workOrders.projectId, projectId), eq(workOrders.id, workOrderId)))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 'Work order not found');
      return toHeader(row);
    } catch (error) {
      if (error instanceof AppError) throw error;
      return translateConflict(error);
    }
  }

  async delete(projectId: string, workOrderId: string): Promise<void> {
    await this.db
      .delete(workOrders)
      .where(and(eq(workOrders.projectId, projectId), eq(workOrders.id, workOrderId)));
  }

  async insertItem(projectId: string, workOrderId: string, item: WorkOrderItem): Promise<void> {
    try {
      await this.db.insert(workOrderItems).values(itemValues(projectId, workOrderId, item));
    } catch (error) {
      translateConflict(error);
    }
    await this.bumpVersion(projectId, workOrderId);
  }

  async updateItem(projectId: string, workOrderId: string, item: WorkOrderItem): Promise<void> {
    const values = itemValues(projectId, workOrderId, item);
    const updated = await this.db
      .update(workOrderItems)
      .set({
        code: values.code,
        description: values.description,
        unit: values.unit,
        quantity: values.quantity,
        unitPrice: values.unitPrice,
      })
      .where(
        and(
          eq(workOrderItems.projectId, projectId),
          eq(workOrderItems.workOrderId, workOrderId),
          eq(workOrderItems.id, item.id),
        ),
      )
      .returning({ id: workOrderItems.id });
    if (updated.length === 0) throw new AppError('NOT_FOUND', 'Work order item not found');
    await this.bumpVersion(projectId, workOrderId);
  }

  async deleteItem(projectId: string, workOrderId: string, itemId: string): Promise<void> {
    const deleted = await this.db
      .delete(workOrderItems)
      .where(
        and(
          eq(workOrderItems.projectId, projectId),
          eq(workOrderItems.workOrderId, workOrderId),
          eq(workOrderItems.id, itemId),
        ),
      )
      .returning({ id: workOrderItems.id });
    if (deleted.length === 0) throw new AppError('NOT_FOUND', 'Work order item not found');
    await this.bumpVersion(projectId, workOrderId);
  }

  private async bumpVersion(projectId: string, workOrderId: string): Promise<void> {
    await this.db
      .update(workOrders)
      .set({ version: sql`${workOrders.version} + 1` })
      .where(and(eq(workOrders.projectId, projectId), eq(workOrders.id, workOrderId)));
  }
}
