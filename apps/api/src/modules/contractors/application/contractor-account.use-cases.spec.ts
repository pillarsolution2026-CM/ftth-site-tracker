import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import type { DomainEventInput } from '../../../common/event-log.port.js';
import type {
  ContractorAccountContext,
  ContractorAccountRecord,
  ContractorAccountRepository,
  ContractorAccountTx,
  ContractorAccountUnitOfWork,
  ContractorPortalRepository,
  NewContractorAccount,
} from '../domain/contractor-account.js';
import { ContractorAccountGuard } from '../interface/contractor-portal.guard.js';
import {
  CreateContractorAccountUseCase,
  ListContractorAccountsUseCase,
  SetContractorAccountActiveUseCase,
} from './contractor-account.use-cases.js';
import { buildTotals, GetContractorPortalUseCase } from './contractor-portal.use-case.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000a2';
const REGISTRATION = '00000000-0000-4000-8000-0000000000b1';
const CONTRACTOR = '00000000-0000-4000-8000-0000000000c1';
const ACTOR = '00000000-0000-4000-8000-0000000000d1';
const SUPERVISOR = '00000000-0000-4000-8000-0000000000e1';

class FakeAccounts implements ContractorAccountRepository {
  readonly accounts = new Map<string, ContractorAccountRecord>();
  readonly hashes = new Map<string, string>();
  readonly revoked: string[] = [];
  private counter = 0;

  async contractorOfRegistration(projectId: string, registrationId: string) {
    return projectId === PROJECT && registrationId === REGISTRATION ? CONTRACTOR : null;
  }
  async list() {
    return [...this.accounts.values()];
  }
  async findOwn(_contractorId: string, userId: string) {
    return this.accounts.get(userId) ?? null;
  }
  async insert(_contractorId: string, account: NewContractorAccount) {
    if ([...this.accounts.values()].some((existing) => existing.email === account.email)) {
      throw new AppError('CONFLICT', 'taken', { reason: 'EMAIL_TAKEN' });
    }
    this.counter += 1;
    const record: ContractorAccountRecord = {
      userId: `00000000-0000-4000-8000-00000000f${String(this.counter).padStart(3, '0')}`,
      email: account.email,
      displayName: account.displayName,
      locale: account.locale,
      isActive: true,
      createdAt: new Date('2026-11-21T00:00:00Z'),
    };
    this.accounts.set(record.userId, record);
    this.hashes.set(record.userId, account.passwordHash);
    return record;
  }
  async setActive(userId: string, active: boolean) {
    const account = this.accounts.get(userId);
    if (!account) return null;
    account.isActive = active;
    return { ...account };
  }
  async revokeSessions(userId: string) {
    this.revoked.push(userId);
  }
}

class FakeUow implements ContractorAccountUnitOfWork {
  readonly events: DomainEventInput[] = [];
  constructor(readonly accounts: FakeAccounts) {}
  run<T>(work: (tx: ContractorAccountTx) => Promise<T>): Promise<T> {
    return work({
      accounts: this.accounts,
      events: { append: async (event) => void this.events.push(event) },
    });
  }
}

const hasher = { hash: async (password: string) => `hashed:${password}` };
const clock = { now: () => new Date('2026-11-21T10:00:00Z') };
const request = {
  email: 'acme@example.com',
  displayName: 'Acme Works',
  password: 'secret-password',
  locale: 'ar' as const,
};

function setup() {
  const accounts = new FakeAccounts();
  const uow = new FakeUow(accounts);
  return {
    accounts,
    uow,
    create: new CreateContractorAccountUseCase(accounts, uow, hasher),
    list: new ListContractorAccountsUseCase(accounts),
    setActive: new SetContractorAccountActiveUseCase(accounts, uow, clock),
  };
}

describe('CreateContractorAccountUseCase', () => {
  it('stores only the hash and logs an event without the password', async () => {
    const { accounts, uow, create } = setup();
    const created = await create.execute(
      { projectId: PROJECT, registrationId: REGISTRATION, request },
      ACTOR,
    );
    expect(accounts.hashes.get(created.userId)).toBe('hashed:secret-password');
    expect(uow.events).toEqual([
      expect.objectContaining({
        projectId: PROJECT,
        type: 'contractor_account.created',
        entityId: created.userId,
        actorId: ACTOR,
        payload: { contractorId: CONTRACTOR, userId: created.userId, email: request.email },
      }),
    ]);
    expect(JSON.stringify(uow.events)).not.toContain('secret-password');
    expect(JSON.stringify(uow.events)).not.toContain('hashed:');
  });

  it('answers 404 for a registration of another project, before hashing', async () => {
    const { create, accounts } = setup();
    await expect(
      create.execute({ projectId: OTHER_PROJECT, registrationId: REGISTRATION, request }, ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(accounts.accounts.size).toBe(0);
  });

  it('reports a taken email as 409 EMAIL_TAKEN and writes no event', async () => {
    const { create, uow } = setup();
    const input = { projectId: PROJECT, registrationId: REGISTRATION, request };
    await create.execute(input, ACTOR);
    await expect(create.execute(input, ACTOR)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'EMAIL_TAKEN' },
    });
    expect(uow.events).toHaveLength(1);
  });
});

