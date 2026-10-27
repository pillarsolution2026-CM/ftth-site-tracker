import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { DomainEventInput, EventLog } from '../common/event-log.port.js';
import { events, type schema } from './schema.js';

export class DrizzleEventLog implements EventLog {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

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
