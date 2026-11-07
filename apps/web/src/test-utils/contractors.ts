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
export const ITEM_BOX = '5a000000-0000-4000-8000-000000000004';
export const LINE_1 = '6a000000-0000-4000-8000-000000000001';
export const LINE_BOX = '6a000000-0000-4000-8000-000000000005';
export const FILE_ID = '8a000000-0000-4000-8000-000000000001';

export const SCOPE_BRACKET = 'تركيب الخوصة';
export const SCOPE_BOX = 'تركيب البوكس';
export const SCOPE_SPLICE = 'لحام البوكس';

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
    scope: null,
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
    sourceRow: 2,
    ...overrides,
  };
}

/** The owner's example: the box line 2-12-4-8, one scope of three, done by this contractor. */
export function boxLine(overrides: Partial<ContractorLine> = {}): ContractorLine {
  return contractorLine({
    id: LINE_BOX,
    workOrderItemId: ITEM_BOX,
    lineNo: 4,
    code: '2-12-4-8',
    description: 'Box',
    unit: 'no',
    scope: SCOPE_BOX,
    contractPrice: '30',
    quantity: '20',
    prices: [
      {
        id: '7a000000-0000-4000-8000-000000000011',
        effectiveFrom: '2026-11-01',
        unitPrice: '12',
        createdById: null,
        createdAt: ISO,
      },
    ],
    sourceRow: 3,
    ...overrides,
  });
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
    files: [
      {
        id: FILE_ID,
        fileName: 'nile-cables.xlsx',
        sizeBytes: 5120,
        sha256: 'a'.repeat(64),
        uploadedById: null,
        createdAt: '2026-11-01T08:00:00.000Z',
      },
    ],
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
    mode: 'whole',
    scopes: [
      { scope: null, reservedQuantity: '10', availableQuantity: '40', highestPrice: '90.5' },
    ],
    scopesPriceTotal: '90.5',
    priceRoom: '9.5',
    assignable: true,
    ...overrides,
  };
}

/** The box line split in three scopes whose prices add up to the contract price (30). */
export function boxAvailability(): ContractorLineAvailability {
  return availabilityLine({
    workOrderItemId: ITEM_BOX,
    lineNo: 4,
    code: '2-12-4-8',
    description: 'Box',
    unit: 'no',
    contractPrice: '30',
    workOrderQuantity: '100',
    mode: 'scoped',
    scopes: [
      { scope: SCOPE_BRACKET, reservedQuantity: '100', availableQuantity: '0', highestPrice: '10' },
      { scope: SCOPE_BOX, reservedQuantity: '20', availableQuantity: '80', highestPrice: '12' },
      { scope: SCOPE_SPLICE, reservedQuantity: '50', availableQuantity: '50', highestPrice: '8' },
    ],
    scopesPriceTotal: '30',
    priceRoom: '0',
  });
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
        mode: 'free',
        scopes: [],
        scopesPriceTotal: '0',
        priceRoom: '12.5',
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

/** A project whose box line is split by scope; this contractor holds the «install box» scope. */
export function scopedProject(): ProjectContractorsResponse {
  return projectContractors({
    registrations: [registration({ lines: [contractorLine(), boxLine()] })],
    availability: [availabilityLine(), boxAvailability()],
  });
}
