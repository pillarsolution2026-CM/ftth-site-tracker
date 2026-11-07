import { describe, expect, it } from 'vitest';
import { hasPermission } from '../auth/permissions.js';
import {
  AddContractorPriceRequestSchema,
  CreateContractorRequestSchema,
  RegisterContractorRequestSchema,
  UpdateContractorLineRequestSchema,
  UpdateContractorRequestSchema,
} from './contractor.schemas.js';

const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';
const CONTRACTOR = '33333333-3333-4333-8333-333333333333';

describe('contractor list input', () => {
  const valid = { name: 'شركة النور', contactName: 'أحمد علي', contactPhone: '+20 100 123 4567' };

  it('requires name, contact person and phone; register and tax card are optional', () => {
    expect(CreateContractorRequestSchema.parse(valid)).toMatchObject(valid);
    expect(CreateContractorRequestSchema.safeParse({ ...valid, contactPhone: '' }).success).toBe(
      false,
    );
    expect(
      CreateContractorRequestSchema.safeParse({ name: 'x', contactPhone: '010' }).success,
    ).toBe(false);
    expect(
      CreateContractorRequestSchema.parse({ ...valid, commercialRegister: '12345', taxCard: null }),
    ).toMatchObject({ commercialRegister: '12345', taxCard: null });
  });

  it('accepts Arabic-Indic digits in the phone and refuses letters', () => {
    expect(
      CreateContractorRequestSchema.safeParse({ ...valid, contactPhone: '٠١٠٠١٢٣٤٥٦٧' }).success,
    ).toBe(true);
    expect(
      CreateContractorRequestSchema.safeParse({ ...valid, contactPhone: 'call me' }).success,
    ).toBe(false);
  });

  it('refuses an update with nothing to change', () => {
    expect(UpdateContractorRequestSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(
      UpdateContractorRequestSchema.safeParse({ expectedVersion: 1, taxCard: '9' }).success,
    ).toBe(true);
  });
});

describe('registering a contractor on a work order', () => {
  const line = { workOrderItemId: ITEM_A, quantity: '100', unitPrice: '70.5' };

  it('needs a date and at least one line', () => {
    const ok = { contractorId: CONTRACTOR, registeredOn: '2026-11-07', lines: [line] };
    expect(RegisterContractorRequestSchema.safeParse(ok).success).toBe(true);
    expect(RegisterContractorRequestSchema.safeParse({ ...ok, lines: [] }).success).toBe(false);
    expect(
      RegisterContractorRequestSchema.safeParse({ ...ok, registeredOn: undefined }).success,
    ).toBe(false);
  });

  it('refuses the same work-order line twice', () => {
    const body = {
      contractorId: CONTRACTOR,
      registeredOn: '2026-11-07',
      lines: [line, { ...line, quantity: '5' }],
    };
    expect(RegisterContractorRequestSchema.safeParse(body).success).toBe(false);
    body.lines[1] = { ...line, workOrderItemId: ITEM_B };
    expect(RegisterContractorRequestSchema.safeParse(body).success).toBe(true);
  });

  it('needs a quantity above 0', () => {
    for (const quantity of ['0', '0.0000']) {
      expect(UpdateContractorLineRequestSchema.safeParse({ quantity }).success).toBe(false);
    }
    expect(UpdateContractorLineRequestSchema.safeParse({ quantity: '0.0001' }).success).toBe(true);
  });

  it('takes a dated new price', () => {
    expect(
      AddContractorPriceRequestSchema.safeParse({ effectiveFrom: '2026-12-01', unitPrice: '75' })
        .success,
    ).toBe(true);
    expect(AddContractorPriceRequestSchema.safeParse({ unitPrice: '75' }).success).toBe(false);
  });
});

describe('contractors:read', () => {
  it('is for admin and pm only (owner 2026-11-07)', () => {
    expect(hasPermission(['admin'], 'contractors:read')).toBe(true);
    expect(hasPermission(['pm'], 'contractors:read')).toBe(true);
    for (const role of ['qc', 'supervisor', 'contractor'] as const) {
      expect(hasPermission([role], 'contractors:read')).toBe(false);
    }
  });
});
