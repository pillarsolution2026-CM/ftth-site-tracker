import type { ManualItemGroup } from '@ftth/shared';
import { desc, eq } from 'drizzle-orm';
import type { DbHandle } from '../../../db/db.module.js';
import { contractItemGroupChoices } from '../../../db/schema.js';
import type {
  ContractItemGroupRepository,
  ItemGroupChoice,
} from '../domain/contract.repository.js';

export class DrizzleContractItemGroupRepository implements ContractItemGroupRepository {
  constructor(private readonly db: DbHandle) {}

  async latestByContract(contractId: string): Promise<Map<string, ManualItemGroup>> {
    const rows = await this.db
      .select()
      .from(contractItemGroupChoices)
      .where(eq(contractItemGroupChoices.contractId, contractId))
      .orderBy(desc(contractItemGroupChoices.chosenAt), desc(contractItemGroupChoices.id));
    const latest = new Map<string, ManualItemGroup>();
    // Newest first: the first row seen for an item is in force.
    for (const row of rows) {
      if (latest.has(row.contractItemId)) continue;
      latest.set(row.contractItemId, {
        group: row.mainGroup === null ? null : { main: row.mainGroup, sub: row.subGroup },
      });
    }
    return latest;
  }

  async insert(choice: ItemGroupChoice): Promise<void> {
    await this.db.insert(contractItemGroupChoices).values({
      id: choice.id,
      contractId: choice.contractId,
      contractItemId: choice.contractItemId,
      mainGroup: choice.group?.main ?? null,
      subGroup: choice.group?.sub ?? null,
      chosenBy: choice.chosenById,
      chosenAt: choice.chosenAt,
    });
  }
}
