import type { PortalRegistration, PortalWork, UpdateStatus } from '@ftth/shared';
import type { EventLog } from '../../../common/event-log.port.js';

/** Event types of the login accounts of contractors (ADR-053). Payloads never hold a password. */
export const CONTRACTOR_ACCOUNT_EVENT_TYPES = {
  created: 'contractor_account.created',
  stopped: 'contractor_account.stopped',
  restarted: 'contractor_account.restarted',
} as const;

export type AccountLocale = 'ar' | 'en' | 'fr';

/** A contractor's login account as the admin and the PM see it: never the password hash. */
export interface ContractorAccountRecord {
  userId: string;
  email: string;
  displayName: string;
  locale: AccountLocale;
  isActive: boolean;
  createdAt: Date;
}

export interface NewContractorAccount {
  /** Lower-cased. */
  email: string;
  displayName: string;
  passwordHash: string;
  locale: AccountLocale;
}

export interface ContractorAccountRepository {
  /**
   * The contractor of a registration of THIS project, or null (a registration of another project
   * and an unknown registration look the same: no oracle).
   */
  contractorOfRegistration(projectId: string, registrationId: string): Promise<string | null>;
  /** Every account of the contractor, by name. */
  list(contractorId: string): Promise<ContractorAccountRecord[]>;
  /**
   * The account only when the user is an account OF THIS contractor, locking its user row;
   * any other user (a supervisor, an admin, another contractor's account) gives null.
   */
  findOwn(contractorId: string, userId: string): Promise<ContractorAccountRecord | null>;
  /**
   * New non-admin user and its `contractor_accounts` row. Throws CONFLICT `EMAIL_TAKEN` when the
   * email exists.
   */
  insert(
    contractorId: string,
    account: NewContractorAccount,
    createdBy: string,
  ): Promise<ContractorAccountRecord>;
  setActive(userId: string, active: boolean): Promise<ContractorAccountRecord | null>;
  /** Ends every refresh-token family of the user. */
  revokeSessions(userId: string, at: Date): Promise<void>;
}

export interface ContractorAccountTx {
  accounts: ContractorAccountRepository;
  events: EventLog;
}

/** State change and its event commit in one transaction. */
export interface ContractorAccountUnitOfWork {
  run<T>(work: (tx: ContractorAccountTx) => Promise<T>): Promise<T>;
}

/** The logged-in contractor account: the only source of the contractor id of every portal query. */
export interface ContractorAccountContext {
  userId: string;
  contractorId: string;
  contractorName: string;
}

/** Sum of the values of one currency and review status (exact decimal text, SQL numeric). */
export interface PortalValueTotal {
  currency: string;
  status: UpdateStatus;
  total: string;
}

/**
 * Read side of GET /contractor/me. EVERY method filters by the contractor id: nothing of another
 * contractor, of the own crew or of the client prices can come out of it.
 */
export interface ContractorPortalRepository {
  /** The contractor account of an ACTIVE user; null for any other user. */
  findActiveAccount(userId: string): Promise<ContractorAccountContext | null>;
  registrations(contractorId: string): Promise<PortalRegistration[]>;
  /** Newest first. */
  work(contractorId: string): Promise<PortalWork[]>;
  valueTotals(contractorId: string): Promise<PortalValueTotal[]>;
}
