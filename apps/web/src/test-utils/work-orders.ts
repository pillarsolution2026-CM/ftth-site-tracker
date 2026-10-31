import type {
  ContractItemAvailability,
  ContractItemAvailabilityResponse,
  WorkOrderDetail,
  WorkOrderItem,
} from '@ftth/shared';
import { PROJECT_ID } from './render';

export const WORK_ORDER_ID = '1f8fad5b-d9cb-469f-a165-70867728950e';
export const CONTRACT_ID = '3f8fad5b-d9cb-469f-a165-70867728950e';
export const ITEM_A = 'a1000000-0000-4000-8000-000000000001';
export const ITEM_B = 'a1000000-0000-4000-8000-000000000002';
export const LINE_A = 'b1000000-0000-4000-8000-000000000001';

export function availability(
  overrides: Partial<ContractItemAvailability> = {},
): ContractItemAvailability {
  return {
    contractItemId: ITEM_A,
    lineNo: 1,
    code: 'A-1',
    description: 'Trench',
    unit: 'm',
    unitPrice: '8000',
    workType: 'civil',
    contractQuantity: '100',
    reservedQuantity: '30',
    availableQuantity: '70',
    workOrderItemId: null,
    ...overrides,
  };
}

export function availabilityResponse(
  items: ContractItemAvailability[] = [
    availability(),
    availability({
      contractItemId: ITEM_B,
      lineNo: 2,
      code: 'B-2',
      description: 'Splice',
      unit: 'pc',
      workType: 'installation',
      contractQuantity: '10',
      reservedQuantity: '0',
      availableQuantity: '10',
    }),
  ],
): ContractItemAvailabilityResponse {
  return { contractId: CONTRACT_ID, contractNumber: 'C-2026-1', items };
}

export function workOrderItem(overrides: Partial<WorkOrderItem> = {}): WorkOrderItem {
  return {
    id: LINE_A,
    workOrderId: WORK_ORDER_ID,
    lineNo: 1,
    code: 'A-1',
    description: 'Trench',
    unit: 'm',
    quantity: '20',
    unitPrice: '8000',
    amount: '160000',
    workType: 'civil',
    contractItemId: ITEM_A,
    source: 'manual',
    sourceRow: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function workOrderDetail(items: WorkOrderItem[] = [workOrderItem()]): WorkOrderDetail {
  return {
    id: WORK_ORDER_ID,
    projectId: PROJECT_ID,
    number: 'WO-1',
    title: null,
    issuedOn: null,
    currency: 'EGP',
    source: 'manual',
    itemCount: items.length,
    total: '160000',
    attachmentCount: 0,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    notes: null,
    items,
    attachments: [],
    duplicateCodes: [],
  };
}
