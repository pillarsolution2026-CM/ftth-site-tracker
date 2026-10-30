import { randomUUID } from 'node:crypto';
import { AppError } from '../../../common/app-error.js';
import type {
  AssignmentAdminRepository,
  AssignmentView,
  IdentityAdminTx,
  IdentityAdminUnitOfWork,
  NewAssignment,
  NewUser,
  UserAdminRepository,
  UserSummary,
} from '../domain/user-admin.js';
import { InMemoryEventLog } from './in-memory.js';

/** In-memory fakes for unit tests of the admin use cases. The FK/unique rules are covered by PostGIS tests. */

export function makeSummary(overrides: Partial<UserSummary> = {}): UserSummary {
  return {
    id: randomUUID(),
    email: `${randomUUID()}@example.com`,
    displayName: 'User',
    locale: 'ar',
    isAdmin: false,
    isActive: true,
    createdAt: new Date('2026-10-30T00:00:00Z'),
    ...overrides,
  };
}

export class InMemoryUserAdmin implements UserAdminRepository {
  readonly revoked: string[] = [];
  readonly hashes = new Map<string, string>();
  constructor(readonly users: UserSummary[] = []) {}

  async list(): Promise<UserSummary[]> {
    return [...this.users];
  }
  async findById(userId: string): Promise<UserSummary | null> {
    return this.users.find((user) => user.id === userId) ?? null;
  }
  async insert(user: NewUser): Promise<UserSummary> {
    if (this.users.some((existing) => existing.email === user.email)) {
      throw new AppError('CONFLICT', 'taken');
    }
    const created = makeSummary({
      email: user.email,
      displayName: user.displayName,
      locale: user.locale,
    });
    this.hashes.set(created.id, user.passwordHash);
    this.users.push(created);
    return created;
  }
  async setActive(userId: string, active: boolean): Promise<UserSummary | null> {
    const user = this.users.find((candidate) => candidate.id === userId && !candidate.isAdmin);
    if (!user) return null;
    user.isActive = active;
    return { ...user };
  }
  async revokeSessions(userId: string): Promise<void> {
    this.revoked.push(userId);
  }
}

export class InMemoryAssignmentAdmin implements AssignmentAdminRepository {
  readonly rows: (AssignmentView & { projectId: string })[] = [];

  async listForProject(projectId: string): Promise<AssignmentView[]> {
    return this.rows.filter((row) => row.projectId === projectId);
  }
  async insert(assignment: NewAssignment): Promise<AssignmentView> {
    const row = {
      ...assignment,
      id: randomUUID(),
      userEmail: 'u@example.com',
      userDisplayName: 'U',
      userIsActive: true,
      zoneName: null,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }
  async delete(projectId: string, assignmentId: string): Promise<AssignmentView | null> {
    const index = this.rows.findIndex(
      (row) => row.id === assignmentId && row.projectId === projectId,
    );
    if (index < 0) return null;
    const [removed] = this.rows.splice(index, 1);
    return removed ?? null;
  }
}

export class InMemoryIdentityAdminUow implements IdentityAdminUnitOfWork {
  readonly users: InMemoryUserAdmin;
  readonly assignments = new InMemoryAssignmentAdmin();
  readonly events = new InMemoryEventLog();
  constructor(users: UserSummary[] = []) {
    this.users = new InMemoryUserAdmin(users);
  }
  run<T>(work: (tx: IdentityAdminTx) => Promise<T>): Promise<T> {
    return work({ users: this.users, assignments: this.assignments, events: this.events });
  }
}
