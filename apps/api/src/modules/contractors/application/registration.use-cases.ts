import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type AddContractorPriceRequest,
  type UpdateContractorLineRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { IdGenerator } from '../../../common/clock.js';
import { Decimal } from '../../work-orders/domain/decimal.js';
import type { GetProjectUseCase } from '../../projects/application/get-project.use-case.js';
import {
  assertPriceDateAfterLatest,
  assertPriceWithinContract,
  assertQuantityFits,
  holdingOf,
  otherScopesPrice,
  type Registration,
} from '../domain/contractor.js';
import type { ContractorTx, ContractorUnitOfWork } from '../domain/contractor.repository.js';
import { viewOf, type ProjectContractorsView } from './contractor-queries.js';
import { lineSnapshot, registrationSnapshot } from './snapshots.js';

type Projects = Pick<GetProjectUseCase, 'execute'>;

interface Scope {
  projectId: string;
  actorId: string;
}

export async function lockedWorkOrder(tx: ContractorTx, projectId: string): Promise<string> {
  const workOrderId = await tx.registrations.workOrderOf(projectId, { lock: true });
  if (workOrderId === null) {
    throw new AppError('CONFLICT', 'The project has no work order yet', {
      reason: 'NO_WORK_ORDER',
    });
  }
  return workOrderId;
}

/**
 * Finds the registration (404 when it belongs to another project), takes the work-order lock that
 * serialises contractor writes, and reads it again so the checks see the latest rows.
 */
async function lockedRegistration(
  tx: ContractorTx,
  projectId: string,
  registrationId: string,
): Promise<Registration> {
  const notFound = () => new AppError('NOT_FOUND', 'Contractor registration not found');
  if (!(await tx.registrations.find(projectId, registrationId))) throw notFound();
  await lockedWorkOrder(tx, projectId);
  const registration = await tx.registrations.find(projectId, registrationId);
  if (!registration) throw notFound();
  return registration;
}

function findLine(registration: Registration, lineId: string) {
  const line = registration.lines.find((candidate) => candidate.id === lineId);
  if (!line) throw new AppError('NOT_FOUND', 'Contractor line not found');
  return line;
}

export class RemoveRegistrationUseCase {
  constructor(
    private readonly projects: Projects,
    private readonly uow: ContractorUnitOfWork,
  ) {}

  async execute(input: Scope & { registrationId: string }): Promise<ProjectContractorsView> {
    const { projectId, actorId, registrationId } = input;
    const project = await this.projects.execute(projectId);
    return this.uow.run(async (tx) => {
      const registration = await lockedRegistration(tx, projectId, registrationId);
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.contractorRegistration,
        entityId: registrationId,
        type: EVENT_TYPES.contractorRegistrationRemoved,
        actorId,
        // The rows are hard-deleted, so the event is the only remaining record of them.
        payload: registrationSnapshot(registration),
      });
      await tx.registrations.delete(projectId, registrationId);
      return viewOf(tx.registrations, projectId, project.currency);
    });
  }
}

export class UpdateContractorLineUseCase {
  constructor(
    private readonly projects: Projects,
    private readonly uow: ContractorUnitOfWork,
  ) {}

  async execute(
    input: Scope & {
      registrationId: string;
      lineId: string;
      request: UpdateContractorLineRequest;
    },
  ): Promise<ProjectContractorsView> {
    const { projectId, actorId, registrationId, lineId, request } = input;
    const project = await this.projects.execute(projectId);
    return this.uow.run(async (tx) => {
      const registration = await lockedRegistration(tx, projectId, registrationId);
      const line = findLine(registration, lineId);
      const quantity = Decimal.parse(request.quantity);
      const holdings = await tx.registrations.holdings(registration.workOrderId);
      // The line itself is not "other" reservation: take its current quantity out.
      const held = holdingOf(holdings, line.item.id, line.scopeKey)?.quantity ?? line.quantity;
      assertQuantityFits(line.item, line.scope, held.sub(line.quantity), quantity);
      await tx.registrations.updateLineQuantity(projectId, lineId, quantity);
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.contractorLine,
        entityId: lineId,
        type: EVENT_TYPES.contractorLineUpdated,
        actorId,
        payload: {
          registrationId,
          workOrderItemId: line.item.id,
          code: line.item.code,
          scope: line.scope,
          before: { quantity: line.quantity.toString() },
          after: { quantity: quantity.toString() },
        },
      });
      return viewOf(tx.registrations, projectId, project.currency);
    });
  }
}

export class RemoveContractorLineUseCase {
  constructor(
    private readonly projects: Projects,
    private readonly uow: ContractorUnitOfWork,
  ) {}

  async execute(
    input: Scope & { registrationId: string; lineId: string },
  ): Promise<ProjectContractorsView> {
    const { projectId, actorId, registrationId, lineId } = input;
    const project = await this.projects.execute(projectId);
    return this.uow.run(async (tx) => {
      const registration = await lockedRegistration(tx, projectId, registrationId);
      const line = findLine(registration, lineId);
      // The item list is required (owner, 2026-11-07): the last line goes only with its registration.
      if (registration.lines.length <= 1) {
        throw new AppError('CONFLICT', 'The last line of a contractor cannot be removed', {
          reason: 'LAST_LINE',
          registrationId,
        });
      }
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.contractorLine,
        entityId: lineId,
        type: EVENT_TYPES.contractorLineRemoved,
        actorId,
        payload: { registrationId, ...lineSnapshot(line) },
      });
      await tx.registrations.deleteLine(projectId, lineId);
      return viewOf(tx.registrations, projectId, project.currency);
    });
  }
}

export class AddContractorPriceUseCase {
  constructor(
    private readonly projects: Projects,
    private readonly uow: ContractorUnitOfWork,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    input: Scope & {
      registrationId: string;
      lineId: string;
      request: AddContractorPriceRequest;
    },
  ): Promise<ProjectContractorsView> {
    const { projectId, actorId, registrationId, lineId, request } = input;
    const project = await this.projects.execute(projectId);
    return this.uow.run(async (tx) => {
      const registration = await lockedRegistration(tx, projectId, registrationId);
      const line = findLine(registration, lineId);
      const unitPrice = Decimal.parse(request.unitPrice);
      const holdings = await tx.registrations.holdings(registration.workOrderId);
      assertPriceWithinContract(
        line.item,
        line.scope,
        otherScopesPrice(holdings, line.item.id, line.scopeKey),
        holdingOf(holdings, line.item.id, line.scopeKey)?.highestPrice ?? Decimal.zero,
        unitPrice,
      );
      assertPriceDateAfterLatest(line.prices, request.effectiveFrom);
      const previous = line.prices[line.prices.length - 1];
      const price = {
        id: this.ids.next(),
        effectiveFrom: request.effectiveFrom,
        unitPrice,
        createdById: actorId,
      };
      await tx.registrations.insertPrice(projectId, lineId, price);
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.contractorLine,
        entityId: lineId,
        type: EVENT_TYPES.contractorPriceAdded,
        actorId,
        payload: {
          registrationId,
          workOrderItemId: line.item.id,
          code: line.item.code,
          scope: line.scope,
          effectiveFrom: price.effectiveFrom,
          unitPrice: unitPrice.toString(),
          previous: previous
            ? {
                effectiveFrom: previous.effectiveFrom,
                unitPrice: previous.unitPrice.toString(),
              }
            : null,
        },
      });
      return viewOf(tx.registrations, projectId, project.currency);
    });
  }
}
