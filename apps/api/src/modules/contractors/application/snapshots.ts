import type { ContractorLine, ContractorPrice, Registration } from '../domain/contractor.js';

/** Event payload fragments. Quantities and money are decimal strings; dates are ISO text. */
export const priceSnapshot = (price: ContractorPrice): Record<string, unknown> => ({
  id: price.id,
  effectiveFrom: price.effectiveFrom,
  unitPrice: price.unitPrice.toString(),
});

export const lineSnapshot = (line: ContractorLine): Record<string, unknown> => ({
  id: line.id,
  workOrderItemId: line.item.id,
  lineNo: line.item.lineNo,
  code: line.item.code,
  scope: line.scope,
  sourceRow: line.sourceRow,
  quantity: line.quantity.toString(),
  prices: line.prices.map(priceSnapshot),
});

/** Full copy of a registration, written when its rows are deleted. */
export const registrationSnapshot = (registration: Registration): Record<string, unknown> => ({
  id: registration.id,
  workOrderId: registration.workOrderId,
  contractorId: registration.contractor.id,
  contractorName: registration.contractor.name,
  registeredOn: registration.registeredOn,
  lines: registration.lines.map(lineSnapshot),
  files: registration.files.map((file) => ({
    id: file.id,
    fileName: file.fileName,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
  })),
});
