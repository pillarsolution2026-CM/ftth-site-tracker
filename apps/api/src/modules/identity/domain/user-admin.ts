import type { Role } from '@ftth/shared';
import type { EventLog } from '../../../common/event-log.port.js';
import type { Locale } from './user.js';

/** A user as the admin sees it: never carries the password hash. */
export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  locale: Locale;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: Date;
}

export interface NewUser {
  /** Lower-cased. */
  email: string;
  displayName: string;
  passwordHash: string;
  locale: Locale;
}

export interface UserAdminRepository {
  list(): Promise<UserSummary[]>;
  findById(userId: string): Promise<UserSummary | null>;
  /** Always creates a non-admin. Throws CONFLICT when the email is taken. */
  insert(user: NewUser): Promise<UserSummary>;
  /** Only touches non-admins; null when no such non-admin exists. */
  setActive(userId: string, active: boolean): Promise<UserSummary | null>;
  /** Ends every refresh-token family of the user. */
  revokeSessions(userId: string, at: Date): Promise<void>;
}

/** One `assignments` row with the user and the zone name, for the admin screen. */
export interface AssignmentView {
  id: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  userIsActive: boolean;
  role: Role;
  zoneId: string | null;
  zoneName: string | null;
  createdAt: Date;
}

export interface NewAssignment {
  projectId: string;
  userId: string;
  role: Role;
  zoneId: string | null;
}

export interface AssignmentAdminRepository {
  listForProject(projectId: string): Promise<AssignmentView[]>;
  /**
   * Throws NOT_FOUND when the project does not exist, VALIDATION_FAILED when the zone is not in the
   * project (composite FK, migration 0002) and CONFLICT for a duplicate assignment.
   */
  insert(assignment: NewAssignment): Promise<AssignmentView>;
  /** Deletes only inside `projectId` (IDOR); returns the removed row or null. */
  delete(projectId: string, assignmentId: string): Promise<AssignmentView | null>;
}

export interface IdentityAdminTx {
  users: UserAdminRepository;
  assignments: AssignmentAdminRepository;
  events: EventLog;
}

/** State change and its event commit in one transaction. */
export interface IdentityAdminUnitOfWork {
  run<T>(work: (tx: IdentityAdminTx) => Promise<T>): Promise<T>;
}
