import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type CreateContractorRequest,
  type UpdateContractorRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import {
  assertVersion,
  type ContractorPatch,
  type ContractorRecord,
  type ContractorSummary,
} from '../domain/contractor.js';
import type { ContractorUnitOfWork } from '../domain/contractor.repository.js';

const FIELDS = ['name', 'contactName', 'contactPhone', 'commercialRegister', 'taxCard'] as const;

export class CreateContractorUseCase {
  constructor(
    private readonly uow: ContractorUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  execute(input: {
    actorId: string;
    request: CreateContractorRequest;
  }): Promise<ContractorSummary> {
    const { actorId, request } = input;
    const now = this.clock.now();
    const record: ContractorRecord = {
      id: this.ids.next(),
      name: request.name,
      contactName: request.contactName,
      contactPhone: request.contactPhone,
      commercialRegister: request.commercialRegister ?? null,
      taxCard: request.taxCard ?? null,
      version: 1,
      createdById: actorId,
      createdAt: now,
      updatedAt: now,
    };
    return this.uow.run(async (tx) => {
      await tx.contractors.insert(record);
      await tx.events.append({
        projectId: null,
        entity: EVENT_ENTITIES.contractor,
        entityId: record.id,
        type: EVENT_TYPES.contractorCreated,
        actorId,
        payload: {
          name: record.name,
          contactName: record.contactName,
          contactPhone: record.contactPhone,
          commercialRegister: record.commercialRegister,
          taxCard: record.taxCard,
        },
      });
      const stored = await tx.contractors.findById(record.id);
      if (!stored) throw new AppError('INTERNAL', 'The contractor was not stored');
      return stored;
    });
  }
}

export class UpdateContractorUseCase {
  constructor(private readonly uow: ContractorUnitOfWork) {}

  execute(input: {
    contractorId: string;
    actorId: string;
    request: UpdateContractorRequest;
  }): Promise<ContractorSummary> {
    const { contractorId, actorId, request } = input;
    return this.uow.run(async (tx) => {
      const current = await tx.contractors.findById(contractorId, { lock: true });
      if (!current) throw new AppError('NOT_FOUND', 'Contractor not found');
      assertVersion(current.version, request.expectedVersion);

      const patch: ContractorPatch = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const field of FIELDS) {
        const value = request[field];
        if (value === undefined) continue;
        (patch as Record<string, unknown>)[field] = value;
        if (current[field] !== value) {
          before[field] = current[field];
          after[field] = value;
        }
      }
      const updated = await tx.contractors.update(contractorId, patch);
      await tx.events.append({
        projectId: null,
        entity: EVENT_ENTITIES.contractor,
        entityId: contractorId,
        type: EVENT_TYPES.contractorUpdated,
        actorId,
        payload: { before, after, version: updated.version },
      });
      const stored = await tx.contractors.findById(contractorId);
      if (!stored) throw new AppError('NOT_FOUND', 'Contractor not found');
      return stored;
    });
  }
}
