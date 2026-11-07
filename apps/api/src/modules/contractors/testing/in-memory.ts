import { AppError } from '../../../common/app-error.js';
import type { DomainEventInput, EventLog } from '../../../common/event-log.port.js';
import { Decimal } from '../../work-orders/domain/decimal.js';
import type {
  ContractorLine,
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
} from '../domain/contractor.js';
import type {
  ContractorRepository,
  ContractorTx,
  ContractorUnitOfWork,
  RegistrationRepository,
} from '../domain/contractor.repository.js';

export class InMemoryEvents implements EventLog {
  readonly events: DomainEventInput[] = [];
  async append(event: DomainEventInput): Promise<void> {
    this.events.push(event);
  }
  types(): string[] {
    return this.events.map((event) => event.type);
  }
}

export class InMemoryContractors implements ContractorRepository {
  readonly rows = new Map<string, ContractorRecord>();

  constructor(private readonly registrations: InMemoryRegistrations) {}

  private summary(row: ContractorRecord): ContractorSummary {
    return { ...row, workOrderCount: this.registrations.countFor(row.id) };
  }
  private nameTaken(name: string, exceptId?: string): boolean {
    const key = name.trim().toLowerCase();
    return [...this.rows.values()].some(
      (row) => row.id !== exceptId && row.name.trim().toLowerCase() === key,
    );
  }
  async list(): Promise<ContractorSummary[]> {
    return [...this.rows.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => this.summary(row));
  }
  async findById(contractorId: string): Promise<ContractorSummary | null> {
    const row = this.rows.get(contractorId);
    return row ? this.summary(row) : null;
  }
  async insert(contractor: ContractorRecord): Promise<void> {
    if (this.nameTaken(contractor.name)) {
      throw new AppError('CONFLICT', 'name taken', { reason: 'CONTRACTOR_NAME_TAKEN' });
    }
    this.rows.set(contractor.id, contractor);
  }
  async update(contractorId: string, patch: ContractorPatch): Promise<ContractorRecord> {
    const row = this.rows.get(contractorId);
    if (!row) throw new AppError('NOT_FOUND', 'Contractor not found');
    if (patch.name !== undefined && this.nameTaken(patch.name, contractorId)) {
      throw new AppError('CONFLICT', 'name taken', { reason: 'CONTRACTOR_NAME_TAKEN' });
    }
    const updated = { ...row, ...patch, version: row.version + 1 };
    this.rows.set(contractorId, updated);
    return updated;
  }
}

/** Work orders (one per project) with their lines, and the contractor registrations on them. */
export class InMemoryRegistrations implements RegistrationRepository {
  /** project id → work order id. */
  readonly workOrders = new Map<string, string>();
  /** work order id → lines. */
  readonly lines = new Map<string, WorkOrderLine[]>();
  readonly rows = new Map<string, Registration>();
  /** Project ids whose work order was locked, in order. */
  readonly locked: string[] = [];
  contractors: InMemoryContractors | null = null;

