import { randomUUID } from 'node:crypto';
import type { AccessTokenClaims } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { DomainEventInput, EventLog } from '../../../common/event-log.port.js';
import type {
  AccessTokenService,
  Clock,
  PasswordHasher,
  RefreshTokenFactory,
} from '../application/ports.js';
import type { AssignmentRow, MembershipRepository } from '../domain/membership.js';
import type {
  NewRefreshToken,
  RefreshTokenRecord,
  RefreshTokenRepository,
} from '../domain/refresh-token.js';
import type { User, UserRepository } from '../domain/user.js';

/** In-memory fakes for unit tests of the identity use cases (never used for PostGIS-backed code). */

export class FakeClock implements Clock {
  constructor(private current = new Date('2026-01-01T00:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
}

export class FakeHasher implements PasswordHasher {
  verifyCalls = 0;
  async hash(password: string): Promise<string> {
    return `hashed:${password}`;
  }
  async verify(passwordHash: string, password: string): Promise<boolean> {
    this.verifyCalls += 1;
    return passwordHash === `hashed:${password}`;
  }
}

export class FakeAccessTokens implements AccessTokenService {
  sign(claims: AccessTokenClaims): string {
    return `jwt:${claims.sub}:${claims.isAdmin}`;
  }
  verify(token: string): AccessTokenClaims {
    const [prefix, sub, isAdmin] = token.split(':');
    if (prefix !== 'jwt' || !sub) throw new AppError('TOKEN_INVALID');
    return { sub, isAdmin: isAdmin === 'true' };
  }
}

export class FakeRefreshTokenFactory implements RefreshTokenFactory {
  private counter = 0;
  create(): { token: string; hash: string } {
    this.counter += 1;
    const token = `refresh-token-${this.counter}-`.padEnd(40, 'x');
    return { token, hash: this.hash(token) };
  }
  hash(token: string): string {
    return `sha:${token}`;
  }
  newFamilyId(): string {
    return randomUUID();
  }
}

export class InMemoryUsers implements UserRepository {
  constructor(readonly users: User[] = []) {}
  async findByEmail(email: string): Promise<User | null> {
    return this.users.find((user) => user.email === email) ?? null;
  }
  async findById(id: string): Promise<User | null> {
    return this.users.find((user) => user.id === id) ?? null;
  }
}

export class InMemoryRefreshTokens implements RefreshTokenRepository {
  readonly rows: RefreshTokenRecord[] = [];

  async insert(token: NewRefreshToken): Promise<void> {
    this.rows.push({ id: randomUUID(), rotatedAt: null, revokedAt: null, ...token });
  }
  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = this.rows.find((candidate) => candidate.tokenHash === tokenHash);
    return row ? { ...row } : null;
  }
  async rotate(currentId: string, next: NewRefreshToken, now: Date): Promise<boolean> {
    const current = this.rows.find((row) => row.id === currentId);
    if (!current || current.rotatedAt || current.revokedAt) return false;
    current.rotatedAt = now;
    await this.insert(next);
    return true;
  }
  async revokeFamily(familyId: string, now: Date): Promise<void> {
    for (const row of this.rows) {
      if (row.familyId === familyId && !row.revokedAt) row.revokedAt = now;
    }
  }
}

export class InMemoryMemberships implements MembershipRepository {
  constructor(readonly rows: Array<AssignmentRow & { userId: string }> = []) {}
  async listForUser(userId: string): Promise<AssignmentRow[]> {
    return this.rows.filter((row) => row.userId === userId);
  }
  async listForUserInProject(userId: string, projectId: string): Promise<AssignmentRow[]> {
    return this.rows.filter((row) => row.userId === userId && row.projectId === projectId);
  }
}

export class InMemoryEventLog implements EventLog {
  readonly events: DomainEventInput[] = [];
  async append(event: DomainEventInput): Promise<void> {
    this.events.push(event);
  }
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: randomUUID(),
    email: 'pm@ftth.local',
    displayName: 'PM',
    passwordHash: 'hashed:Pm#123456',
    locale: 'ar',
    isAdmin: false,
    isActive: true,
    ...overrides,
  };
}