describe('ListContractorAccountsUseCase', () => {
  it('lists the contractor accounts and 404s a foreign registration', async () => {
    const { create, list } = setup();
    await create.execute({ projectId: PROJECT, registrationId: REGISTRATION, request }, ACTOR);
    const result = await list.execute({ projectId: PROJECT, registrationId: REGISTRATION });
    expect(result.contractorId).toBe(CONTRACTOR);
    expect(result.items.map((item) => item.email)).toEqual([request.email]);
    await expect(
      list.execute({ projectId: OTHER_PROJECT, registrationId: REGISTRATION }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('SetContractorAccountActiveUseCase', () => {
  const stop = (
    useCase: SetContractorAccountActiveUseCase,
    userId: string,
    isActive: boolean,
    projectId = PROJECT,
  ) =>
    useCase.execute(
      { projectId, registrationId: REGISTRATION, userId, request: { isActive } },
      ACTOR,
    );

  it('stops an account, ends its sessions and logs it; restart logs too', async () => {
    const { create, setActive, accounts, uow } = setup();
    const created = await create.execute(
      { projectId: PROJECT, registrationId: REGISTRATION, request },
      ACTOR,
    );
    const stopped = await stop(setActive, created.userId, false);
    expect(stopped.isActive).toBe(false);
    expect(accounts.revoked).toEqual([created.userId]);
    const restarted = await stop(setActive, created.userId, true);
    expect(restarted.isActive).toBe(true);
    expect(uow.events.map((event) => event.type)).toEqual([
      'contractor_account.created',
      'contractor_account.stopped',
      'contractor_account.restarted',
    ]);
  });

  it('is idempotent and a repeated stop still ends leftover sessions', async () => {
    const { create, setActive, accounts, uow } = setup();
    const created = await create.execute(
      { projectId: PROJECT, registrationId: REGISTRATION, request },
      ACTOR,
    );
    await stop(setActive, created.userId, false);
    await stop(setActive, created.userId, false);
    expect(accounts.revoked).toEqual([created.userId, created.userId]);
    expect(uow.events).toHaveLength(2);
  });

  it('answers 404 for a user that is not an account of the contractor (a supervisor, etc.)', async () => {
    const { setActive, accounts } = setup();
    await expect(stop(setActive, SUPERVISOR, false)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(accounts.revoked).toEqual([]);
  });

  it('answers 404 for a registration of another project', async () => {
    const { create, setActive } = setup();
    const created = await create.execute(
      { projectId: PROJECT, registrationId: REGISTRATION, request },
      ACTOR,
    );
    await expect(stop(setActive, created.userId, false, OTHER_PROJECT)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('buildTotals', () => {
  it('gives one entry per currency, trims decimals and fills 0 for missing statuses', () => {
    expect(
      buildTotals(
        ['EGP', 'USD', 'EGP'],
        [
          { currency: 'EGP', status: 'approved', total: '12.500000000' },
          { currency: 'EGP', status: 'pending', total: '3.0000' },
        ],
      ),
    ).toEqual([
      { currency: 'EGP', approved: '12.5', pending: '3', rejected: '0' },
      { currency: 'USD', approved: '0', pending: '0', rejected: '0' },
    ]);
  });
});

describe('GetContractorPortalUseCase', () => {
  it('asks the repository only for the account contractor and builds the totals', async () => {
    const seen: string[] = [];
    const portal: ContractorPortalRepository = {
      findActiveAccount: async () => null,
      registrations: async (contractorId) => {
        seen.push(contractorId);
        return [
          {
            registrationId: REGISTRATION,
            projectId: PROJECT,
            projectName: 'P',
            workOrderNumber: 'WO-1',
            currency: 'EGP',
            registeredOn: '2026-11-01',
            lines: [],
          },
        ];
      },
      work: async (contractorId) => {
        seen.push(contractorId);
        return [];
      },
      valueTotals: async (contractorId) => {
        seen.push(contractorId);
        return [{ currency: 'EGP', status: 'rejected', total: '7.0' }];
      },
    };
    const account: ContractorAccountContext = {
      userId: ACTOR,
      contractorId: CONTRACTOR,
      contractorName: 'Acme',
    };
    const view = await new GetContractorPortalUseCase(portal, clock).execute(account);
    expect(seen).toEqual([CONTRACTOR, CONTRACTOR, CONTRACTOR]);
    expect(view.serverTime).toBe('2026-11-21T10:00:00.000Z');
    expect(view.contractor).toEqual({ id: CONTRACTOR, name: 'Acme' });
    expect(view.totals).toEqual([{ currency: 'EGP', approved: '0', pending: '0', rejected: '7' }]);
  });
});

describe('ContractorAccountGuard', () => {
  const contextFor = (request: object) =>
    ({ switchToHttp: () => ({ getRequest: () => request }) }) as never;
  const portalWith = (account: ContractorAccountContext | null): ContractorPortalRepository => ({
    findActiveAccount: async () => account,
    registrations: async () => [],
    work: async () => [],
    valueTotals: async () => [],
  });

  it('lets an active contractor account through and stores its contractor', async () => {
    const account = { userId: ACTOR, contractorId: CONTRACTOR, contractorName: 'Acme' };
    const request: { auth: { sub: string; isAdmin: boolean }; contractorAccount?: unknown } = {
      auth: { sub: ACTOR, isAdmin: false },
    };
    await expect(
      new ContractorAccountGuard(portalWith(account)).canActivate(contextFor(request)),
    ).resolves.toBe(true);
    expect(request.contractorAccount).toEqual(account);
  });

  it('refuses any other user (including a stopped account) with FORBIDDEN', async () => {
    await expect(
      new ContractorAccountGuard(portalWith(null)).canActivate(
        contextFor({ auth: { sub: SUPERVISOR, isAdmin: false } }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a request without authentication', async () => {
    await expect(
      new ContractorAccountGuard(portalWith(null)).canActivate(contextFor({})),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });
});
