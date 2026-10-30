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
}

export type NewProject = Omit<Project, 'id'>;

/** Fields an admin may change after creation; the CRS and the currency are fixed (ADR-025). */
export type ProjectChanges = Partial<Pick<Project, 'name' | 'client' | 'locale'>>;

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
  events: EventLog;
}

export interface ProjectAdminUnitOfWork {
  run<T>(work: (tx: ProjectAdminTx) => Promise<T>): Promise<T>;
}
