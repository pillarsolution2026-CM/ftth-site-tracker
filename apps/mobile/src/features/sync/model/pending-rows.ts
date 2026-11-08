import type { ExecutionUpdate, ProposePlacementPointOp, RecordUpdateOp } from '@ftth/shared';
import type { OutboxEntry } from '@ftth/sync';

export type PendingRow =
  | { type: 'update'; entry: OutboxEntry; op: RecordUpdateOp }
  | { type: 'gps_point'; entry: OutboxEntry; op: ProposePlacementPointOp };

/**
 * Operations the «في الانتظار» list shows: execution updates and GPS point proposals. As-Built
 * edits have their own list. The switch is exhaustive, so a new op kind must be handled here.
 */
export function pendingRows(entries: readonly OutboxEntry[]): PendingRow[] {
  return entries.flatMap((entry): PendingRow[] => {
    const op = entry.op;
    switch (op.kind) {
      case 'execution_update.record':
        return [{ type: 'update', entry, op }];
      case 'placement_point.propose':
        return [{ type: 'gps_point', entry, op }];
      case 'asbuilt_edit.record':
        return [];
      default: {
        const unhandled: never = op;
        return unhandled;
      }
    }
  });
}

/** Remote execution-update review is looked up only for updates. */
export function reviewFor(
  row: PendingRow,
  remote: ReadonlyMap<string, ExecutionUpdate>,
): ExecutionUpdate | undefined {
  return row.type === 'update' ? remote.get(row.entry.clientOpId) : undefined;
}