  countFor(contractorId: string): number {
    return [...this.rows.values()].filter((r) => r.contractor.id === contractorId).length;
  }
  async workOrderOf(projectId: string, options?: { lock?: boolean }): Promise<string | null> {
    if (options?.lock) this.locked.push(projectId);
    return this.workOrders.get(projectId) ?? null;
  }
  async workOrderLines(workOrderId: string): Promise<WorkOrderLine[]> {
    return this.lines.get(workOrderId) ?? [];
  }
  async holdings(workOrderId: string): Promise<ScopeHolding[]> {
    const holdings: ScopeHolding[] = [];
    for (const registration of this.rows.values()) {
      if (registration.workOrderId !== workOrderId) continue;
      for (const line of registration.lines) {
        const highest = line.prices.reduce(
          (max, price) => (price.unitPrice.compare(max) > 0 ? price.unitPrice : max),
          Decimal.zero,
        );
        const found = holdings.find(
          (holding) =>
            holding.workOrderItemId === line.item.id &&
            (holding.scopeKey ?? '') === (line.scopeKey ?? ''),
        );
        if (found) {
          found.quantity = found.quantity.add(line.quantity);
          if (highest.compare(found.highestPrice) > 0) found.highestPrice = highest;
        } else {
          holdings.push({
            workOrderItemId: line.item.id,
            scopeKey: line.scopeKey,
            scope: line.scope,
            quantity: line.quantity,
            highestPrice: highest,
          });
        }
      }
    }
    return holdings;
  }
  async list(projectId: string): Promise<Registration[]> {
    return [...this.rows.values()].filter((r) => r.projectId === projectId);
  }
  async find(projectId: string, registrationId: string): Promise<Registration | null> {
    const registration = this.rows.get(registrationId);
    return registration?.projectId === projectId ? registration : null;
  }
  async isRegistered(workOrderId: string, contractorId: string): Promise<boolean> {
    return [...this.rows.values()].some(
      (r) => r.workOrderId === workOrderId && r.contractor.id === contractorId,
    );
  }
  async insert(registration: NewRegistration): Promise<void> {
    const contractor = this.contractors?.rows.get(registration.contractorId);
    if (!contractor) throw new AppError('NOT_FOUND', 'Contractor not found');
    this.rows.set(registration.id, {
      id: registration.id,
      projectId: registration.projectId,
      workOrderId: registration.workOrderId,
      contractor,
      registeredOn: registration.registeredOn,
      lines: registration.lines.map((line) => this.toLine(registration.workOrderId, line)),
      files: [],
      createdById: registration.createdById,
      createdAt: new Date(),
    });
  }
  async insertFile(file: NewImportFile): Promise<void> {
    const registration = await this.find(file.projectId, file.registrationId);
    if (!registration) throw new AppError('NOT_FOUND', 'Contractor registration not found');
    registration.files.push({
      id: file.id,
      fileName: file.fileName,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      storageKey: file.storageKey,
      uploadedById: file.uploadedById,
      createdAt: new Date(),
    });
  }
  async delete(projectId: string, registrationId: string): Promise<void> {
    if (!(await this.find(projectId, registrationId))) {
      throw new AppError('NOT_FOUND', 'Contractor registration not found');
    }
    this.rows.delete(registrationId);
  }
  async insertLine(projectId: string, registrationId: string, line: NewLine): Promise<void> {
    const registration = await this.find(projectId, registrationId);
    if (!registration) throw new AppError('NOT_FOUND', 'Contractor registration not found');
    registration.lines.push(this.toLine(registration.workOrderId, line));
  }
  async updateLineQuantity(projectId: string, lineId: string, quantity: Decimal): Promise<void> {
    // Replace, never mutate: a use case may still hold the line it read (the database returns copies).
    for (const registration of this.rows.values()) {
      if (registration.projectId !== projectId) continue;
      const index = registration.lines.findIndex((candidate) => candidate.id === lineId);
      const current = registration.lines[index];
      if (current) {
        registration.lines[index] = { ...current, quantity };
        return;
      }
    }
    throw new AppError('NOT_FOUND', 'Contractor line not found');
  }
  async deleteLine(projectId: string, lineId: string): Promise<void> {
    for (const registration of this.rows.values()) {
      if (registration.projectId !== projectId) continue;
      const index = registration.lines.findIndex((line) => line.id === lineId);
      if (index >= 0) {
        registration.lines.splice(index, 1);
        return;
      }
    }
    throw new AppError('NOT_FOUND', 'Contractor line not found');
  }
  async insertPrice(projectId: string, lineId: string, price: NewPrice): Promise<void> {
    this.findLine(projectId, lineId).prices.push({ ...price, createdAt: new Date() });
  }

  private findLine(projectId: string, lineId: string): ContractorLine {
    for (const registration of this.rows.values()) {
      if (registration.projectId !== projectId) continue;
      const line = registration.lines.find((candidate) => candidate.id === lineId);
      if (line) return line;
    }
    throw new AppError('NOT_FOUND', 'Contractor line not found');
  }
  private toLine(workOrderId: string, line: NewLine): ContractorLine {
    const item = this.lines
      .get(workOrderId)
      ?.find((candidate) => candidate.id === line.workOrderItemId);
    if (!item) throw new Error('test setup: unknown work-order line');
    return {
      id: line.id,
      quantity: line.quantity,
      scope: line.scope,
      scopeKey: line.scopeKey,
      sourceRow: line.sourceRow,
      item,
      prices: [{ ...line.firstPrice, createdAt: new Date() }],
    };
  }
}

/** Not transactional: a use case that throws leaves its earlier writes in place. */
export class InMemoryContractorUnitOfWork implements ContractorUnitOfWork {
  readonly registrations = new InMemoryRegistrations();
  readonly contractors = new InMemoryContractors(this.registrations);
  readonly events = new InMemoryEvents();

  constructor() {
    this.registrations.contractors = this.contractors;
  }

  async run<T>(work: (tx: ContractorTx) => Promise<T>): Promise<T> {
    return work({
      contractors: this.contractors,
      registrations: this.registrations,
      events: this.events,
    });
  }
}
