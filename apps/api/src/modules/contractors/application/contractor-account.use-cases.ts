import type { CreateContractorAccountRequest, UpdateContractorAccountRequest } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import {
  CONTRACTOR_ACCOUNT_EVENT_TYPES,
  type ContractorAccountRecord,
  type ContractorAccountRepository,
  type ContractorAccountUnitOfWork,
} from '../domain/contractor-account.js';

/** Hashes a password (argon2id, like admin-created users). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
}

const registrationNotFound = () => new AppError('NOT_FOUND', 'Contractor registration not found');

export class ListContractorAccountsUseCase {
  constructor(private readonly accounts: ContractorAccountRepository) {}

  async execute(input: {
    projectId: string;
    registrationId: string;
  }): Promise<{ contractorId: string; items: ContractorAccountRecord[] }> {
    const contractorId = await this.accounts.contractorOfRegistration(
      input.projectId,
      input.registrationId,
    );
    if (!contractorId) throw registrationNotFound();
    return { contractorId, items: await this.accounts.list(contractorId) };
  }
}

/** Creates a non-admin login account of the registration's contractor; the password is never logged. */
export class CreateContractorAccountUseCase {
  constructor(
    private readonly lookup: ContractorAccountRepository,
    private readonly uow: ContractorAccountUnitOfWork,
    private readonly hasher: PasswordHasher,
  ) {}

  async execute(
    input: { projectId: string; registrationId: string; request: CreateContractorAccountRequest },
    actorId: string,
  ): Promise<ContractorAccountRecord> {
    // Resolved before hashing: a wrong registration costs nothing.
    const contractorId = await this.lookup.contractorOfRegistration(
      input.projectId,
      input.registrationId,
    );
    if (!contractorId) throw registrationNotFound();
    const { request } = input;
    const passwordHash = await this.hasher.hash(request.password);
    return this.uow.run(async (tx) => {
      const created = await tx.accounts.insert(
        contractorId,
        {
          email: request.email,
          displayName: request.displayName,
          passwordHash,
          locale: request.locale,
        },
        actorId,
      );
      await tx.events.append({
        projectId: input.projectId,
        entity: 'contractor_account',
        entityId: created.userId,
        type: CONTRACTOR_ACCOUNT_EVENT_TYPES.created,
        actorId,
        payload: { contractorId, userId: created.userId, email: created.email },
      });
      return created;
    });
  }
}

/** Stops or restarts an account of the registration's contractor; stopping ends its sessions. */
export class SetContractorAccountActiveUseCase {
  constructor(
    private readonly lookup: ContractorAccountRepository,
    private readonly uow: ContractorAccountUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: {
      projectId: string;
      registrationId: string;
      userId: string;
      request: UpdateContractorAccountRequest;
    },
    actorId: string,
  ): Promise<ContractorAccountRecord> {
    const contractorId = await this.lookup.contractorOfRegistration(
      input.projectId,
      input.registrationId,
    );
    if (!contractorId) throw registrationNotFound();
    const active = input.request.isActive;
    return this.uow.run(async (tx) => {
      // Only an account of THIS contractor: a PM can never reach another kind of user here.
      const current = await tx.accounts.findOwn(contractorId, input.userId);
      if (!current) throw new AppError('NOT_FOUND', 'Contractor account not found');
      if (current.isActive === active) {
        // Idempotent, but a repeated stop still ends any session left over.
        if (!active) await tx.accounts.revokeSessions(input.userId, this.clock.now());
        return current;
      }
      const updated = await tx.accounts.setActive(input.userId, active);
      if (!updated) throw new AppError('NOT_FOUND', 'Contractor account not found');
      if (!active) await tx.accounts.revokeSessions(input.userId, this.clock.now());
      await tx.events.append({
        projectId: input.projectId,
        entity: 'contractor_account',
        entityId: input.userId,
        type: active
          ? CONTRACTOR_ACCOUNT_EVENT_TYPES.restarted
          : CONTRACTOR_ACCOUNT_EVENT_TYPES.stopped,
        actorId,
        payload: { contractorId, userId: input.userId },
      });
      return updated;
    });
  }
}
