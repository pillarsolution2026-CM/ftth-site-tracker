import type { ItemGroup } from '@ftth/shared';
import type { ContractItemGroups } from '../domain/work-order.repository.js';

/** Groups of the contract items of work-order lines (ADR-048): contract item id → group. */
export class ResolveItemGroupsUseCase {
  constructor(private readonly groups: ContractItemGroups) {}

  execute(items: readonly { contractItemId: string | null }[]): Promise<Map<string, ItemGroup>> {
    const ids = new Set<string>();
    for (const item of items) if (item.contractItemId !== null) ids.add(item.contractItemId);
    return this.groups.groupsOf([...ids]);
  }
}
