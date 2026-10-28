import { itemAmount, type WorkOrder, type WorkOrderItem } from '../domain/work-order.js';

/** Event payload fragments. Money and quantities are decimal strings; dates are ISO text. */
export function itemSnapshot(item: WorkOrderItem): Record<string, unknown> {
  return {
    id: item.id,
    lineNo: item.lineNo,
    code: item.code,
    description: item.description,
    unit: item.unit,
    quantity: item.quantity.toString(),
    unitPrice: item.unitPrice.toString(),
    amount: itemAmount(item).toString(),
    workType: item.workType,
    source: item.source,
    sourceRow: item.sourceRow,
  };
}

/** Full copy of header and items, kept in the event when a work order is hard-deleted. */
export function orderSnapshot(order: WorkOrder): Record<string, unknown> {
  const { header } = order;
  return {
    id: header.id,
    number: header.number,
    title: header.title,
    issuedOn: header.issuedOn,
    notes: header.notes,
    currency: header.currency,
    source: header.source,
    version: header.version,
    total: order.total.toString(),
    items: order.items.map(itemSnapshot),
  };
}

/** `{ before, after }` restricted to the fields whose value changed. */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changed = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
  for (const key of Object.keys(after)) {
    if (before[key] === after[key]) continue;
    changed.before[key] = before[key];
    changed.after[key] = after[key];
  }
  return changed;
}
