import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type AddContractItemRequest,
  type ApproveContractRequest,
  type ContractItemInput,
  type CreateContractRequest,
  type UpdateContractItemRequest,
  type UpdateContractRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { Decimal } from '../../work-orders/domain/decimal.js';
import { Contract, type HeaderPatch, type LineValues } from '../domain/contract.js';
import type { ContractTx, ContractUnitOfWork } from '../domain/contract.repository.js';
import { viewInTx, type ContractView } from './contract-queries.js';
import { boqSnapshot, lineSnapshot } from './snapshots.js';

function toLineValues(input: ContractItemInput): LineValues {
  if (input.kind === 'heading') {
    return { kind: 'heading', code: input.code, description: input.description ?? null };
  }
  return {
    kind: 'item',
    code: input.code,
    description: input.description,
    unit: input.unit,
    quantity: Decimal.parse(input.quantity),
    unitPrice: Decimal.parse(input.unitPrice),
    workType: input.workType,
  };
}

/** The row lock serialises concurrent edits, so line numbers and duplicate checks are race-free. */
export async function lockContract(tx: ContractTx, contractId: string): Promise<Contract> {
  const contract = await tx.contracts.findById(contractId, { lock: true });
  if (!contract) throw new AppError('NOT_FOUND', 'Contract not found');
  return contract;
}

export class CreateContractUseCase {
  constructor(
    private readonly uow: ContractUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  execute(input: { actorId: string; request: CreateContractRequest }): Promise<ContractView> {
    const { actorId, request } = input;
    const contract = Contract.create(
      { ...request, createdById: actorId },
      this.ids,
      this.clock.now(),
    );
    return this.uow.run(async (tx) => {
      await tx.contracts.insert(contract);
      await tx.events.append({
        projectId: null,
        entity: EVENT_ENTITIES.contract,
        entityId: contract.header.id,
        type: EVENT_TYPES.contractCreated,
        actorId,
        payload: {
          number: contract.header.number,
          name: contract.header.name,
          client: contract.header.client,
          currency: contract.header.currency,
          startsOn: contract.header.startsOn,
          durationDays: contract.header.durationDays,
        },
      });
      return viewInTx(tx, contract.header.id);
    });
  }
}

export class UpdateContractUseCase {
  constructor(private readonly uow: ContractUnitOfWork) {}

  execute(input: {
    contractId: string;
    actorId: string;
    request: UpdateContractRequest;
  }): Promise<ContractView> {
    const { contractId, actorId, request } = input;
    return this.uow.run(async (tx) => {
      const contract = await lockContract(tx, contractId);
      contract.assertVersion(request.expectedVersion);

      const patch: HeaderPatch = {
        ...(request.number !== undefined ? { number: request.number } : {}),
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.client !== undefined ? { client: request.client } : {}),
        ...(request.startsOn !== undefined ? { startsOn: request.startsOn } : {}),
        ...(request.durationDays !== undefined ? { durationDays: request.durationDays } : {}),
        ...(request.notes !== undefined ? { notes: request.notes } : {}),
      };
      const { header } = contract;
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        const current = header[key as keyof HeaderPatch];
        if (current !== value) {
          before[key] = current;
          after[key] = value;
        }
      }
      const updated = await tx.contracts.updateHeader(contractId, patch);
      await tx.events.append({
        projectId: null,
        entity: EVENT_ENTITIES.contract,
        entityId: contractId,
        type: EVENT_TYPES.contractUpdated,
        actorId,
        payload: { before, after, version: updated.version },
      });
      return viewInTx(tx, contractId);
    });
  }
}

export class AddContractItemUseCase {
  constructor(
    private readonly uow: ContractUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  execute(input: {
    contractId: string;
    actorId: string;
    request: AddContractItemRequest;
  }): Promise<ContractView> {
    const { contractId, actorId, request } = input;
    return this.uow.run(async (tx) => {
      const contract = await lockContract(tx, contractId);
      contract.assertDraft();
      contract.assertVersion(request.expectedVersion);
      const line = contract.buildLine(
        toLineValues(request.item),
        { lineNo: request.lineNo, acceptDuplicateCode: request.acceptDuplicateCode },
        this.ids,
        this.clock.now(),
      );
      await tx.contracts.insertLine(contractId, line);
      await tx.events.append({
        projectId: null,
        entity: EVENT_ENTITIES.contractItem,
        entityId: line.id,
        type: EVENT_TYPES.contractItemAdded,
        actorId,
        payload: { contractId, ...lineSnapshot(line) },
      });
      return viewInTx(tx, contractId);
    });
  }
}

export class UpdateContractItemUseCase {
  constructor(
    private readonly uow: ContractUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(input: {
    contractId: string;
    itemId: string;
    actorId: string;
    request: UpdateContractItemRequest;
  }): Promise<ContractView> {
    const { contractId, itemId, actorId, request } = input;
    return this.uow.run(async (tx) => {
      const contract = await lockContract(tx, contractId);
      contract.assertDraft();
      contract.assertVersion(request.expectedVersion);
      const { before, after } = contract.changeLine(
        itemId,
        toLineValues(request.item),
        request.acceptDuplicateCode,
        this.clock.now(),
      );
      await tx.contracts.updateLine(contractId, after);
      await tx.events.append({
        projectId: null,
        entity: EVENT_ENTITIES.contractItem,
        entityId: itemId,
        type: EVENT_TYPES.contractItemUpdated,
        actorId,
        payload: {
          contractId,
          lineNo: after.lineNo,
          before: lineSnapshot(before),
          after: lineSnapshot(after),
        },
      });
      return viewInTx(tx, contractId);
    });
  }
}

export class RemoveContractItemUseCase {
  constructor(private readonly uow: ContractUnitOfWork) {}

  execute(input: {
    contractId: string;
    itemId: string;
    actorId: string;
    expectedVersion: number;
  }): Promise<ContractView> {
    const { contractId, itemId, actorId, expectedVersion } = input;
    return this.uow.run(async (tx) => {
      const contract = await lockContract(tx, contractId);
      contract.assertDraft();
      contract.assertVersion(expectedVersion);
      const line = contract.findLine(itemId);
      await tx.contracts.deleteLine(contractId, line.id);
      await tx.events.append({
        projectId: null,
        entity: EVENT_ENTITIES.contractItem,
        entityId: line.id,
        type: EVENT_TYPES.contractItemRemoved,
        actorId,
        // Line numbers are not compacted; the snapshot records what was removed.
        payload: { contractId, ...lineSnapshot(line) },
      });
      return viewInTx(tx, contractId);
    });
  }
}

/** Final: locks the BOQ. Needs at least one priced item; the event keeps a full BOQ snapshot. */
export class ApproveContractUseCase {
  constructor(
    private readonly uow: ContractUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(input: {
    contractId: string;
    actorId: string;
    request: ApproveContractRequest;
  }): Promise<ContractView> {
    const { contractId, actorId, request } = input;
    return this.uow.run(async (tx) => {
      const contract = await lockContract(tx, contractId);
      contract.assertDraft();
      contract.assertVersion(request.expectedVersion);
      contract.assertApprovable();
      const at = this.clock.now();
      await tx.contracts.approve(contractId, actorId, at);
      await tx.events.append({
        projectId: null,
        entity: EVENT_ENTITIES.contract,
        entityId: contractId,
        type: EVENT_TYPES.contractApproved,
        actorId,
        payload: {
          approvedAt: at.toISOString(),
          version: contract.header.version + 1,
          ...boqSnapshot(contract),
        },
      });
      return viewInTx(tx, contractId);
    });
  }
}
