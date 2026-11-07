import { describe, expect, it } from 'vitest';
import { hasPermission } from '../auth/permissions.js';
import { ColumnMappingSchema } from '../work-orders/work-order-import.schemas.js';
import {
  AddContractorPriceRequestSchema,
  ContractorImportCommitPayloadSchema,
  ContractorImportPreviewOptionsSchema,
  CreateContractorRequestSchema,
  scopeKeyOf,
  UpdateContractorLineRequestSchema,
  UpdateContractorRequestSchema,
} from './contractor.schemas.js';

const CONTRACTOR = '33333333-3333-4333-8333-333333333333';
const REGISTRATION = '44444444-4444-4444-8444-444444444444';
const SHA = 'a'.repeat(64);

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

describe('scope of work', () => {
  it('compares scopes after normalising spaces, case and Arabic letter forms', () => {
    expect(scopeKeyOf('  لحام  البوكس ')).toBe(scopeKeyOf('لحام البوكس'));
    expect(scopeKeyOf('تركيب الخوصة')).toBe(scopeKeyOf('تركيب الخوصه'));
    expect(scopeKeyOf('Splice Box')).toBe(scopeKeyOf('splice  box'));
    expect(scopeKeyOf('تركيب البوكس')).not.toBe(scopeKeyOf('لحام البوكس'));
  });

  it('treats an empty scope as the whole line', () => {
    expect(scopeKeyOf(null)).toBeNull();
    expect(scopeKeyOf('   ')).toBeNull();
  });

  it('keeps the work-order and contract mappings valid without a scope column', () => {
    const mapping = ColumnMappingSchema.parse({
      code: 0,
      description: 1,
      unit: 2,
      quantity: 3,
      unitPrice: 4,
      workType: 5,
      amount: null,
    });
    expect(mapping.scope).toBeNull();
  });
});

describe('contractor sheet upload', () => {
  const mapping = { code: 0, description: 1, unit: 2, scope: 3, quantity: 4, unitPrice: 5 };

  it('previews for a new registration or for appending', () => {
    expect(
      ContractorImportPreviewOptionsSchema.safeParse({
        target: { kind: 'new', contractorId: CONTRACTOR, registeredOn: '2026-11-07' },
      }).success,
    ).toBe(true);
    expect(
      ContractorImportPreviewOptionsSchema.safeParse({
        target: { kind: 'append', registrationId: REGISTRATION },
      }).success,
    ).toBe(true);
    expect(
      ContractorImportPreviewOptionsSchema.safeParse({
        target: { kind: 'new', contractorId: CONTRACTOR },
      }).success,
    ).toBe(false);
  });

  it('needs code, description, unit, quantity and price columns; scope and work type are optional', () => {
    const base = {
      fileSha256: SHA,
      sheetName: 'Sheet1',
      headerRow: 1,
      target: { kind: 'append', registrationId: REGISTRATION },
    };
    const parsed = ContractorImportCommitPayloadSchema.parse({ ...base, mapping });
    expect(parsed.mapping).toMatchObject({ scope: 3, workType: null, amount: null });
    const { unitPrice: _price, ...withoutPrice } = mapping;
    expect(
      ContractorImportCommitPayloadSchema.safeParse({ ...base, mapping: withoutPrice }).success,
    ).toBe(false);
    expect(
      ContractorImportCommitPayloadSchema.safeParse({ ...base, mapping: { ...mapping, scope: 0 } })
        .success,
    ).toBe(false);
  });
});

describe('single-field edits', () => {
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
