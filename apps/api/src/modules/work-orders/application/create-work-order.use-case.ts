import { EVENT_ENTITIES, EVENT_TYPES, type CreateWorkOrderRequest } from '@ftth/shared';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { Decimal } from '../domain/decimal.js';
import { WorkOrder } from '../domain/work-order.js';
import type { WorkOrderUnitOfWork } from '../domain/work-order.repository.js';
import type { ProjectCurrencyLookup } from './ports.js';
import type { WorkOrderView } from './work-order-queries.js';

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
    const order = WorkOrder.create(
      {
        projectId,
        number: request.number,
        title: request.title,
        issuedOn: request.issuedOn,
        notes: request.notes,
        currency,
        source: 'manual',
        items: request.items.map((item) => ({
          ...item,
          quantity: Decimal.parse(item.quantity),
          unitPrice: Decimal.parse(item.unitPrice),
        })),
        acceptedDuplicateCodes: request.acceptedDuplicateCodes,
        createdById: actorId,
      },
      this.ids,
      this.clock.now(),
    );

    await this.uow.run(async (tx) => {
      await tx.orders.insert(order);
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.workOrder,
        entityId: order.header.id,
        type: EVENT_TYPES.workOrderCreated,
        actorId,
        payload: {
          number: order.header.number,
          title: order.header.title,
          issuedOn: order.header.issuedOn,
          currency,
          itemCount: order.items.length,
          total: order.total.toString(),
          acceptedDuplicateCodes: request.acceptedDuplicateCodes,
        },
      });
    });
    return { order, attachments: [] };
  }
}
