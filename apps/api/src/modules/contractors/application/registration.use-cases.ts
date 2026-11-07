import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type AddContractorLineRequest,
  type AddContractorPriceRequest,
  type RegisterContractorRequest,
  type UpdateContractorLineRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { IdGenerator } from '../../../common/clock.js';
import { Decimal } from '../../work-orders/domain/decimal.js';
import type { GetProjectUseCase } from '../../projects/application/get-project.use-case.js';
import {
  assertAssignable,
  assertPriceDateAfterLatest,
  assertPriceWithinContract,
  assertQuantityFits,
  reservedOf,
  type NewLine,
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

async function lockedWorkOrder(tx: ContractorTx, projectId: string): Promise<string> {
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

export class RegisterContractorUseCase {
  constructor(
    private readonly projects: Projects,
    private readonly uow: ContractorUnitOfWork,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    input: Scope & { request: RegisterContractorRequest },
  ): Promise<ProjectContractorsView> {
    const { projectId, actorId, request } = input;
    const project = await this.projects.execute(projectId);
    return this.uow.run(async (tx) => {
      const workOrderId = await lockedWorkOrder(tx, projectId);
      const contractor = await tx.contractors.findById(request.contractorId);
      if (!contractor) throw new AppError('NOT_FOUND', 'Contractor not found');
      if (await tx.registrations.isRegistered(workOrderId, request.contractorId)) {
        throw new AppError('CONFLICT', 'The contractor is already registered on this work order', {
          reason: 'CONTRACTOR_ALREADY_REGISTERED',
        });
      }

      const items = new Map(
        (await tx.registrations.workOrderLines(workOrderId)).map((item) => [item.id, item]),
      );
      const reserved = await tx.registrations.reservedByLine(workOrderId);
      const lines: NewLine[] = request.lines.map((line) => {
        const item = assertAssignable(items, line.workOrderItemId);
        const quantity = Decimal.parse(line.quantity);
        const unitPrice = Decimal.parse(line.unitPrice);
        assertQuantityFits(item, reservedOf(reserved, item.id), quantity);
        assertPriceWithinContract(item, unitPrice);
        return {
          id: this.ids.next(),
          workOrderItemId: item.id,
          quantity,
          firstPrice: {
            id: this.ids.next(),
            effectiveFrom: request.registeredOn,
            unitPrice,
            createdById: actorId,
          },
        };
      });

      const registrationId = this.ids.next();
      await tx.registrations.insert({
        id: registrationId,
        projectId,
        workOrderId,
        contractorId: request.contractorId,
        registeredOn: request.registeredOn,
        createdById: actorId,
        lines,
      });
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.contractorRegistration,
        entityId: registrationId,
        type: EVENT_TYPES.contractorRegistered,
        actorId,
        payload: {
          contractorId: request.contractorId,
          contractorName: contractor.name,
          workOrderId,
          registeredOn: request.registeredOn,
          lines: lines.map((line) => ({
            id: line.id,
            workOrderItemId: line.workOrderItemId,
            code: items.get(line.workOrderItemId)?.code,
            quantity: line.quantity.toString(),
            unitPrice: line.firstPrice.unitPrice.toString(),
          })),
        },
      });
      return viewOf(tx.registrations, projectId, project.currency);
    });
  }
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

export class AddContractorLineUseCase {
  constructor(
    private readonly projects: Projects,
    private readonly uow: ContractorUnitOfWork,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    input: Scope & { registrationId: string; request: AddContractorLineRequest },
  ): Promise<ProjectContractorsView> {
    const { projectId, actorId, registrationId, request } = input;
    const project = await this.projects.execute(projectId);
    return this.uow.run(async (tx) => {
      const registration = await lockedRegistration(tx, projectId, registrationId);
      const items = new Map(
        (await tx.registrations.workOrderLines(registration.workOrderId)).map((item) => [
          item.id,
          item,
        ]),
      );
      const item = assertAssignable(items, request.workOrderItemId);
      if (registration.lines.some((line) => line.item.id === item.id)) {
        throw new AppError('CONFLICT', 'The contractor already has this line', {
          reason: 'LINE_REPEATED',
          workOrderItemId: item.id,
          code: item.code,
        });
      }
      const quantity = Decimal.parse(request.quantity);
      const unitPrice = Decimal.parse(request.unitPrice);
      const reserved = await tx.registrations.reservedByLine(registration.workOrderId);
      assertQuantityFits(item, reservedOf(reserved, item.id), quantity);
      assertPriceWithinContract(item, unitPrice);

      const line: NewLine = {
        id: this.ids.next(),
        workOrderItemId: item.id,
        quantity,
        firstPrice: {
          id: this.ids.next(),
          effectiveFrom: registration.registeredOn,
          unitPrice,
          createdById: actorId,
        },
      };
      await tx.registrations.insertLine(projectId, registrationId, line);
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.contractorLine,
        entityId: line.id,
        type: EVENT_TYPES.contractorLineAdded,
        actorId,
        payload: {
          registrationId,
          workOrderItemId: item.id,
          code: item.code,
          quantity: quantity.toString(),
          unitPrice: unitPrice.toString(),
          effectiveFrom: registration.registeredOn,
        },
      });
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
      const reserved = await tx.registrations.reservedByLine(registration.workOrderId);
      // The line itself is not "other" reservation: take its current quantity out.
      const others = reservedOf(reserved, line.item.id).sub(line.quantity);
      assertQuantityFits(line.item, others, quantity);
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
      assertPriceWithinContract(line.item, unitPrice);
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
