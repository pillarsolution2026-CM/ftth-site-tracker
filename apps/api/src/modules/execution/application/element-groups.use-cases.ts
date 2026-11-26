import {
  EVENT_TYPES,
  type ElementGroupsResponse,
  type ElementKey,
  type ReplaceElementGroupsRequest,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { ElementGroupAdmin, ElementGroupRow, UsedMainGroup } from './ports.js';

/** Entity of the `events` rows written when the admin changes the map (entity id = the element). */
export const ELEMENT_GROUPS_ENTITY = 'element_groups';

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The admin view (ADR-056): every element with its version, the main groups used by contract lines
 * that no element offers (`unlinked`, with the number of lines), and every used main group.
 * Pure: the lists are what the repository read.
 */
export function buildElementGroupsResponse(
  rows: readonly ElementGroupRow[],
  used: readonly UsedMainGroup[],
): ElementGroupsResponse {
  const linked = new Set(rows.flatMap((row) => row.mains));
  return {
    elements: rows.map((row) => ({
      element: row.element,
      mains: [...row.mains],
      version: row.version,
    })),
    unlinked: used
      .filter((entry) => !linked.has(entry.main))
      .map((entry) => ({ main: entry.main, lineCount: entry.lineCount }))
      .sort((a, b) => byName(a.main, b.main)),
    knownMains: used.map((entry) => entry.main).sort(byName),
  };
}

export class GetElementGroupsUseCase {
  constructor(private readonly admin: ElementGroupAdmin) {}

  async execute(): Promise<ElementGroupsResponse> {
    const [rows, used] = await Promise.all([this.admin.list(), this.admin.usedMainGroups()]);
    return buildElementGroupsResponse(rows, used);
  }
}

/**
 * Replaces one element's main groups (ADR-056). Optimistic concurrency by version; the change is an
 * event with the list before and after. The map only guides the device: nothing else is checked
 * (a name that no contract line uses yet is allowed, the admin may prepare it).
 */
export class ReplaceElementGroupsUseCase {
  constructor(
    private readonly admin: ElementGroupAdmin,
    private readonly clock: Clock,
    private readonly get: GetElementGroupsUseCase,
  ) {}

  async execute(input: {
    element: ElementKey;
    actorId: string;
    request: ReplaceElementGroupsRequest;
  }): Promise<ElementGroupsResponse> {
    const { element, actorId, request } = input;
    await this.admin.run(async (tx) => {
      const current = await tx.lockElement(element);
      if (!current) throw new AppError('NOT_FOUND', 'Element not found');
      if (current.version !== request.expectedVersion) {
        throw new AppError('CONFLICT', 'The element groups were changed by someone else', {
          reason: 'STALE_VERSION',
          currentVersion: current.version,
        });
      }
      const version = current.version + 1;
      await tx.replace({ element, mains: request.mains, version, actorId, at: this.clock.now() });
      await tx.appendEvent({
        projectId: null,
        entity: ELEMENT_GROUPS_ENTITY,
        entityId: element,
        type: EVENT_TYPES.elementGroupsChanged,
        actorId,
        payload: { element, before: current.mains, after: [...request.mains], version },
      });
    });
    return this.get.execute();
  }
}
