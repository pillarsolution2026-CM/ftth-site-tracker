import type { ContractDetail, ContractItem } from '@ftth/shared';

export const CONTRACT_ID = '4a1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';

const ISO = '2026-10-31T08:00:00.000Z';

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

export function heading(
  lineNo: number,
  code: string,
  description: string | null,
  parentCode: string | null = null,
): ContractItem {
  return {
    id: uuid(),
    contractId: CONTRACT_ID,
    lineNo,
    kind: 'heading',
    code,
    description,
    parentCode,
    unit: null,
    quantity: null,
    unitPrice: null,
    amount: null,
    workType: null,
    source: 'import',
    sourceRow: lineNo + 1,
  };
}

export function pricedItem(
  lineNo: number,
  code: string,
  overrides: Partial<ContractItem> = {},
): ContractItem {
  return {
    id: uuid(),
    contractId: CONTRACT_ID,
    lineNo,
    kind: 'item',
    code,
    description: `Item ${code}`,
    parentCode: null,
    unit: 'm',
    quantity: '10',
    unitPrice: '2.5',
    amount: '25',
    workType: 'civil',
    source: 'manual',
    sourceRow: null,
    ...overrides,
  };
}

export function contractDetail(overrides: Partial<ContractDetail> = {}): ContractDetail {
  return {
    id: CONTRACT_ID,
    number: 'C-2026-01',
    name: 'FTTH Cairo',
    client: 'Telecom Co',
    currency: 'EGP',
    startsOn: '2026-01-01',
    durationDays: 365,
    status: 'draft',
    approvedAt: null,
    itemCount: 2,
    total: '52.5',
    projectCount: 0,
    version: 3,
    createdAt: ISO,
    updatedAt: ISO,
    notes: null,
    approvedById: null,
    items: [
      heading(1, '1', 'Civil works'),
      pricedItem(2, '1-1', { parentCode: '1' }),
      pricedItem(3, '1-1-1', {
        parentCode: '1-1',
        unit: 'BULDING (1 to 8)',
        quantity: '5',
        unitPrice: '5.5',
        amount: '27.5',
      }),
    ],
    attachments: [],
    duplicateCodes: [],
    ...overrides,
  };
}
