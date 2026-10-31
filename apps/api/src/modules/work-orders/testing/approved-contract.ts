import type { ApprovedContract, ContractItemInfo } from '../domain/contract-lines.js';
import { Decimal } from '../domain/decimal.js';
import { parseImport } from '../domain/import/import-parser.js';
import { ExcelJsWorkbookReader } from '../infrastructure/exceljs-workbook-reader.js';
import { buildContractSheet } from './work-order-contract-sheets.js';

export const CONTRACT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** Contract item id of a sheet row, stable across tests. */
export const itemIdOfRow = (rowNumber: number): string =>
  `cccccccc-0000-4000-8000-${String(rowNumber).padStart(12, '0')}`;

/** The synthetic contract sheet read like a contract import: priced items in line order. */
export async function approvedContractFromSheet(): Promise<ApprovedContract> {
  const parsed = parseImport(
    await new ExcelJsWorkbookReader().read(await buildContractSheet()),
    {},
  );
  const items: ContractItemInfo[] = [];
  for (const row of parsed.rows) {
    if (row.kind !== 'item') continue;
    items.push({
      id: itemIdOfRow(row.rowNumber),
      lineNo: row.rowNumber - 3,
      code: row.code ?? '',
      description: row.description ?? '',
      unit: row.unit ?? '',
      unitPrice: Decimal.parse(row.unitPrice ?? '0'),
      workType: row.workType ?? 'civil',
      quantity: Decimal.parse(row.quantity ?? '0'),
    });
  }
  return { id: CONTRACT_ID, number: 'C-1', items };
}
