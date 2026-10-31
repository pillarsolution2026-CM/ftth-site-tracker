import { lineAmount, type Contract, type ContractLine } from '../domain/contract.js';

/** Event payload fragments. Money and quantities are decimal strings; dates are ISO text. */
export function lineSnapshot(line: ContractLine): Record<string, unknown> {
  return {
    id: line.id,
    lineNo: line.lineNo,
    kind: line.kind,
    code: line.code,
    description: line.description,
    unit: line.unit,
    quantity: line.quantity?.toString() ?? null,
    unitPrice: line.unitPrice?.toString() ?? null,
    amount: lineAmount(line)?.toString() ?? null,
    workType: line.workType,
    source: line.source,
    sourceRow: line.sourceRow,
  };
}

/** Full copy of the BOQ, written with the approval event. */
export function boqSnapshot(contract: Contract): Record<string, unknown> {
  const { header } = contract;
  return {
    number: header.number,
    name: header.name,
    client: header.client,
    currency: header.currency,
    itemCount: contract.items.length,
    headingCount: contract.lines.length - contract.items.length,
    total: contract.total.toString(),
    lines: contract.lines.map(lineSnapshot),
  };
}
