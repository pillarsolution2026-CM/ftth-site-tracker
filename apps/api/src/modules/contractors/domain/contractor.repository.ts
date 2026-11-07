import type { EventLog } from '../../../common/event-log.port.js';
import type { Decimal } from '../../work-orders/domain/decimal.js';
import type {
  ContractorPatch,
  ContractorRecord,
  ContractorSummary,
  NewImportFile,
  NewLine,
  NewPrice,
  NewRegistration,
  Registration,
  ScopeHolding,
  WorkOrderLine,
} from './contractor.js';

/** The shared list of contractors. */
export interface ContractorRepository {
  /** By name. */
  list(): Promise<ContractorSummary[]>;
  /** `lock` takes a row lock (SELECT … FOR UPDATE) for the rest of the transaction. */
  findById(contractorId: string, options?: { lock?: boolean }): Promise<ContractorSummary | null>;
  /** CONFLICT CONTRACTOR_NAME_TAKEN when the name exists (ignoring case and outer spaces). */
  insert(contractor: ContractorRecord): Promise<void>;
  /** Applies the patch, bumps `version`, returns the stored row. CONFLICT CONTRACTOR_NAME_TAKEN. */
  update(contractorId: string, patch: ContractorPatch): Promise<ContractorRecord>;
}

/**
 * Registrations of contractors on a project's work order. Every method filters by `projectId`:
 * an id from another project is simply "not found" (IDOR defence).
 */
export interface RegistrationRepository {
  /** The project's work order id; `lock` takes its row lock, which serialises contractor writes. */
  workOrderOf(projectId: string, options?: { lock?: boolean }): Promise<string | null>;
  /** Every line of the work order, in line order. */
  workOrderLines(workOrderId: string): Promise<WorkOrderLine[]>;
  /** Per work-order line and scope: Σ quantity and highest price, over every contractor. */
  holdings(workOrderId: string): Promise<ScopeHolding[]>;
  /** Registrations with lines and full price history, oldest registration first. */
  list(projectId: string): Promise<Registration[]>;
  find(projectId: string, registrationId: string): Promise<Registration | null>;
  isRegistered(workOrderId: string, contractorId: string): Promise<boolean>;
  /** Registration, lines and each line's first price. CONFLICT on a race with the DB rules. */
  insert(registration: NewRegistration): Promise<void>;
  /** Records an uploaded sheet of the registration (the stored object exists already). */
  insertFile(file: NewImportFile): Promise<void>;
  /** Removes the registration with its lines and prices. */
  delete(projectId: string, registrationId: string): Promise<void>;
  /** The line with its first price. */
  insertLine(projectId: string, registrationId: string, line: NewLine): Promise<void>;
  updateLineQuantity(projectId: string, lineId: string, quantity: Decimal): Promise<void>;
  /** Removes the line with its prices. */
  deleteLine(projectId: string, lineId: string): Promise<void>;
  insertPrice(projectId: string, lineId: string, price: NewPrice): Promise<void>;
}

/** Repositories and event log bound to one database transaction. */
export interface ContractorTx {
  contractors: ContractorRepository;
  registrations: RegistrationRepository;
  events: EventLog;
}

export interface ContractorUnitOfWork {
  run<T>(work: (tx: ContractorTx) => Promise<T>): Promise<T>;
}
