import type { EventLog } from '../../../common/event-log.port.js';

export interface Project {
  id: string;
  name: string;
  client: string;
  /** Project CRS (metric). All project geometry is stored in it. */
  crsEpsg: number;
  /** ISO 4217 code. */
  currency: string;
  locale: 'ar' | 'en' | 'fr';
  /** Contract the project (= one work order) belongs to; null only before Phase 2 (ADR-027). */
  contractId: string | null;
}

/** `client` and `currency` are copied from the contract by the use case. */
export type NewProject = Omit<Project, 'id'>;

/** The part of a contract a new project copies. */
export interface ContractReference {
  id: string;
  client: string;
  currency: string;
}

export interface ContractReferenceRepository {
  findById(contractId: string): Promise<ContractReference | null>;
}

/** Fields an admin may change after creation; the CRS, contract, client and currency are fixed (ADR-026, ADR-027). */
export type ProjectChanges = Partial<Pick<Project, 'name' | 'locale'>>;

export interface ProjectRepository {
  findById(projectId: string): Promise<Project | null>;
}

export interface ProjectAdminRepository extends ProjectRepository {
  list(): Promise<Project[]>;
  /** Locks the row for the rest of the transaction. */
  findByIdForUpdate(projectId: string): Promise<Project | null>;
  insert(project: NewProject): Promise<Project>;
  update(projectId: string, changes: ProjectChanges): Promise<Project>;
}

/** A zone known by name only until its boundary is drawn (Phase 2). */
export interface Zone {
  id: string;
  name: string;
  hasBoundary: boolean;
}

export interface ZoneRepository {
  listForProject(projectId: string): Promise<Zone[]>;
  insert(projectId: string, name: string): Promise<Zone>;
}

export interface ProjectAdminTx {
  projects: ProjectAdminRepository;
  zones: ZoneRepository;
  contracts: ContractReferenceRepository;
  events: EventLog;
}

export interface ProjectAdminUnitOfWork {
  run<T>(work: (tx: ProjectAdminTx) => Promise<T>): Promise<T>;
}
