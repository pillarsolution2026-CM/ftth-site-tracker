import type { AttachmentKind } from '@ftth/shared';
import type { EventLog } from '../../../common/event-log.port.js';
import type { ApprovedContract, Reservations } from './contract-lines.js';
import type { Decimal } from './decimal.js';
import type { HeaderPatch, WorkOrder, WorkOrderHeader, WorkOrderItem } from './work-order.js';

export interface WorkOrderSummary {
  header: WorkOrderHeader;
  itemCount: number;
  total: Decimal;
  attachmentCount: number;
}

export interface WorkOrderAttachment {
  id: string;
  projectId: string;
  workOrderId: string;
  kind: AttachmentKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  uploadedById: string | null;
  createdAt: Date;
}

/**
 * Every method filters by `projectId`: an id from another project is simply "not found" (IDOR
 * defence). Item writes bump the order's `version` in the same statement batch.
 */
export interface WorkOrderRepository {
  listSummaries(projectId: string): Promise<WorkOrderSummary[]>;
  exists(projectId: string, workOrderId: string): Promise<boolean>;
  /** True when the project already has its (single) work order. */
  existsForProject(projectId: string): Promise<boolean>;
  /** Line of the project's work order for each contract item it uses: contract item id → line id. */
  lineIdsByContractItem(projectId: string): Promise<Map<string, string>>;
  /** `lock` takes a row lock (SELECT … FOR UPDATE) for the rest of the transaction. */
  findById(
    projectId: string,
    workOrderId: string,
    options?: { lock?: boolean },
  ): Promise<WorkOrder | null>;
  /** Throws AppError CONFLICT when the number is taken in the project. */
  insert(order: WorkOrder): Promise<void>;
  /** Applies the patch, bumps `version`, returns the stored header. CONFLICT when the number is taken. */
  updateHeader(
    projectId: string,
    workOrderId: string,
    patch: HeaderPatch,
  ): Promise<WorkOrderHeader>;
  delete(projectId: string, workOrderId: string): Promise<void>;
  insertItem(projectId: string, workOrderId: string, item: WorkOrderItem): Promise<void>;
  updateItem(projectId: string, workOrderId: string, item: WorkOrderItem): Promise<void>;
  deleteItem(projectId: string, workOrderId: string, itemId: string): Promise<void>;
}

export interface WorkOrderAttachmentRepository {
  listByWorkOrder(projectId: string, workOrderId: string): Promise<WorkOrderAttachment[]>;
  find(
    projectId: string,
    workOrderId: string,
    attachmentId: string,
  ): Promise<WorkOrderAttachment | null>;
  insert(attachment: WorkOrderAttachment): Promise<void>;
  delete(projectId: string, workOrderId: string, attachmentId: string): Promise<void>;
}

/**
 * Read-only view of the project's contract (ADR-028), supplied by an adapter so the work-orders
 * module never touches the contracts module's internals.
 */
export interface ContractCatalog {
  /**
   * The project's approved contract with its priced items in line order. `lock` takes the contract
   * row lock (SELECT … FOR UPDATE) for the rest of the transaction, which serialises concurrent
   * reservations. Throws AppError CONFLICT NO_CONTRACT / CONTRACT_NOT_APPROVED.
   */
  loadApproved(projectId: string, options?: { lock?: boolean }): Promise<ApprovedContract>;
  /** Σ quantity of every work-order line of each contract item, over all projects. */
  reservations(contractId: string): Promise<Reservations>;
}

/** Repositories and event log bound to one database transaction. */
export interface WorkOrderTx {
  orders: WorkOrderRepository;
  attachments: WorkOrderAttachmentRepository;
  contracts: ContractCatalog;
  events: EventLog;
}

export interface WorkOrderUnitOfWork {
  run<T>(work: (tx: WorkOrderTx) => Promise<T>): Promise<T>;
}
