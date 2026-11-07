import type {
  Contractor,
  ContractorLine,
  ContractorLineAvailability,
  ContractorRegistration,
  ProjectContractorsResponse,
} from '@ftth/shared';
import { PROJECT_ID } from './render';

const ISO = '2026-11-07T08:00:00.000Z';
export const WORK_ORDER_ID = '2b1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';
export const CONTRACTOR_ID = '3c1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';
export const CONTRACTOR_2_ID = '3d1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';
export const REGISTRATION_ID = '4c1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';
export const ITEM_1 = '5a000000-0000-4000-8000-000000000001';
export const ITEM_2 = '5a000000-0000-4000-8000-000000000002';
export const ITEM_LEGACY = '5a000000-0000-4000-8000-000000000003';
export const LINE_1 = '6a000000-0000-4000-8000-000000000001';

export function contractor(overrides: Partial<Contractor> = {}): Contractor {
  return {
    id: CONTRACTOR_ID,
    name: 'Nile Cables',
    contactName: 'Hassan Ali',
    contactPhone: '+20 100 123 4567',
    commercialRegister: 'CR-123',
    taxCard: null,
    workOrderCount: 2,
    version: 1,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

export function contractorLine(overrides: Partial<ContractorLine> = {}): ContractorLine {
  return {
    id: LINE_1,
    workOrderItemId: ITEM_1,
    lineNo: 1,
    code: 'C-001',
    description: 'Trenching',
    unit: 'm',
    workType: 'civil',
    contractPrice: '100',
    quantity: '10',
    prices: [
      {
        id: '7a000000-0000-4000-8000-000000000001',
        effectiveFrom: '2026-11-01',
        unitPrice: '80',
        createdById: null,
        createdAt: ISO,
      },
      {
        id: '7a000000-0000-4000-8000-000000000002',
        effectiveFrom: '2026-11-05',
        unitPrice: '90.5',
        createdById: null,
        createdAt: ISO,
      },
    ],
    ...overrides,
  };
}

export function registration(
  overrides: Partial<ContractorRegistration> = {},
): ContractorRegistration {
  return {
    id: REGISTRATION_ID,
    projectId: PROJECT_ID,
    workOrderId: WORK_ORDER_ID,
    contractor: {
      id: CONTRACTOR_ID,
      name: 'Nile Cables',
      contactName: 'Hassan Ali',
      contactPhone: '+20 100 123 4567',
      commercialRegister: 'CR-123',
      taxCard: null,
    },
    registeredOn: '2026-11-01',
    lines: [contractorLine()],
    createdById: null,
    createdAt: ISO,
    ...overrides,
  };
}

export function availabilityLine(
  overrides: Partial<ContractorLineAvailability> = {},
): ContractorLineAvailability {
  return {
    workOrderItemId: ITEM_1,
    lineNo: 1,
    code: 'C-001',
    description: 'Trenching',
    unit: 'm',
    workType: 'civil',
    contractPrice: '100',
    workOrderQuantity: '50',
    reservedQuantity: '10',
    availableQuantity: '40',
    assignable: true,
    ...overrides,
  };
}

export function projectContractors(
  overrides: Partial<ProjectContractorsResponse> = {},
): ProjectContractorsResponse {
  return {
    projectId: PROJECT_ID,
    workOrderId: WORK_ORDER_ID,
    currency: 'EGP',
    registrations: [registration()],
    availability: [
      availabilityLine(),
      availabilityLine({
        workOrderItemId: ITEM_2,
        lineNo: 2,
        code: 'C-002',
        description: 'Cabling',
        contractPrice: '12.5',
        workOrderQuantity: '200',
        reservedQuantity: '0',
        availableQuantity: '200',
      }),
      availabilityLine({
        workOrderItemId: ITEM_LEGACY,
        lineNo: 3,
        code: 'OLD-1',
        description: 'Legacy work',
        assignable: false,
      }),
    ],
    ...overrides,
  };
}
