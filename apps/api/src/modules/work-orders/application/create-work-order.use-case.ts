import { EVENT_ENTITIES, EVENT_TYPES, type CreateWorkOrderRequest } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { assertLinesFit, lineFromContract } from '../domain/contract-lines.js';
import { Decimal } from '../domain/decimal.js';
import { WorkOrder } from '../domain/work-order.js';
import type { WorkOrderUnitOfWork } from '../domain/work-order.repository.js';
import type { ProjectCurrencyLookup } from './ports.js';
import type { WorkOrderView } from './work-order-queries.js';

/**
 * Creates the project's single work order from lines of its approved contract (ADR-028). The
 * contract row is locked first, so the reservation check and the insert see the same numbers.
 */
export class CreateWorkOrderUseCase {
  constructor(
    private readonly uow: WorkOrderUnitOfWork,
    private readonly projects: ProjectCurrencyLookup,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    projectId: string;
    actorId: string;
    request: CreateWorkOrderRequest;
  }): Promise<WorkOrderView> {
    const { projectId, actorId, request } = input;
    const currency = await this.projects.currencyOf(projectId);

    const order = await this.uow.run(async (tx) => {
      const contract = await tx.contracts.loadApproved(projectId, { lock: true });
      if (await tx.orders.existsForProject(projectId)) {
        throw new AppError('CONFLICT', 'The project already has a work order', {
          reason: 'WORK_ORDER_EXISTS',
        });
      }
      const lines = request.lines.map((line) =>
        lineFromContract(contract, line.contractItemId, Decimal.parse(line.quantity)),
      );
      const created = WorkOrder.create(
        {
          projectId,
          number: request.number,
          title: request.title,
          issuedOn: request.issuedOn,
          notes: request.notes,
          currency,
          source: 'manual',
          items: lines,
          createdById: actorId,
        },
        this.ids,
        this.clock.now(),
      );
      assertLinesFit(contract, await tx.contracts.reservations(contract.id), lines);

      await tx.orders.insert(created);
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.workOrder,
        entityId: created.header.id,
        type: EVENT_TYPES.workOrderCreated,
        actorId,
        payload: {
          number: created.header.number,
          title: created.header.title,
          issuedOn: created.header.issuedOn,
          currency,
          contractId: contract.id,
          itemCount: created.items.length,
          total: created.total.toString(),
          contractItemIds: created.items.map((item) => item.contractItemId),
        },
      });
      return created;
    });
    return { order, attachments: [] };
  }
}
