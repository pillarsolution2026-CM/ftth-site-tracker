/** Port for the append-only `events` table. Every state change writes one immutable row. */
export interface DomainEventInput {
  projectId?: string | null;
  entity: string;
  entityId: string;
  type: string;
  payload?: Record<string, unknown>;
  actorId?: string | null;
}

export interface EventLog {
  append(event: DomainEventInput): Promise<void>;
}

export const EVENT_LOG = 'EVENT_LOG';
