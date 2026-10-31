import type { AttachmentKind } from '@ftth/shared';
import type { EventLog } from '../../../common/event-log.port.js';
import type { Decimal } from '../../work-orders/domain/decimal.js';
import type { Contract, ContractHeader, ContractLine, HeaderPatch } from './contract.js';

export interface ContractSummaryRow {
  header: ContractHeader;
  /** Priced items only. */
  itemCount: number;
  total: Decimal;
  projectCount: number;
}

export interface ContractAttachment {
  id: string;
  contractId: string;
  kind: AttachmentKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  uploadedById: string | null;
  createdAt: Date;
}

/** Every write bumps the contract's `version` in the same transaction. */
export interface ContractRepository {
  list(): Promise<ContractSummaryRow[]>;
  exists(contractId: string): Promise<boolean>;
  /** `lock` takes a row lock (SELECT … FOR UPDATE) for the rest of the transaction. */
  findById(contractId: string, options?: { lock?: boolean }): Promise<Contract | null>;
  projectCount(contractId: string): Promise<number>;
  /** CONFLICT DUPLICATE_NUMBER when the number is taken. */
  insert(contract: Contract): Promise<void>;
  /** Applies the patch, bumps `version`, returns the stored header. */
  updateHeader(contractId: string, patch: HeaderPatch): Promise<ContractHeader>;
  approve(contractId: string, actorId: string, at: Date): Promise<void>;
  insertLine(contractId: string, line: ContractLine): Promise<void>;
  updateLine(contractId: string, line: ContractLine): Promise<void>;
  deleteLine(contractId: string, lineId: string): Promise<void>;
  /** Deletes every line and inserts `lines`. */
  replaceLines(contractId: string, lines: readonly ContractLine[]): Promise<void>;
}

export interface ContractAttachmentRepository {
  listByContract(contractId: string): Promise<ContractAttachment[]>;
  find(contractId: string, attachmentId: string): Promise<ContractAttachment | null>;
  insert(attachment: ContractAttachment): Promise<void>;
  delete(contractId: string, attachmentId: string): Promise<void>;
}

/** Repositories and event log bound to one database transaction. */
export interface ContractTx {
  contracts: ContractRepository;
  attachments: ContractAttachmentRepository;
  events: EventLog;
}

export interface ContractUnitOfWork {
  run<T>(work: (tx: ContractTx) => Promise<T>): Promise<T>;
}
