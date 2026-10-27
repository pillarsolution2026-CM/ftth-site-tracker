import { AppError } from '../../../common/app-error.js';
import type { DomainEventInput, EventLog } from '../../../common/event-log.port.js';
import type { ProjectCurrencyLookup } from '../application/ports.js';
import {
  WorkOrder,
  type HeaderPatch,
  type WorkOrderHeader,
  type WorkOrderItem,
} from '../domain/work-order.js';
import type {
  WorkOrderAttachment,
  WorkOrderAttachmentRepository,
  WorkOrderRepository,
  WorkOrderSummary,
  WorkOrderTx,
  WorkOrderUnitOfWork,
} from '../domain/work-order.repository.js';
import { sumDecimals } from '../domain/decimal.js';
import { itemAmount } from '../domain/work-order.js';

export class InMemoryEvents implements EventLog {
  readonly events: DomainEventInput[] = [];
  async append(event: DomainEventInput): Promise<void> {
    this.events.push(event);
  }
  types(): string[] {
    return this.events.map((event) => event.type);
  }
}

export class InMemoryWorkOrders implements WorkOrderRepository {
  readonly orders = new Map<string, WorkOrder>();

  async listSummaries(projectId: string): Promise<WorkOrderSummary[]> {
    return [...this.orders.values()]
      .filter((order) => order.header.projectId === projectId)
      .map((order) => ({
        header: order.header,
        itemCount: order.items.length,
        total: sumDecimals(order.items.map(itemAmount)),
        attachmentCount: 0,
      }));
  }
  async exists(projectId: string, workOrderId: string): Promise<boolean> {
    return this.orders.get(workOrderId)?.header.projectId === projectId;
  }
  async findById(projectId: string, workOrderId: string): Promise<WorkOrder | null> {
    const order = this.orders.get(workOrderId);
    return order?.header.projectId === projectId ? order : null;
  }
  async insert(order: WorkOrder): Promise<void> {
    const taken = [...this.orders.values()].some(
      (other) =>
        other.header.projectId === order.header.projectId &&
        other.header.number === order.header.number,
    );
    if (taken) throw new AppError('CONFLICT', 'number taken', { reason: 'NUMBER_TAKEN' });
    this.orders.set(order.header.id, order);
  }
  async updateHeader(
    projectId: string,
    workOrderId: string,
    patch: HeaderPatch,
  ): Promise<WorkOrderHeader> {
    const order = await this.findById(projectId, workOrderId);
    if (!order) throw new AppError('NOT_FOUND', 'Work order not found');
    const header = { ...order.header, ...patch, version: order.header.version + 1 };
    this.orders.set(workOrderId, new WorkOrder(header, order.items));
    return header;
  }
  async delete(projectId: string, workOrderId: string): Promise<void> {
    if (await this.exists(projectId, workOrderId)) this.orders.delete(workOrderId);
  }
  async insertItem(projectId: string, workOrderId: string, item: WorkOrderItem): Promise<void> {
    await this.replaceItems(projectId, workOrderId, (items) => [...items, item]);
  }
  async updateItem(projectId: string, workOrderId: string, item: WorkOrderItem): Promise<void> {
    await this.replaceItems(projectId, workOrderId, (items) =>
      items.map((existing) => (existing.id === item.id ? item : existing)),
    );
  }
  async deleteItem(projectId: string, workOrderId: string, itemId: string): Promise<void> {
    await this.replaceItems(projectId, workOrderId, (items) =>
      items.filter((existing) => existing.id !== itemId),
    );
  }
  private async replaceItems(
    projectId: string,
    workOrderId: string,
    change: (items: readonly WorkOrderItem[]) => WorkOrderItem[],
  ): Promise<void> {
    const order = await this.findById(projectId, workOrderId);
    if (!order) throw new AppError('NOT_FOUND', 'Work order not found');
    const header = { ...order.header, version: order.header.version + 1 };
    this.orders.set(workOrderId, new WorkOrder(header, change(order.items)));
  }
}

export class InMemoryAttachments implements WorkOrderAttachmentRepository {
  readonly rows: WorkOrderAttachment[] = [];
  async listByWorkOrder(projectId: string, workOrderId: string): Promise<WorkOrderAttachment[]> {
    return this.rows.filter((a) => a.projectId === projectId && a.workOrderId === workOrderId);
  }
  async find(
    projectId: string,
    workOrderId: string,
    id: string,
  ): Promise<WorkOrderAttachment | null> {
    return (await this.listByWorkOrder(projectId, workOrderId)).find((a) => a.id === id) ?? null;
  }
  async insert(attachment: WorkOrderAttachment): Promise<void> {
    this.rows.push(attachment);
  }
  async delete(projectId: string, workOrderId: string, id: string): Promise<void> {
    const index = this.rows.findIndex(
      (a) => a.projectId === projectId && a.workOrderId === workOrderId && a.id === id,
    );
    if (index >= 0) this.rows.splice(index, 1);
  }
}

/** Not transactional; `failOnCommit` simulates a transaction that fails after the work was done. */
export class InMemoryWorkOrderUnitOfWork implements WorkOrderUnitOfWork {
  readonly orders = new InMemoryWorkOrders();
  readonly attachments = new InMemoryAttachments();
  readonly events = new InMemoryEvents();
  failOnCommit: Error | null = null;

  async run<T>(work: (tx: WorkOrderTx) => Promise<T>): Promise<T> {
    const result = await work({
      orders: this.orders,
      attachments: this.attachments,
      events: this.events,
    });
    if (this.failOnCommit) throw this.failOnCommit;
    return result;
  }
}

export const fixedCurrency = (currency: string): ProjectCurrencyLookup => ({
  currencyOf: async () => currency,
});
