import { ELEMENT_KEYS, type ElementKey, type ManualItemGroup } from '@ftth/shared';
import { sql } from 'drizzle-orm';
import { itemGroupStates } from '../../../common/item-groups.js';
import type { Database, DbHandle } from '../../../db/db.module.js';
import { DrizzleEventLog } from '../../../db/drizzle-event-log.js';
import { rowsOf } from '../../../db/sql.js';
import type { DomainEventInput } from '../../../common/event-log.port.js';
import type {
  ElementGroupAdmin,
  ElementGroupAdminTx,
  ElementGroupRow,
  UsedMainGroup,
} from '../application/ports.js';

interface MapRow extends Record<string, unknown> {
  element: ElementKey;
  mains: string[];
  version: number;
}

const toRow = (row: MapRow): ElementGroupRow => ({
  element: row.element,
  mains: row.mains,
  version: row.version,
});

class DrizzleElementGroupAdminTx implements ElementGroupAdminTx {
  private readonly events: DrizzleEventLog;

  constructor(private readonly db: DbHandle) {
    this.events = new DrizzleEventLog(db);
  }

  async lockElement(element: ElementKey): Promise<ElementGroupRow | null> {
    const [row] = await rowsOf<MapRow>(
      this.db,
      sql`SELECT element, mains, version FROM element_group_map
          WHERE element = ${element} FOR UPDATE`,
    );
    return row ? toRow(row) : null;
  }

  async replace(input: {
    element: ElementKey;
    mains: readonly string[];
    version: number;
    actorId: string;
    at: Date;
  }): Promise<void> {
    // The array literal is built by the driver from a JSON array: no string splicing of names.
    await this.db.execute(sql`
      UPDATE element_group_map
      SET mains = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(input.mains)}::jsonb)),
          version = ${input.version}, updated_by = ${input.actorId},
          updated_at = ${input.at.toISOString()}
      WHERE element = ${input.element}`);
  }

  async appendEvent(event: DomainEventInput): Promise<void> {
    await this.events.append(event);
  }
}

export class DrizzleElementGroupAdmin implements ElementGroupAdmin {
  constructor(private readonly db: Database) {}

  async list(): Promise<ElementGroupRow[]> {
    const rows = await rowsOf<MapRow>(
      this.db,
      sql`SELECT element, mains, version FROM element_group_map`,
    );
    return rows
      .map(toRow)
      .sort((a, b) => ELEMENT_KEYS.indexOf(a.element) - ELEMENT_KEYS.indexOf(b.element));
  }

  async usedMainGroups(): Promise<UsedMainGroup[]> {
    // Whole BOQs of every contract: the rule reads the headings above each line.
    const lines = await rowsOf<{
      id: string;
      contract_id: string;
      kind: 'item' | 'heading';
      code: string;
      description: string | null;
      unit: string | null;
    }>(
      this.db,
      sql`SELECT id, contract_id, kind, code, description, unit FROM contract_items
          ORDER BY contract_id, line_no`,
    );
    const choices = await rowsOf<{
      contract_item_id: string;
      main_group: string | null;
      sub_group: string | null;
    }>(
      this.db,
      // Newest first: the first row seen for an item is in force.
      sql`SELECT contract_item_id, main_group, sub_group FROM contract_item_group_choices
          ORDER BY chosen_at DESC, id DESC`,
    );
    const manual = new Map<string, ManualItemGroup>();
    for (const row of choices) {
      if (manual.has(row.contract_item_id)) continue;
      manual.set(row.contract_item_id, {
        group: row.main_group === null ? null : { main: row.main_group, sub: row.sub_group },
      });
    }
    const byContract = new Map<string, typeof lines>();
    for (const line of lines) {
      const list = byContract.get(line.contract_id) ?? [];
      list.push(line);
      byContract.set(line.contract_id, list);
    }
    const counts = new Map<string, number>();
    for (const contractLines of byContract.values()) {
      const states = itemGroupStates(
        contractLines.map((line) => ({
          id: line.id,
          kind: line.kind,
          code: line.code,
          description: line.description,
          unit: line.unit,
        })),
        manual,
      );
      for (const state of states.values()) {
        if (state.group) counts.set(state.group.main, (counts.get(state.group.main) ?? 0) + 1);
      }
    }
    return [...counts].map(([main, lineCount]) => ({ main, lineCount }));
  }

  run<T>(work: (tx: ElementGroupAdminTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(new DrizzleElementGroupAdminTx(tx)));
  }
}
