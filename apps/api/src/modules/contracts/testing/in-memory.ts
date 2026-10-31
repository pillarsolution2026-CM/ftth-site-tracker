import { AppError } from '../../../common/app-error.js';
import type { DomainEventInput, EventLog } from '../../../common/event-log.port.js';
import { sumDecimals } from '../../work-orders/domain/decimal.js';
import {
  Contract,
  lineAmount,
  type ContractHeader,
  type ContractLine,
  type HeaderPatch,
} from '../domain/contract.js';
import type {
  ContractAttachment,
  ContractAttachmentRepository,
  ContractRepository,
  ContractSummaryRow,
  ContractTx,
  ContractUnitOfWork,
} from '../domain/contract.repository.js';

export class InMemoryEvents implements EventLog {
  readonly events: DomainEventInput[] = [];
  async append(event: DomainEventInput): Promise<void> {
    this.events.push(event);
  }
  types(): string[] {
    return this.events.map((event) => event.type);
  }
}

export class InMemoryContracts implements ContractRepository {
  readonly rows = new Map<string, Contract>();

  async list(): Promise<ContractSummaryRow[]> {
    return [...this.rows.values()].map((contract) => ({
      header: contract.header,
      itemCount: contract.items.length,
      total: sumDecimals(contract.items.flatMap((line) => lineAmount(line) ?? [])),
      projectCount: 0,
    }));
  }
  async exists(contractId: string): Promise<boolean> {
    return this.rows.has(contractId);
  }
  async findById(contractId: string): Promise<Contract | null> {
    return this.rows.get(contractId) ?? null;
  }
  async projectCount(): Promise<number> {
    return 0;
  }
  async insert(contract: Contract): Promise<void> {
    const taken = [...this.rows.values()].some((c) => c.header.number === contract.header.number);
    if (taken) throw new AppError('CONFLICT', 'number taken', { reason: 'DUPLICATE_NUMBER' });
    this.rows.set(contract.header.id, contract);
  }
  async updateHeader(contractId: string, patch: HeaderPatch): Promise<ContractHeader> {
    const contract = this.require(contractId);
    const header = { ...contract.header, ...patch, version: contract.header.version + 1 };
    this.rows.set(contractId, new Contract(header, contract.lines));
    return header;
  }
  async approve(contractId: string, actorId: string, at: Date): Promise<void> {
    const contract = this.require(contractId);
    const header: ContractHeader = {
      ...contract.header,
      status: 'approved',
      approvedAt: at,
      approvedById: actorId,
      version: contract.header.version + 1,
    };
    this.rows.set(contractId, new Contract(header, contract.lines));
  }
  async insertLine(contractId: string, line: ContractLine): Promise<void> {
    this.change(contractId, (lines) => [...lines, line]);
  }
  async updateLine(contractId: string, line: ContractLine): Promise<void> {
    this.change(contractId, (lines) => lines.map((l) => (l.id === line.id ? line : l)));
  }
  async deleteLine(contractId: string, lineId: string): Promise<void> {
    this.change(contractId, (lines) => lines.filter((l) => l.id !== lineId));
  }
  async replaceLines(contractId: string, lines: readonly ContractLine[]): Promise<void> {
    this.change(contractId, () => [...lines]);
  }

  private require(contractId: string): Contract {
    const contract = this.rows.get(contractId);
    if (!contract) throw new AppError('NOT_FOUND', 'Contract not found');
    return contract;
  }
  private change(
    contractId: string,
    apply: (lines: readonly ContractLine[]) => ContractLine[],
  ): void {
    const contract = this.require(contractId);
    const header = { ...contract.header, version: contract.header.version + 1 };
    this.rows.set(contractId, new Contract(header, apply(contract.lines)));
  }
}

export class InMemoryContractAttachments implements ContractAttachmentRepository {
  readonly rows: ContractAttachment[] = [];
  async listByContract(contractId: string): Promise<ContractAttachment[]> {
    return this.rows.filter((a) => a.contractId === contractId);
  }
  async find(contractId: string, id: string): Promise<ContractAttachment | null> {
    return (await this.listByContract(contractId)).find((a) => a.id === id) ?? null;
  }
  async insert(attachment: ContractAttachment): Promise<void> {
    this.rows.push(attachment);
  }
  async delete(contractId: string, id: string): Promise<void> {
    const index = this.rows.findIndex((a) => a.contractId === contractId && a.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

/** Not transactional; `failOnCommit` simulates a transaction that fails after the work was done. */
export class InMemoryContractUnitOfWork implements ContractUnitOfWork {
  readonly contracts = new InMemoryContracts();
  readonly attachments = new InMemoryContractAttachments();
  readonly events = new InMemoryEvents();
  failOnCommit: Error | null = null;

  async run<T>(work: (tx: ContractTx) => Promise<T>): Promise<T> {
    const result = await work({
      contracts: this.contracts,
      attachments: this.attachments,
      events: this.events,
    });
    if (this.failOnCommit) throw this.failOnCommit;
    return result;
  }
}
