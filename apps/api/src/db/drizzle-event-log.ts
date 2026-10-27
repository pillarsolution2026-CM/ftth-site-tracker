import type { DbHandle } from './db.module.js';
import type { DomainEventInput, EventLog } from '../common/event-log.port.js';
import { events } from './schema.js';

export class DrizzleEventLog implements EventLog {
  constructor(private readonly db: DbHandle) {}

  async append(event: DomainEventInput): Promise<void> {
    await this.db.insert(events).values({
      projectId: event.projectId ?? null,
      entity: event.entity,
      entityId: event.entityId,
      type: event.type,
      payload: event.payload ?? {},
      actorId: event.actorId ?? null,
    });
  }
}
