import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { contractDetail, heading, pricedItem } from '@/test-utils/contract';
import {
  groupSuggestions,
  ungroupedCodesOf,
  validateGroupForm,
  EMPTY_CONTRACT_FORM,
  EMPTY_LINE_FORM,
  boqDepths,
  contractErrorKey,
  contractToForm,
  validateCreateContract,
  validateLineForm,
  validateUpdateContract,
} from './contract-forms';

const header = {
  ...EMPTY_CONTRACT_FORM,
  number: ' C-1 ',
  name: 'Name',
  client: 'Client',
  currency: 'egp',
};

describe('validateCreateContract', () => {
  it('trims, upper-cases the currency and turns empty optional fields into null', () => {
    expect(validateCreateContract(header)).toEqual({
      ok: true,
      payload: {
        number: 'C-1',
        name: 'Name',
        client: 'Client',
        currency: 'EGP',
        startsOn: null,
        durationDays: null,
        notes: null,
      },
    });
  });

  it('flags missing required fields, a bad currency and a non-numeric duration', () => {
    const result = validateCreateContract({
      ...EMPTY_CONTRACT_FORM,
      currency: 'E',
      durationDays: '1.5',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        number: 'validation.required',
        name: 'validation.required',
        client: 'validation.required',
        currency: 'admin.validation.currency',
        durationDays: 'admin.contracts.validation.duration',
      },
    });
  });
});

describe('validateUpdateContract', () => {
  it('never sends the currency and can clear optional fields', () => {
    const result = validateUpdateContract(contractToForm(contractDetail({ startsOn: null })));
    expect(result.ok && result.payload).toMatchObject({ startsOn: null, number: 'C-2026-01' });
    expect(result.ok && 'currency' in result.payload).toBe(false);
  });
});

describe('validateLineForm', () => {
  it('a heading needs only a code; the title is optional', () => {
    expect(validateLineForm({ ...EMPTY_LINE_FORM, kind: 'heading', code: ' 2-1 ' })).toEqual({
      ok: true,
      data: { kind: 'heading', code: '2-1', description: null },
    });
    expect(validateLineForm({ ...EMPTY_LINE_FORM, kind: 'heading', code: '' })).toEqual({
      ok: false,
      errors: { code: 'validation.required' },
    });
    expect(
      validateLineForm({ ...EMPTY_LINE_FORM, kind: 'heading', code: '1', description: 'Civil' }),
    ).toEqual({ ok: true, data: { kind: 'heading', code: '1', description: 'Civil' } });
  });

  it('an item has the work-order item rules; zero quantity and price are accepted', () => {
    const base = {
      ...EMPTY_LINE_FORM,
      code: 'A',
      description: 'd',
      unit: 'm',
      quantity: '0',
      unitPrice: '0',
      workType: 'civil',
    };
    expect(validateLineForm(base)).toEqual({
      ok: true,
      data: {
        kind: 'item',
        code: 'A',
        description: 'd',
        unit: 'm',
        quantity: '0',
        unitPrice: '0',
        workType: 'civil',
      },
    });
    const bad = validateLineForm({ ...base, unit: '', workType: '' });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors).toMatchObject({
      unit: 'validation.required',
      workType: 'validation.required',
    });
  });
});

describe('boqDepths', () => {
  it('indents by the parent chain', () => {
    const items = [heading(1, '1', 'A'), pricedItem(2, '1-1', { parentCode: '1' })];
    const child = pricedItem(3, '1-1-1', { parentCode: '1-1' });
    const depths = boqDepths([...items, child]);
    expect([...depths.values()]).toEqual([0, 1, 2]);
  });
});

describe('contractErrorKey', () => {
  it('maps every 409 reason to its own message', () => {
    const reasons = [
      'STALE_VERSION',
      'CONTRACT_APPROVED',
      'DUPLICATE_CODE',
      'LINE_TAKEN',
      'DUPLICATE_NUMBER',
      'NO_PRICED_ITEMS',
    ];
    for (const reason of reasons) {
      expect(contractErrorKey(new ApiClientError('CONFLICT', 409, { reason }))).toBe(
        `admin.contracts.reasons.${reason}`,
      );
    }
  });

  it('maps the ungrouped conflict and reads its codes', () => {
    const error = new ApiClientError('CONFLICT', 409, {
      reason: 'CONTRACT_ITEMS_UNGROUPED',
      codes: ['1-1', '2-3'],
    });
    expect(contractErrorKey(error)).toBe('admin.contracts.reasons.CONTRACT_ITEMS_UNGROUPED');
    expect(ungroupedCodesOf(error)).toEqual(['1-1', '2-3']);
    expect(ungroupedCodesOf(new ApiClientError('CONFLICT', 409, { reason: 'X' }))).toEqual([]);
  });

  it('validates the group form: trims, needs a main group, caps the length', () => {
    expect(validateGroupForm({ main: '  Bundles ', sub: ' ' })).toEqual({
      ok: true,
      main: 'Bundles',
      sub: null,
    });
    expect(validateGroupForm({ main: ' ', sub: 'x' })).toEqual({
      ok: false,
      errors: { main: 'validation.required' },
    });
    expect(validateGroupForm({ main: 'a'.repeat(81), sub: 'b'.repeat(81) })).toEqual({
      ok: false,
      errors: { main: 'validation.tooLong', sub: 'validation.tooLong' },
    });
  });

  it('suggests each group name used in the contract once', () => {
    const items = [pricedItem(1, 'A'), pricedItem(2, 'B'), heading(3, 'H', null)];
    expect(groupSuggestions(items)).toEqual({ mains: ['Bundles'], subs: ['12 tubes'] });
  });

  it('falls back to the error code', () => {
    expect(contractErrorKey(new ApiClientError('NOT_FOUND', 404))).toBe('errors.NOT_FOUND');
    expect(contractErrorKey(new ApiClientError('CONFLICT', 409, { reason: 'OTHER' }))).toBe(
      'errors.CONFLICT',
    );
  });
});
