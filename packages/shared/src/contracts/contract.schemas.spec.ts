import { describe, expect, it } from 'vitest';
import {
  AddContractItemRequestSchema,
  ApproveContractRequestSchema,
  ContractImportCommitPayloadSchema,
  ContractItemInputSchema,
  CreateContractRequestSchema,
  UpdateContractRequestSchema,
  parentCodeOf,
} from './contract.schemas.js';

const SHA = 'a'.repeat(64);

describe('parentCodeOf', () => {
  const codes = new Set(['1', '1-1', '1-1-1', '2', '2-9', '2-9-1', '2-9-1-1', '2-7']);

  it('finds the nearest existing ancestor', () => {
    expect(parentCodeOf('1-1-1', codes)).toBe('1-1');
    // A priced item under a priced item (sample BOQ, owner 2026-10-31).
    expect(parentCodeOf('2-9-1-1', codes)).toBe('2-9-1');
  });

  it('skips missing levels and returns null at the top', () => {
    // 2-7-4 exists in the sample while 2-7-4's parent 2-7 does; 1-4-2 has no 1-4.
    expect(parentCodeOf('2-7-5-1', codes)).toBe('2-7');
    expect(parentCodeOf('1-4-2', codes)).toBe('1');
    expect(parentCodeOf('1', codes)).toBeNull();
    expect(parentCodeOf('9-9', codes)).toBeNull();
  });
});

describe('CreateContractRequestSchema', () => {
  const valid = { number: ' 232-2022 ', name: 'FTTH', client: 'WE', currency: 'EGP' };

  it('accepts the required fields and trims text', () => {
    expect(CreateContractRequestSchema.parse(valid)).toMatchObject({ number: '232-2022' });
  });

  it('rejects a lower-case currency, a zero duration and unknown fields', () => {
    expect(CreateContractRequestSchema.safeParse({ ...valid, currency: 'egp' }).success).toBe(
      false,
    );
    expect(CreateContractRequestSchema.safeParse({ ...valid, durationDays: 0 }).success).toBe(
      false,
    );
    expect(CreateContractRequestSchema.safeParse({ ...valid, status: 'approved' }).success).toBe(
      false,
    );
  });
});

describe('UpdateContractRequestSchema', () => {
  it('never changes the currency and needs a field', () => {
    expect(
      UpdateContractRequestSchema.safeParse({ expectedVersion: 1, currency: 'USD' }).success,
    ).toBe(false);
    expect(UpdateContractRequestSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(UpdateContractRequestSchema.parse({ expectedVersion: 2, name: 'X' })).toMatchObject({
      name: 'X',
    });
  });
});

describe('ContractItemInputSchema', () => {
  const item = {
    kind: 'item',
    code: '1-1-1-1',
    description: 'غرفة DH',
    unit: 'عدد',
    quantity: '150',
    unitPrice: '8000',
    workType: 'civil',
  };

  it('accepts a priced item with quantity 0 and 6 price decimals', () => {
    expect(ContractItemInputSchema.safeParse({ ...item, quantity: '0' }).success).toBe(true);
    expect(ContractItemInputSchema.safeParse({ ...item, unitPrice: '5.599360' }).success).toBe(
      true,
    );
    expect(ContractItemInputSchema.safeParse({ ...item, unitPrice: '5.5993601' }).success).toBe(
      false,
    );
  });

  it('requires every item field, including the work type', () => {
    expect(ContractItemInputSchema.safeParse({ ...item, workType: undefined }).success).toBe(false);
  });

  it('accepts a heading with only a code, and refuses priced fields on a heading', () => {
    expect(ContractItemInputSchema.safeParse({ kind: 'heading', code: '2-12' }).success).toBe(true);
    expect(
      ContractItemInputSchema.safeParse({ kind: 'heading', code: '1', unit: 'عدد' }).success,
    ).toBe(false);
  });
});

describe('requests that change the BOQ carry the version', () => {
  it('needs expectedVersion', () => {
    expect(
      AddContractItemRequestSchema.safeParse({ item: { kind: 'heading', code: '1' } }).success,
    ).toBe(false);
    expect(ApproveContractRequestSchema.safeParse({}).success).toBe(false);
    expect(
      ContractImportCommitPayloadSchema.safeParse({
        fileSha256: SHA,
        sheetName: 'S',
        headerRow: 1,
        mapping: { code: 0, description: 2, unit: 3, quantity: 4, unitPrice: 5, workType: 1 },
      }).success,
    ).toBe(false);
  });
});
