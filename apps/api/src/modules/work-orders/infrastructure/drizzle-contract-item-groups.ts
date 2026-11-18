import type { ItemGroup, ManualItemGroup } from '@ftth/shared';
import { asc, desc, inArray } from 'drizzle-orm';
import { itemGroupStates } from '../../../common/item-groups.js';
import type { DbHandle } from '../../../db/db.module.js';
import { contractItemGroupChoices, contractItems } from '../../../db/schema.js';
import type { ContractItemGroups } from '../domain/work-order.repository.js';

/** Reads contract lines and the admin's choices straight from their tables, read-only (like the catalog). */
export class DrizzleContractItemGroups implements ContractItemGroups {
  constructor(private readonly db: DbHandle) {}

  async groupsOf(contractItemIds: readonly string[]): Promise<Map<string, ItemGroup>> {
    const wanted = new Set(contractItemIds);
    const result = new Map<string, ItemGroup>();
    if (wanted.size === 0) return result;

    const owners = await this.db
      .selectDistinct({ contractId: contractItems.contractId })
      .from(contractItems)
      .where(inArray(contractItems.id, [...wanted]));
    const contractIds = owners.map((row) => row.contractId);
    if (contractIds.length === 0) return result;

    // Whole BOQs, in two queries for all contracts: the rule reads the headings above each line.
    const lines = await this.db
      .select({
        id: contractItems.id,
        contractId: contractItems.contractId,
        kind: contractItems.kind,
        code: contractItems.code,
        description: contractItems.description,
        unit: contractItems.unit,
      })
      .from(contractItems)
      .where(inArray(contractItems.contractId, contractIds))
      .orderBy(asc(contractItems.contractId), asc(contractItems.lineNo));
    const choices = await this.db
      .select()
      .from(contractItemGroupChoices)
      .where(inArray(contractItemGroupChoices.contractId, contractIds))
      .orderBy(desc(contractItemGroupChoices.chosenAt), desc(contractItemGroupChoices.id));

    const manual = new Map<string, ManualItemGroup>();
    for (const row of choices) {
      if (manual.has(row.contractItemId)) continue; // newest first
      manual.set(row.contractItemId, {
        group: row.mainGroup === null ? null : { main: row.mainGroup, sub: row.subGroup },
      });
    }

    for (const contractId of contractIds) {
      const states = itemGroupStates(
        lines.filter((line) => line.contractId === contractId),
        manual,
      );
      for (const [id, state] of states) {
        if (wanted.has(id) && state.group) result.set(id, state.group);
      }
    }
    return result;
  }
}
