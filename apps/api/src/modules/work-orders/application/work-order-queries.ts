import { AppError } from '../../../common/app-error.js';
import { availableQuantity, reservedOf, type ContractItemInfo } from '../domain/contract-lines.js';
import type { Decimal } from '../domain/decimal.js';
import type {
  ContractCatalog,
  WorkOrderAttachment,
  WorkOrderAttachmentRepository,
  WorkOrderRepository,
  WorkOrderSummary,
} from '../domain/work-order.repository.js';
import type { WorkOrder } from '../domain/work-order.js';

export interface WorkOrderView {
  order: WorkOrder;
  attachments: WorkOrderAttachment[];
}

export class ListWorkOrdersUseCase {
  constructor(private readonly orders: WorkOrderRepository) {}

  execute(projectId: string): Promise<WorkOrderSummary[]> {
    return this.orders.listSummaries(projectId);
  }
}

export class GetWorkOrderUseCase {
  constructor(
    private readonly orders: WorkOrderRepository,
    private readonly attachments: WorkOrderAttachmentRepository,
  ) {}

  async execute(projectId: string, workOrderId: string): Promise<WorkOrderView> {
    const order = await this.orders.findById(projectId, workOrderId);
    if (!order) throw new AppError('NOT_FOUND', 'Work order not found');
    return { order, attachments: await this.attachments.listByWorkOrder(projectId, workOrderId) };
  }
}

export interface ContractItemAvailabilityRow {
  item: ContractItemInfo;
  reserved: Decimal;
  available: Decimal;
  /** This project's line using the item, if any. */
  workOrderItemId: string | null;
}

export interface ContractItemAvailabilityView {
  contractId: string;
  contractNumber: string;
  rows: ContractItemAvailabilityRow[];
}

/** Line picker: priced items of the approved contract with contract, reserved and available quantity. */
export class ListContractItemAvailabilityUseCase {
  constructor(
    private readonly contracts: ContractCatalog,
    private readonly orders: WorkOrderRepository,
  ) {}

  async execute(projectId: string): Promise<ContractItemAvailabilityView> {
    const contract = await this.contracts.loadApproved(projectId);
    const reservations = await this.contracts.reservations(contract.id);
    const lineIds = await this.orders.lineIdsByContractItem(projectId);
    return {
      contractId: contract.id,
      contractNumber: contract.number,
      rows: contract.items.map((item) => {
        const reserved = reservedOf(reservations, item.id);
        return {
          item,
          reserved,
          available: availableQuantity(item, reserved),
          workOrderItemId: lineIds.get(item.id) ?? null,
        };
      }),
    };
  }
}
